#!/usr/bin/env bun
// conso: the consumption bench of tests/parity/conso.yaml (BILLABLE: claude -p
// runs and Hindsight extraction). It answers "what does the lead cost compared
// with plain Claude", all costs included:
//   A  plain claude (the operator's normal settings, no orch lead agent)
//   B  lead without Hindsight: lead prompt and hooks, ORCH_MEMORY=off
//   C  lead + Hindsight: lead prompt, hooks, a run-owned bank seeded from the
//      supplied frozen brain snapshot, recall per prompt and retain per turn
//   D  lead + brain snapshot: lead prompt and hooks, frozen recall only
// Each session of the YAML is one Claude Code conversation (--session-id, then
// --resume) played in a throwaway worktree per configuration at a pinned ref. Claude Code
// reports tokens and its dollar estimate per prompt; Hindsight's own model
// calls are read from the exact run bank before and after its queue drains.
// Every run has a UUID output, isolated state, session IDs and run-owned CLI
// shims. C and D require --brain-snapshot. Output lands under <state>/bench/conso/<uuid>/.
//
//   bun src/checks/conso.ts [--config A,B,C,D] [--session id] [--repeat 1] [--jobs 3]
//     [--brain-snapshot file] [--ref commit] [--no-seed] [--dry-run]
//   bun src/checks/conso.ts --live     Hindsight's real usage over 7 days, per bank (no model call)
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { stateDir } from "../core/paths.ts";
import { which } from "../core/which.ts";
import { sandboxSummary } from "../mem/sandbox.ts";
import { ROOT } from "../core/profile.ts";
import { projectKey } from "../core/project.ts";
import { deleteBank, ensureBank, loadHindsightConfig, type HindsightConfig } from "../memory/hindsight.ts";
import { seedHindsight } from "../memory/seed.ts";
import { validateSnapshot } from "../memory/brain-recall.ts";
import { snapshotMem } from "../memory/snapshot-mem.ts";
import { allocateRun, type BenchRun } from "../bench/index.ts";
import { claudeEnv as benchClaudeEnv } from "../bench/claude-env.ts";
import { captureProcess } from "../bench/process.ts";
import { pool } from "../core/pool.ts";
import { requireAllowPaid } from "../core/paid.ts";
import { HOOK_ENTRY } from "../install/render.ts";

export type Config = "A" | "B" | "C" | "D";
export interface Turn {
  config: Config; session: string; rep: number; index: number; prompt: string; exit: number; error?: string;
  duration_ms: number; num_turns: number; cost_usd: number;
  input_tokens: number; cache_write: number; cache_read: number; output_tokens: number;
  model_ids?: string[];
}
export interface HindsightUsage { llm_calls: number; llm_input: number; llm_cached: number; llm_output: number; embed_calls: number; embed_tokens: number }
interface Bucket { time: string; total: number; tokens: { input: number; output: number; cached: number } }

// $ per million tokens. Haiku 5.5: claude-api skill model table (cached
// 2026-10-06), cache read at 0.1x input. text-embedding-3-small: OpenAI
// embeddings guide, 62,500 pages of ~800 tokens per dollar. Hindsight's
// `cached` is read as a subset of `input` (its `total` is input + output).
export const PRICES = { llm: { input: 0.10, cached: 0.01, output: 0.50 }, embedding: 0.02 };
export const PRICES_VERSION = "orch-conso-prices-2026-10-06-v1";
// How B/C/D start the lead, in both benches' protocol: native Kiba
// (--agent kiba, catalog/kiba-native.md). Runs of the retired conductor
// (kiba-conductor-v1) are never comparable.
export const LEAD_LAUNCH = "kiba-native-v1";
const CONFIGS: Config[] = ["A", "B", "C", "D"];
const MODEL = "opus";
const EFFORT = "high";
const RUN_TIMEOUT_MS = 600_000;

export function positiveInteger(name: string, raw: string | number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseClaudeResult(stdout: string, stderr: string, exit: number): { json: Record<string, unknown> | null; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { json: null, error: `no JSON (exit ${exit}): ${(stderr || stdout).slice(0, 300).replace(/\s+/g, " ")}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { json: null, error: `invalid Claude JSON object (exit ${exit})` };
  const json = parsed as Record<string, unknown>;
  if (exit !== 0) return { json, error: `claude exited ${exit}: ${String(json.result ?? stderr ?? "").slice(0, 300).replace(/\s+/g, " ")}` };
  if (json.is_error) return { json, error: String(json.result ?? "is_error").slice(0, 300) || "is_error" };
  if (typeof json.result !== "string") return { json, error: "claude JSON has no result string" };
  return { json };
}

export function usageFromBuckets(llm: Bucket[], embedding: Bucket[]): HindsightUsage {
  for (const bucket of [...llm, ...embedding]) validateBucket(bucket);
  const sum = (bs: Bucket[], f: (b: Bucket) => number) => bs.reduce((n, b) => n + f(b), 0);
  return {
    llm_calls: sum(llm, (b) => b.total), llm_input: sum(llm, (b) => b.tokens.input), llm_cached: sum(llm, (b) => b.tokens.cached), llm_output: sum(llm, (b) => b.tokens.output),
    embed_calls: sum(embedding, (b) => b.total), embed_tokens: sum(embedding, (b) => b.tokens.input + b.tokens.output),
  };
}

export function diffUsage(after: HindsightUsage, before: HindsightUsage): HindsightUsage {
  const out = { ...after };
  for (const k of Object.keys(out) as (keyof HindsightUsage)[]) {
    const delta = after[k] - before[k];
    if (delta < 0) throw new Error("Hindsight " + k + " counter moved backwards; cost window is incomplete");
    out[k] = delta;
  }
  return out;
}

export function addUsage(a: HindsightUsage, b: HindsightUsage): HindsightUsage {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof HindsightUsage)[]) out[k] = a[k] + b[k];
  return out;
}

export function hindsightCost(u: HindsightUsage): number {
  const fresh = Math.max(0, u.llm_input - u.llm_cached);
  return (fresh * PRICES.llm.input + u.llm_cached * PRICES.llm.cached + u.llm_output * PRICES.llm.output + u.embed_tokens * PRICES.embedding) / 1e6;
}

export interface Row { config: Config; sessions: number; prompts: number; attempted_prompts: number; seconds: number; input: number; cache_write: number; cache_read: number; output: number; attempted_claude_usd: number; claude_usd: number; hindsight_usd: number; total_usd: number; attempted_total_usd: number }

export function summarize(turns: Turn[], hindsight: Partial<Record<Config, HindsightUsage>>): Row[] {
  const configs = CONFIGS.filter((c) => turns.some((t) => t.config === c));
  return configs.map((config) => {
    const attempted = turns.filter((t) => t.config === config);
    const ts = attempted.filter((t) => !t.error);
    const sum = (source: Turn[], f: (t: Turn) => number) => source.reduce((n, t) => n + f(t), 0);
    const h = hindsight[config];
    const attemptedClaude = sum(attempted, (t) => t.cost_usd);
    const claude = sum(ts, (t) => t.cost_usd);
    const hs = h ? hindsightCost(h) : 0;
    return {
      config, sessions: new Set(ts.map((t) => `${t.session}#${t.rep}`)).size, prompts: ts.length, attempted_prompts: attempted.length, seconds: sum(ts, (t) => t.duration_ms) / 1000,
      input: sum(ts, (t) => t.input_tokens), cache_write: sum(ts, (t) => t.cache_write), cache_read: sum(ts, (t) => t.cache_read), output: sum(ts, (t) => t.output_tokens),
      attempted_claude_usd: attemptedClaude, claude_usd: claude, hindsight_usd: hs, total_usd: claude + hs, attempted_total_usd: attemptedClaude + hs,
    };
  });
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const usd = (n: number) => n.toFixed(n < 1 ? 3 : 2);

export function renderReport(turns: Turn[], hindsight: Partial<Record<Config, HindsightUsage>>, extra: Record<string, string>): string {
  const rows = summarize(turns, hindsight);
  const lines = ["# Banc conso", "", "Par configuration (tokens Claude Code cumulés, $ estimés) :", "", "```text",
    "config  ok/try  s/prompt  input  cache-w  cache-r  output  tried$  ok$  hindsight est$  known subtotal$  known$/attempt  total vs A",
  ];
  for (const r of rows) {
    const per = r.attempted_total_usd / Math.max(1, r.attempted_prompts);
    // Unmetered brain embeddings prevent a total-cost comparison.
    const vs = r.config === "A" ? "-" : "n/a";
    lines.push([r.config.padEnd(6), `${r.prompts}/${r.attempted_prompts}`.padStart(7), (r.seconds / Math.max(1, r.prompts)).toFixed(0).padStart(9), k(r.input).padStart(6), k(r.cache_write).padStart(8), k(r.cache_read).padStart(8), k(r.output).padStart(7), usd(r.attempted_claude_usd).padStart(7), usd(r.claude_usd).padStart(6), usd(r.hindsight_usd).padStart(14), usd(r.attempted_total_usd).padStart(15), usd(per).padStart(10), vs.padStart(5)].join(" "));
  }
  lines.push("```", "", "Coût Claude moyen par rang de prompt dans la session (montre l'accumulation) :", "", "```text");
  const maxIndex = Math.max(0, ...turns.map((t) => t.index));
  lines.push(`rang  ${rows.map((r) => r.config.padStart(7)).join(" ")}`);
  for (let i = 0; i <= maxIndex; i++) {
    const cells = rows.map((r) => {
      const ts = turns.filter((t) => t.config === r.config && t.index === i && !t.error);
      return ts.length ? usd(ts.reduce((n, t) => n + t.cost_usd, 0) / ts.length).padStart(7) : "      -";
    });
    lines.push(`${String(i + 1).padStart(4)}  ${cells.join(" ")}`);
  }
  lines.push("```", "");
  for (const [config, h] of Object.entries(hindsight)) if (h) lines.push(`Hindsight (${config}) : ${h.llm_calls} appels LLM (${k(h.llm_input)} in dont ${k(h.llm_cached)} en cache, ${k(h.llm_output)} out), ${h.embed_calls} embeddings (${k(h.embed_tokens)} tokens), ${usd(hindsightCost(h))} $.`);
  const errors = turns.filter((t) => t.error);
  if (errors.length) lines.push(`Erreurs : ${errors.length} prompt(s) exclus (${errors.map((t) => `${t.config}/${t.session}#${t.index + 1}`).join(", ")}).`);
  for (const [key, value] of Object.entries(extra)) lines.push(`- ${key} : ${value}`);
  lines.push("", "Le $ Claude est l'estimation de Claude Code. Le $ Hindsight est une estimation calculée avec " + PRICES_VERSION + " à partir des tokens remontés par le serveur, pas une facture. Les coûts tentés incluent les échecs dont le coût a été rapporté; les coûts réussis excluent les prompts en erreur. Les sous-totaux excluent les embeddings brain non instrumentés; aucune comparaison de coût total ne peut en être déduite.", "");
  return lines.join("\n");
}

// The bench's brain.yaml: the catalog's, on the bench banks, with the
// hindsight settings under test (`--hindsight retain=false,recall_max_tokens=600`).
export function benchBrainYaml(catalog: string, bank: string, overrides = ""): string {
  const doc = parse(catalog) as { hindsight?: Record<string, unknown> };
  doc.hindsight = { ...(doc.hindsight ?? {}), bank };
  const allowed = new Set(["retain", "facts_only", "recall_max_tokens", "session_recall_tokens", "recall_min_semantic", "recall_budget", "timeout_ms"]);
  const seen = new Set<string>();
  for (const pair of overrides.split(",").map((x) => x.trim()).filter(Boolean)) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error(`invalid Hindsight override ${pair}; expected key=value`);
    const key = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();
    if (!allowed.has(key)) throw new Error(`unsupported Hindsight override ${key}; bank and URL are runner-owned`);
    if (seen.has(key)) throw new Error(`duplicate Hindsight override ${key}`);
    seen.add(key);
    const value = raw === "true" ? true : raw === "false" ? false : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    if (["retain", "facts_only"].includes(key) && typeof value !== "boolean") throw new Error(`${key} must be true or false`);
    if (key === "recall_budget" && !["low", "mid", "high"].includes(String(value))) throw new Error("recall_budget must be low, mid, or high");
    if (["recall_max_tokens", "session_recall_tokens", "timeout_ms"].includes(key) && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "session_recall_tokens" ? 0 : 1) || value > 60_000)) throw new Error(`${key} must be an integer in its supported range`);
    if (key === "recall_min_semantic" && (typeof value !== "number" || value < 0 || value > 1)) throw new Error("recall_min_semantic must be between 0 and 1");
    doc.hindsight[key] = value;
  }
  return stringify(doc);
}

export function hindsightRetainOverride(overrides: string, retain: boolean): string {
  const pairs = overrides.split(",").map((value) => value.trim()).filter(Boolean);
  const existing = pairs.find((value) => value.startsWith("retain="));
  if (existing && existing.slice("retain=".length) !== String(retain)) throw new Error("retain must be " + retain + " for this bench configuration");
  return pairs.filter((value) => !value.startsWith("retain=")).concat("retain=" + retain).join(",");
}

// ---------------------------------------------------------------- Hindsight
async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const value: unknown = await res.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${url}: expected a JSON object`);
  return value as Record<string, unknown>;
}

function validateBucket(value: unknown): asserts value is Bucket {
  const bucket = value as Bucket | null;
  const tokens = bucket?.tokens;
  if (!bucket || typeof bucket.time !== "string" || !Number.isSafeInteger(bucket.total) || bucket.total < 0
    || !tokens || ![tokens.input, tokens.output, tokens.cached].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
    throw new Error("Hindsight stats returned an invalid bucket");
  }
}

function bucketsFrom(payload: Record<string, unknown>): Bucket[] {
  if (!Array.isArray(payload.buckets)) throw new Error("Hindsight stats response is missing buckets[]");
  for (const bucket of payload.buckets) validateBucket(bucket);
  return payload.buckets as Bucket[];
}

function operationTotal(payload: Record<string, unknown>): number {
  if (!Number.isSafeInteger(payload.total) || Number(payload.total) < 0) throw new Error("Hindsight operations response has an invalid total");
  return Number(payload.total);
}

async function banks(base: string): Promise<string[]> {
  const j = await getJson(`${base}/v1/default/banks?limit=200`);
  return ((j.banks ?? []) as { bank_id?: string; id?: string }[]).map((b) => String(b.bank_id ?? b.id));
}

async function bankUsage(base: string, bank: string, period = "7d"): Promise<{ usage: HindsightUsage; days: Record<string, HindsightUsage> }> {
  const get = async (type: string) => bucketsFrom(await getJson(`${base}/v1/default/banks/${encodeURIComponent(bank)}/llm-requests/stats?call_type=${type}&period=${period}`));
  const [llm, embedding] = await Promise.all([get("llm"), get("embedding")]);
  const days: Record<string, HindsightUsage> = {};
  for (const day of new Set([...llm, ...embedding].map((b) => b.time.slice(0, 10)))) days[day] = usageFromBuckets(llm.filter((b) => b.time.startsWith(day)), embedding.filter((b) => b.time.startsWith(day)));
  return { usage: usageFromBuckets(llm, embedding), days };
}

export async function exactBankUsage(base: string, bank: string): Promise<HindsightUsage> {
  return (await bankUsage(base, bank)).usage;
}

export async function exactOwnedBankUsage(base: string, ownedBanks: string[]): Promise<HindsightUsage> {
  let total = usageFromBuckets([], []);
  for (const bank of [...new Set(ownedBanks)]) total = addUsage(total, await exactBankUsage(base, bank));
  return total;
}

// Retains are asynchronous: wait for every bench bank's queue to drain.
export async function drainBank(base: string, bank: string, timeoutMs = 900_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    let busy = 0;
    for (const status of ["pending", "processing"]) busy += operationTotal(await getJson(`${base}/v1/default/banks/${encodeURIComponent(bank)}/operations?status=${status}&limit=1`));
    if (!busy || Date.now() - t0 > timeoutMs) return busy;
    await Bun.sleep(5_000);
  }
}

// A run's banks are only its cost meter: once usage is read they are dropped,
// so no bench-<run>-* bank outlives its run in the production Hindsight.
export async function dropOwnedBanks(config: HindsightConfig, ownedBanks: string[]): Promise<string> {
  const failed: string[] = [];
  for (const bank of [...new Set(ownedBanks)]) {
    const result = await deleteBank(config, bank);
    if (!result.ok) failed.push(bank + " (" + result.error + ")");
  }
  return failed.length ? "échec: " + failed.join(", ") : "oui (" + new Set(ownedBanks).size + ")";
}

export async function drainOwnedBanks(base: string, ownedBanks: string[], timeoutMs = 900_000): Promise<number> {
  const banks = [...new Set(ownedBanks)];
  const t0 = Date.now();
  for (;;) {
    let busy = 0;
    for (const bank of banks) for (const status of ["pending", "processing"]) {
      busy += operationTotal(await getJson(`${base}/v1/default/banks/${encodeURIComponent(bank)}/operations?status=${status}&limit=1`));
    }
    if (!busy || Date.now() - t0 > timeoutMs) return busy;
    await Bun.sleep(5_000);
  }
}

// ---------------------------------------------------------------- claude runs
interface Ctx { run: BenchRun; out: string; cwds: Record<Config, string>; stateDirs: Record<Config, string>; binPaths: Partial<Record<Config, string>>; banks: Partial<Record<Config, string>>; benchBrains: Partial<Record<Config, string>>; leadSettings: Partial<Record<Config, string>>; leadDenied?: Partial<Record<Config, string[]>>; llmConfig: string; claudeExecutable: string; brainSnapshot?: string; brainProject?: string; sourceRevision: string }

export function claudeEnv(config: Config, session: string, ctx: Ctx, sandboxId = session): Record<string, string> {
  return benchClaudeEnv(config, session, ctx, sandboxId);
}

export async function runPrompt(config: Config, session: string, rep: number, index: number, prompt: string, claudeId: string, ctx: Ctx): Promise<Turn> {
  const argv = [ctx.claudeExecutable, "-p", prompt, "--output-format", "json", "--model", MODEL, "--effort", EFFORT, "--permission-mode", "bypassPermissions", index === 0 ? "--session-id" : "--resume", claudeId];
  if (config !== "A") {
    const kiba = benchKibaFlags(ctx.cwds[config], ctx.leadDenied?.[config]);
    argv.push("--settings", ctx.leadSettings[config]!, ...kiba.prompt, ...kiba.tools);
  }
  const t0 = Date.now();
  const captured = await captureProcess(argv, { cwd: ctx.cwds[config], env: claudeEnv(config, claudeId, ctx, session + "-" + rep), timeoutMs: RUN_TIMEOUT_MS });
  const { stdout, stderr, exit } = captured;
  const turn: Turn = { config, session, rep, index, prompt, exit, duration_ms: Date.now() - t0, num_turns: 0, cost_usd: 0, input_tokens: 0, cache_write: 0, cache_read: 0, output_tokens: 0 };
  const parsed = parseClaudeResult(stdout, stderr, exit);
  try {
    if (!parsed.json) throw new Error(parsed.error);
    const j = parsed.json;
    const u = (j.usage ?? {}) as Record<string, number>;
    const modelUsage = (j.modelUsage ?? {}) as Record<string, unknown>;
    turn.model_ids = [...new Set([...(typeof j.model === "string" ? [j.model] : []), ...Object.keys(modelUsage)])].sort();
    Object.assign(turn, { num_turns: Number(j.num_turns ?? 0), cost_usd: Number(j.total_cost_usd ?? 0), input_tokens: Number(u.input_tokens ?? 0), cache_write: Number(u.cache_creation_input_tokens ?? 0), cache_read: Number(u.cache_read_input_tokens ?? 0), output_tokens: Number(u.output_tokens ?? 0) });
  } catch (error) { turn.error = parsed.error ?? (error instanceof Error ? error.message : String(error)); }
  if (parsed.error) turn.error = parsed.error;
  if (captured.timedOut) turn.error = `claude timed out after ${RUN_TIMEOUT_MS} ms`;
  appendFileSync(join(ctx.out, "runs.jsonl"), `${JSON.stringify(turn)}\n`);
  log(`${config} ${session}#${rep} ${index + 1}: ${turn.error ? `ERROR ${turn.error.slice(0, 80)}` : `${turn.num_turns} turns, ${Math.round(turn.duration_ms / 1000)} s, $${turn.cost_usd.toFixed(3)}`}`);
  return turn;
}

// ---------------------------------------------------------------- main

function log(msg: string): void { process.stderr.write(`[conso] ${msg}\n`); }

async function live(base: string): Promise<void> {
  const lines = ["# Hindsight, usage réel sur 7 jours (sans appel modèle)", "", "```text", "bank                     jour        appels LLM   in      out     embeddings  $"];
  let total = 0;
  for (const bank of await banks(base)) {
    const { days } = await bankUsage(base, bank);
    for (const [day, u] of Object.entries(days).sort()) {
      total += hindsightCost(u);
      lines.push(`${bank.padEnd(24)} ${day}  ${String(u.llm_calls).padStart(10)}  ${k(u.llm_input).padStart(6)}  ${k(u.llm_output).padStart(6)}  ${k(u.embed_tokens).padStart(10)}  ${usd(hindsightCost(u))}`);
    }
  }
  lines.push("```", "", `Total 7 jours : ${usd(total)} $ (seed et bancs compris).`, "");
  process.stdout.write(lines.join("\n"));
}

function gitText(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (result.exitCode !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

export function workspaceDirtyHash(): string | null {
  const status = gitText(["status", "--porcelain", "--untracked-files=all"]);
  if (!status) return null;
  const hash = createHash("sha256").update(gitText(["diff", "--binary", "HEAD", "--"]));
  for (const line of status.split("\n")) {
    const file = line.slice(3).split(" -> ").at(-1)!;
    if (existsSync(join(ROOT, file))) hash.update(file).update(readFileSync(join(ROOT, file)));
  }
  return hash.digest("hex");
}

export function resolveSource(ref?: string): { ref: string; revision: string; dirtyHash: string | null } {
  const requested = ref ?? "HEAD";
  const revision = gitText(["rev-parse", "--verify", requested + "^{commit}"]);
  return { ref: requested, revision, dirtyHash: workspaceDirtyHash() };
}

export function sourceFile(revision: string, path: string): string {
  const result = Bun.spawnSync(["git", "show", revision + ":" + path], { cwd: ROOT });
  if (result.exitCode !== 0) throw new Error("source snapshot " + revision + " is missing " + path);
  return result.stdout.toString();
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

// Benchmarks run the lead hooks from the source checkout, never the installed
// symlink: the hook entry (HOOK_ENTRY, src/hooks/hook.ts) becomes
// hookEntrypoint, the orch CLI of the other commands (kiba wait, status line)
// becomes entrypoint.
export function sourceHookSettings(content: string, entrypoint: string, hookEntrypoint = entrypoint): string {
  const settings = JSON.parse(content) as { disableClaudeAiConnectors?: boolean; statusLine?: { type?: string; command?: string }; hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>> };
  settings.disableClaudeAiConnectors = true;
  if (settings.statusLine?.command?.includes('"$HOME/.local/bin/orch"')) {
    settings.statusLine.command = settings.statusLine.command.replaceAll('"$HOME/.local/bin/orch"', entrypoint);
  }
  let rewritten = 0;
  for (const groups of Object.values(settings.hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) {
    if (hook.type !== "command" || !hook.command?.includes('"$HOME/.local/bin/orch"')) continue;
    hook.command = hook.command.includes(HOOK_ENTRY)
      ? hook.command.replaceAll(HOOK_ENTRY, hookEntrypoint)
      : hook.command.replaceAll('"$HOME/.local/bin/orch"', entrypoint);
    rewritten++;
  }
  if (!rewritten || JSON.stringify(settings).includes("$HOME/.local/bin/orch")) throw new Error("benchmark source hooks were not fully rewritten");
  return JSON.stringify(settings, null, 2) + "\n";
}

// B/C/D run the Kiba that `kiba` starts (nativeKibaArgv's agent), taken from
// the source snapshot: its lead settings and catalog/kiba-native.md. The
// native lead has no denied tool; `denied` stays in the record, empty.
export interface StagedLead { path: string; settingsHash: string; promptHash: string; denied: string[] }

export async function stageLeadSettings(cwd: string, config: Config, run: BenchRun): Promise<StagedLead> {
  const [{ render }, { loadProfile }] = await Promise.all([
    import(pathToFileURL(join(cwd, "src", "install", "render.ts")).href),
    import(pathToFileURL(join(cwd, "src", "core", "profile.ts")).href),
  ]);
  const targets = render(loadProfile(), ["claude"]) as { path: string; content: string }[];
  const settings = targets.find((target) => target.path === ".claude/orch/lead-settings.json");
  const promptPath = kibaPromptPath(cwd);
  if (!settings || !existsSync(promptPath)) throw new Error("source snapshot " + cwd + " has no Claude lead settings or catalog/kiba-native.md");
  const denied: string[] = [];
  const orchEntrypoint = shellQuote(process.execPath) + " --no-env-file " + shellQuote(join(cwd, "src", "orch.ts"));
  const hookEntrypoint = shellQuote(process.execPath) + " --no-env-file " + shellQuote(join(cwd, "src", "hooks", "hook.ts"));
  const content = sourceHookSettings(settings.content, orchEntrypoint, hookEntrypoint);
  const artifact = "settings/" + config + ".json";
  run.writeArtifact(artifact, content);
  return { path: join(run.outDir, artifact), settingsHash: createHash("sha256").update(content).digest("hex"), promptHash: createHash("sha256").update(readFileSync(promptPath)).digest("hex"), denied };
}

export function kibaPromptPath(cwd: string): string { return join(cwd, "catalog", "kiba-native.md"); }

// Native Kiba's flags for a bench config: the snapshot's agent, no tool
// removed. `denied` and `withMcp` are kept for the callers' signature: the
// native lead has no MCP server of its own.
export function benchKibaFlags(cwd: string, denied: readonly string[] = [], _withMcp = true): { prompt: string[]; tools: string[] } {
  const agent = { description: "Kiba, the native developer with memory and optional lanes. Never spawn as a subagent.", prompt: readFileSync(kibaPromptPath(cwd), "utf8").trim() };
  return { prompt: ["--agent", "kiba", "--agents", JSON.stringify({ kiba: agent })], tools: denied.length ? ["--disallowedTools", denied.join(",")] : [] };
}

export function stageCliShims(cwd: string, config: Config, run: BenchRun): { path: string; hashes: Record<string, string> } {
  const dir = "bin/" + config;
  const entrypoint = (name: "orch" | "lane") => "#!/bin/sh\nexec " + shellQuote(process.execPath) + " --no-env-file " + shellQuote(join(cwd, "src", name + ".ts")) + " \"$@\"\n";
  const hashes: Record<string, string> = {};
  for (const name of ["orch", "lane"] as const) {
    const relative = dir + "/" + name;
    const content = entrypoint(name);
    run.writeArtifact(relative, content);
    chmodSync(join(run.outDir, relative), 0o755);
    hashes[name] = createHash("sha256").update(content).digest("hex");
  }
  return { path: join(run.outDir, dir), hashes };
}

export function supportsIsolatedBenchMemory(revision: string): boolean {
  const source = sourceFile(revision, "src/orch.ts");
  const hooks = sourceFile(revision, "src/hooks/hook.ts");
  const recall = sourceFile(revision, "src/memory/brain-recall.ts");
  const snapshotStore = sourceFile(revision, "src/memory/snapshot-mem.ts");
  return source.includes("if (process.env.ORCH_BRAIN_SNAPSHOT || process.env.ORCH_BENCH_RUN)")
    && source.includes("benchmark memory requires a run-owned sandbox")
    && hooks.includes("ORCH_MEMORY_PROVIDER") && hooks.includes('provider === "brain"')
    && recall.includes("ORCH_BRAIN_SNAPSHOT") && recall.includes("benchmarks require a snapshot")
    && snapshotStore.includes("export function snapshotMem");
}

export interface FrozenLeadContext { files: Record<string, { present: boolean; content: string; sha256: string | null }> }

export function freezeLeadContext(sourceState = stateDir()): FrozenLeadContext {
  const files: FrozenLeadContext["files"] = {};
  for (const name of ["USER.md", "MEMORY.md"]) {
    const path = join(sourceState, "kiba-memory", name);
    const present = existsSync(path);
    const content = present ? readFileSync(path, "utf8") : "";
    files[name] = { present, content, sha256: present ? createHash("sha256").update(content).digest("hex") : null };
  }
  return { files };
}

export function stageLeadContext(context: FrozenLeadContext, targetState: string): void {
  const dir = join(targetState, "kiba-memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, file] of Object.entries(context.files)) if (file.present) writeFileSync(join(dir, name), file.content);
}

export interface FrozenLlmContext {
  configText: string;
  configSource: string;
  configSha256: string;
  selection: { present: boolean; content: string; sha256: string | null };
  selectedProviders: Record<string, string | null>;
}

export function freezeLlmContext(catalogText: string, sourceState = stateDir()): FrozenLlmContext {
  const configSource = process.env.ORCH_LLM_CONFIG ?? "selected-ref:catalog/llm.yaml";
  const configText = process.env.ORCH_LLM_CONFIG ? readFileSync(process.env.ORCH_LLM_CONFIG, "utf8") : catalogText;
  const config = parse(configText) as { embed?: { default?: string; providers?: Record<string, { space?: string }> }; decide?: { default?: string; providers?: Record<string, unknown> } };
  const selectionPath = join(sourceState, "llm.json");
  const present = existsSync(selectionPath);
  const selectionText = present ? readFileSync(selectionPath, "utf8") : "";
  const selection = present ? JSON.parse(selectionText) as Record<string, { name?: string }> : {};
  const selectedProviders: Record<string, string | null> = {};
  for (const role of ["embed", "decide"] as const) {
    const section = config[role];
    const selected = selection[role]?.name ?? section?.default;
    if (!section?.providers?.[selected ?? ""]) throw new Error("LLM " + role + " provider " + String(selected) + " is missing from the frozen catalog");
    selectedProviders[role] = selected ?? null;
  }
  return {
    configText, configSource, configSha256: createHash("sha256").update(configText).digest("hex"),
    selection: { present, content: selectionText, sha256: present ? createHash("sha256").update(selectionText).digest("hex") : null },
    selectedProviders,
  };
}

export function stageLlmSelection(context: FrozenLlmContext, targetState: string): void {
  if (!context.selection.present) return;
  mkdirSync(targetState, { recursive: true });
  writeFileSync(join(targetState, "llm.json"), context.selection.content);
}

export function validateSnapshotLlmSpace(snapshot: { space: string; dimensions: number }, context: FrozenLlmContext): void {
  const config = parse(context.configText) as { dimensions?: number; embed?: { providers?: Record<string, { space?: string }> } };
  const provider = config.embed?.providers?.[context.selectedProviders.embed ?? ""];
  if (!provider?.space || !Number.isSafeInteger(config.dimensions)) throw new Error("frozen LLM config has no valid embedding space");
  if (snapshot.space !== provider.space || snapshot.dimensions !== config.dimensions) throw new Error("brain snapshot embedding space does not match the frozen LLM selection");
}

export function executableFingerprint(): { path: string; sha256: string } {
  const path = which("claude");
  if (!path) throw new Error("claude executable not found on PATH");
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

export function addWorktrees(run: BenchRun, configs: Config[], revision: string): Record<Config, string> {
  const cwds = Object.fromEntries(CONFIGS.map((config) => [config, join(tmpdir(), "orch-bench-" + run.id + "-" + config)])) as Record<Config, string>;
  const attempted: Config[] = [];
  try {
    for (const config of configs) {
      if (existsSync(cwds[config])) throw new Error("temporary worktree path already exists: " + cwds[config]);
      attempted.push(config);
      const result = Bun.spawnSync(["git", "worktree", "add", "--detach", cwds[config], revision], { cwd: ROOT });
      if (result.exitCode !== 0) throw new Error("worktree " + config + ": " + result.stderr.toString());
      symlinkSync(join(ROOT, "node_modules"), join(cwds[config], "node_modules"), "dir");
    }
    return cwds;
  } catch (error) {
    cleanupWorktrees(cwds, attempted);
    throw error;
  }
}

export function cleanupWorktrees(cwds: Record<Config, string>, configs: Config[]): void {
  const failures: string[] = [];
  for (const config of configs) {
    const path = cwds[config];
    const result = Bun.spawnSync(["git", "worktree", "remove", "--force", path], { cwd: ROOT });
    if (result.exitCode !== 0 && existsSync(path)) {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (error) { failures.push(config + ": " + (error instanceof Error ? error.message : String(error))); }
    }
  }
  const prune = Bun.spawnSync(["git", "worktree", "prune"], { cwd: ROOT });
  if (prune.exitCode !== 0) failures.push("prune: " + prune.stderr.toString());
  if (failures.length) throw new Error("worktree cleanup failed: " + failures.join("; "));
}

export function parseConfigs(raw: string): Config[] {
  const values = raw.split(",").map((value) => value.trim().toUpperCase());
  if (!values.length || values.some((value) => !CONFIGS.includes(value as Config))) throw new Error("config must be a comma-separated list of " + CONFIGS.join(","));
  if (new Set(values).size !== values.length) throw new Error("config list contains duplicates");
  return values as Config[];
}

const CONSO_OPTIONS = {
  config: { type: "string", default: "A,B,C" }, session: { type: "string" }, repeat: { type: "string", default: "1" },
  jobs: { type: "string", default: "3" }, "dry-run": { type: "boolean" }, live: { type: "boolean" }, "allow-paid": { type: "boolean" }, hindsight: { type: "string", default: "" },
  ref: { type: "string" }, "brain-snapshot": { type: "string" }, "no-seed": { type: "boolean", default: false },
} as const;

export function parseConsoOptions(args: string[]) {
  return parseArgs({ args, options: CONSO_OPTIONS, strict: true }).values;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const opt = parseConsoOptions(args);
  if (opt.live) return live(loadHindsightConfig().url.replace(/\/$/, ""));
  requireAllowPaid(args, "conso");

  const source = resolveSource(opt.ref);
  const dryRun = !!opt["dry-run"];
  if (source.dirtyHash && !opt.ref && !dryRun) throw new Error("working tree is dirty; use --ref <commit> to pin a snapshot explicitly");
  if (!dryRun && !supportsIsolatedBenchMemory(source.revision)) throw new Error("selected --ref has no ORCH_BENCH_RUN snapshot memory guard; that revision is unsafe for model runs");
  const corpusText = sourceFile(source.revision, "tests/parity/conso.yaml");
  const configText = sourceFile(source.revision, "catalog/brain.yaml");
  const llmCatalogText = sourceFile(source.revision, "catalog/llm.yaml");
  const lockText = sourceFile(source.revision, "bun.lock");
  const sourceState = stateDir();
  const leadContext = freezeLeadContext(sourceState);
  const llmContext = freezeLlmContext(llmCatalogText, sourceState);
  if (!dryRun && createHash("sha256").update(lockText).digest("hex") !== createHash("sha256").update(readFileSync(join(ROOT, "bun.lock"))).digest("hex")) {
    throw new Error("selected source bun.lock differs from the installed dependency lock; use a ref with the current lockfile");
  }
  const doc = parse(corpusText) as { sessions: { id: string; prompts: string[] }[] };
  const sessions = doc.sessions.filter((s) => !opt.session || opt.session.split(",").includes(s.id));
  if (!sessions.length) throw new Error("no matching sessions in tests/parity/conso.yaml");
  const configs = parseConfigs(opt.config!);
  const repeat = positiveInteger("repeat", opt.repeat!);
  const jobsCount = positiveInteger("jobs", opt.jobs!);
  if (!dryRun && configs.some((config) => config === "C" || config === "D") && !opt["brain-snapshot"]) throw new Error("config C and D require --brain-snapshot <file>");
  for (const config of ["C", "D"] as const) if (configs.includes(config)) {
    benchBrainYaml(configText, "bench-preflight-" + config, config === "D" ? hindsightRetainOverride(opt.hindsight, false) : opt.hindsight);
  }
  let snapshotText = "";
  let brainProject = "";
  if (opt["brain-snapshot"]) {
    snapshotText = readFileSync(opt["brain-snapshot"]!, "utf8");
    const snapshot: unknown = JSON.parse(snapshotText);
    validateSnapshot(snapshot);
    validateSnapshotLlmSpace(snapshot, llmContext);
    brainProject = snapshot.project;
    if (brainProject !== projectKey(ROOT)) throw new Error("brain snapshot project " + brainProject + " does not match " + projectKey(ROOT));
  }

  const jobs = configs.flatMap((config) => sessions.flatMap((s) => Array.from({ length: repeat }, (_, rep) => ({ config, s, rep }))));
  const prompts = jobs.reduce((n, j) => n + j.s.prompts.length, 0);
  const run = allocateRun({
    suite: "conso", feature: "memory-provider-v1", source, corpus: { corpusText, brainSnapshotSha256: snapshotText ? createHash("sha256").update(snapshotText).digest("hex") : null, leadContext: Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, { present: file.present, sha256: file.sha256 }])), llmConfigSha256: llmContext.configSha256, llmSelectionSha256: llmContext.selection.sha256, llmProviders: llmContext.selectedProviders },
    settings: { hindsight: opt.hindsight ?? "", noSeed: !!opt["no-seed"], brainSnapshotSha256: snapshotText ? createHash("sha256").update(snapshotText).digest("hex") : null },
    models: { claude: MODEL, effort: EFFORT }, protocol: { configs, repeat, sessions: sessions.map((s) => s.id), jobs: jobsCount, hindsight: configs.includes("C"), leadLaunch: LEAD_LAUNCH }, paid: true, dryRun,
  });
  const out = run.outDir;
  const bankIds: Partial<Record<Config, string>> = {};
  for (const config of ["C", "D"] as const) if (configs.includes(config)) bankIds[config] = run.bankId(config);
  log(sessions.length + " sessions x " + repeat + ", configs " + configs.join("") + ", " + jobs.length + " conversations, " + prompts + " claude -p prompts, run " + run.id + ", out " + out);
  if (dryRun) {
    for (const j of jobs) process.stdout.write(j.config + " " + j.s.id + "#" + j.rep + " (" + j.s.prompts.length + " prompts)\n");
    process.stdout.write("run " + run.id + " (no files written)\n");
    return;
  }

  const executable = executableFingerprint();
  const cwds = addWorktrees(run, configs, source.revision);
  const turns: Turn[] = [];
  const extra: Record<string, string> = opt.hindsight ? { "réglages Hindsight (C)": opt.hindsight } : {};
  const hindsight: Partial<Record<Config, HindsightUsage>> = {};
  let before: HindsightUsage | undefined;
  let seedUsage: HindsightUsage | undefined;
  let hconfig: ReturnType<typeof loadHindsightConfig> | undefined;
  const bank = bankIds.C;
  const ownedBanks = bank ? [bank, bank + "-" + projectKey(ROOT)] : [];
  let costComplete = true;

  try {
    const stateDirs = Object.fromEntries(configs.map((config) => [config, run.stateDirFor(config)])) as Record<Config, string>;
    run.writeArtifact("catalog/llm.yaml", llmContext.configText);
    for (const config of configs) {
      if (config !== "A") stageLeadContext(leadContext, stateDirs[config]);
      stageLlmSelection(llmContext, stateDirs[config]);
    }
    run.writeJsonArtifact("context-manifest.json", Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, { present: file.present, sha256: file.sha256 }])));
    run.writeJsonArtifact("llm-manifest.json", { configSource: llmContext.configSource, configSha256: llmContext.configSha256, selectionPresent: llmContext.selection.present, selectionSha256: llmContext.selection.sha256, selectedProviders: llmContext.selectedProviders });
    const benchBrains: Partial<Record<Config, string>> = {};
    for (const config of ["C", "D"] as const) if (configs.includes(config)) {
      const bankForConfig = bankIds[config]!;
      const overrides = config === "D" ? hindsightRetainOverride(opt.hindsight, false) : opt.hindsight;
      const content = benchBrainYaml(configText, bankForConfig, overrides);
      const artifact = "brain-" + config + ".yaml";
      run.writeArtifact(artifact, content);
      benchBrains[config] = join(out, artifact);
    }
    if (snapshotText) run.writeArtifact("brain-snapshot.json", snapshotText);
    run.writeArtifact("runs.jsonl", "");

    const leadSettings: Partial<Record<Config, string>> = {};
    const settingsHashes: Partial<Record<Config, string>> = {};
    const promptHashes: Partial<Record<Config, string>> = {};
    const leadDenied: Partial<Record<Config, string[]>> = {};
    const binPaths: Partial<Record<Config, string>> = {};
    const cliShimHashes: Partial<Record<Config, Record<string, string>>> = {};
    for (const config of configs) if (config !== "A") {
      const staged = await stageLeadSettings(cwds[config], config, run);
      leadSettings[config] = staged.path;
      settingsHashes[config] = staged.settingsHash;
      promptHashes[config] = staged.promptHash;
      leadDenied[config] = staged.denied;
    }
    for (const config of configs) {
      const staged = stageCliShims(cwds[config], config, run);
      binPaths[config] = staged.path;
      cliShimHashes[config] = staged.hashes;
    }
    settingsHashes.A = createHash("sha256").update(JSON.stringify({ autoMemoryEnabled: true })).digest("hex");
    run.writeJsonArtifact("provenance.json", {
      source, executable,
      corpus: { "tests/parity/conso.yaml": createHash("sha256").update(corpusText).digest("hex"), "catalog/brain.yaml": createHash("sha256").update(configText).digest("hex"), leadContext: Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, file.sha256])) },
      dependencyLockSha256: createHash("sha256").update(lockText).digest("hex"), settings: settingsHashes, leadLaunch: LEAD_LAUNCH, leadPrompts: promptHashes, leadDisallowedTools: leadDenied, cliShims: cliShimHashes,
      brainSnapshotSha256: snapshotText ? createHash("sha256").update(snapshotText).digest("hex") : null,
      llm: { configSource: llmContext.configSource, configSha256: llmContext.configSha256, selectionSha256: llmContext.selection.sha256, selectedProviders: llmContext.selectedProviders },
    });

    const ctx: Ctx = {
      run, out, cwds, stateDirs, binPaths, banks: bankIds, benchBrains, leadSettings, leadDenied, claudeExecutable: executable.path,
      llmConfig: join(out, "catalog/llm.yaml"),
      brainSnapshot: snapshotText ? join(out, "brain-snapshot.json") : undefined,
      brainProject: brainProject || undefined, sourceRevision: source.revision,
    };
    if (configs.includes("C") && bank) {
      hconfig = loadHindsightConfig(benchBrains.C!);
      const hbase = hconfig.url.replace(/\/$/, "");
      for (const ownedBank of ownedBanks) {
        const result = await ensureBank(hconfig, ownedBank);
        if (!result.ok) throw new Error("bank " + ownedBank + ": " + result.error);
      }
      if (opt["no-seed"]) {
        extra["seed"] = "skipped; run-owned empty bank";
      } else {
        const snapshotStore = snapshotMem(join(out, "brain-snapshot.json"), { includeTranscripts: true });
        const seeded = await seedHindsight(hconfig, bank, { sourceState, manifestState: run.stateDirFor("seed-C"), full: true, concurrency: jobsCount, store: snapshotStore, includeExhaust: false, log });
        extra["seed"] = seeded.notes + " notes + " + seeded.exhaust + " exhaust items, " + seeded.failed + " failed";
        if (seeded.failed) throw new Error("Hindsight seed failed for " + seeded.failed + " item(s); run " + run.id + " is incomplete");
      }
      const initialBusy = await drainOwnedBanks(hbase, ownedBanks);
      if (initialBusy) throw new Error("run bank " + bank + " still has " + initialBusy + " queued operation(s) before prompts");
      seedUsage = await exactOwnedBankUsage(hbase, ownedBanks);
      before = seedUsage;
    }

    const started = Date.now();
    await pool(jobs, jobsCount, async ({ config, s, rep }) => {
      const id = run.sessionNamespace + "-" + config + "-" + randomUUID();
      for (const [index, prompt] of s.prompts.entries()) turns.push(await runPrompt(config, s.id, rep, index, prompt, id, ctx));
    });
    extra["durée"] = Math.round((Date.now() - started) / 60_000) + " min, " + jobsCount + " conversations en parallèle";
    extra["notes orch mem du banc (jamais dans la vraie mémoire)"] = sandboxSummary(Object.fromEntries(configs.map((c) => [c, join(out, "mem-" + c)])));
  } finally {
    cleanupWorktrees(cwds, configs);
  }

  if (before && hconfig && bank) {
    const hbase = hconfig.url.replace(/\/$/, "");
    const left = await drainOwnedBanks(hbase, ownedBanks);
    if (left) {
      extra["couverture coût Hindsight"] = "incomplète: " + left + " opération(s) encore en attente après 15 min";
      costComplete = false;
    }
    try {
      hindsight.C = diffUsage(await exactOwnedBankUsage(hbase, ownedBanks), before);
    } catch (error) {
      extra["couverture coût Hindsight"] = "incomplète: " + (error instanceof Error ? error.message : String(error));
      costComplete = false;
    }
    if (seedUsage) extra["coût seed Hindsight estimé C"] = PRICES_VERSION + ": " + hindsightCost(seedUsage).toFixed(4) + " $";
    run.writeJsonArtifact("hindsight.json", { pricingVersion: PRICES_VERSION, seedUsage, seedEstimatedUsd: seedUsage ? hindsightCost(seedUsage) : null, usage: hindsight, complete: costComplete });
    extra["banks du banc supprimés"] = await dropOwnedBanks(hconfig, ownedBanks);
  }
  if (configs.some((config) => config === "B" || config === "C" || config === "D")) extra["comparabilité coût mémoire"] = "les embeddings à la demande du provider brain ne sont pas instrumentés; les coûts C/D totaux sont exclus des métriques comparatives";
  if (configs.includes("D")) extra["couverture coût D"] = "incomplète: le coût des embeddings de requête du provider brain n'est pas instrumenté";
  const successful = turns.filter((turn) => !turn.error);
  const runtimeModels = [...new Set(turns.flatMap((turn) => turn.model_ids ?? []))].sort();
  const modelIdentityComplete = successful.length > 0 && successful.every((turn) => !!turn.model_ids?.length);
  extra["modèles runtime"] = runtimeModels.length ? runtimeModels.join(", ") + (modelIdentityComplete ? "" : " (identité incomplète)") : "identités inconnues";
  const report = renderReport(turns, hindsight, extra);
  run.writeArtifact("report.md", report);
  run.writeJsonArtifact("runtime-models.json", { models: runtimeModels, complete: modelIdentityComplete });
  const observations = turns.map((turn) => ({
    caseId: turn.session + "-" + (turn.index + 1), config: turn.config, attempt: turn.rep + 1,
    cost: turn.config === "A" ? turn.cost_usd : null,
    latencyMs: turn.duration_ms, ...(turn.error ? { error: turn.error } : {}),
  }));
  run.finalize(observations);
  process.stdout.write(report);
  if (!costComplete) throw new Error("Hindsight cost coverage is incomplete for run " + run.id);
}
if (import.meta.main) main().catch((e) => { log(`failed: ${(e as Error).message}`); process.exit(1); });
