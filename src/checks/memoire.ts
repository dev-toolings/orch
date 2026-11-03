#!/usr/bin/env bun
// memoire: the memory bench of tests/parity/memoire.yaml (BILLABLE: claude -p
// runs, Hindsight extraction, one judge call per family). Four configurations
// answer the same cases in fresh `claude -p` sessions, each configuration from
// its own throwaway worktree of a pinned repository revision:
//   A  claude alone: no orch hooks, native auto-memory on
//   B  lead before Hindsight: lead prompt and hooks, ORCH_MEMORY=off
//   C  lead + Hindsight: lead prompt and hooks, a run-owned Hindsight bank
//      seeded from the supplied frozen brain snapshot; retain stays off
//   D  lead + brain snapshot: lead prompt and hooks, frozen recall only
// A blind Claude judge (lane ask) scores every answer exact,
// partial or wrong against the case's expectation; tokens, cost, turns and hook
// latency are measured alongside. Every run has a UUID output, isolated state,
// session IDs and run-owned CLI shims. C and D require --brain-snapshot.
// Output lands under <state>/bench/memoire/<uuid>/.
//
//   bun src/checks/memoire.ts [--config A,B,C,D] [--family f] [--case id] [--persona-runs 5] [--repeat 1]
//     [--jobs 3] [--brain-snapshot file] [--ref commit] [--no-seed] [--no-judge] [--dry-run]
//   bun src/checks/memoire.ts --judge <run dir> creates a new output run
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { stateDir } from "../core/paths.ts";
import { sandboxSummary } from "../mem/sandbox.ts";
import { ROOT } from "../core/profile.ts";
import { projectKey } from "../core/project.ts";
import { ensureBank, loadHindsightConfig } from "../memory/hindsight.ts";
import { seedHindsight } from "../memory/seed.ts";
import { addWorktrees, benchBrainYaml, benchKibaFlags, LEAD_LAUNCH, cleanupWorktrees, diffUsage, drainOwnedBanks, dropOwnedBanks, exactOwnedBankUsage, executableFingerprint, freezeLeadContext, freezeLlmContext, hindsightCost, hindsightRetainOverride, parseConfigs as parseBenchConfigs, parseClaudeResult, positiveInteger, PRICES_VERSION, resolveSource, sourceFile, stageCliShims, stageLeadContext, stageLeadSettings, stageLlmSelection, supportsIsolatedBenchMemory, validateSnapshotLlmSpace, type HindsightUsage } from "./conso.ts";
import { allocateRun, type BenchRun } from "../bench/index.ts";
import { claudeEnv as benchClaudeEnv } from "../bench/claude-env.ts";
import { captureProcess } from "../bench/process.ts";
import { pool } from "../core/pool.ts";
import { requireAllowPaid } from "../core/paid.ts";
import { validateSnapshot } from "../memory/brain-recall.ts";
import { snapshotMem } from "../memory/snapshot-mem.ts";

type Config = "A" | "B" | "C" | "D";
type Family = "rappel" | "persona" | "apprentissage" | "ingestion";
interface Case { id: string; family: Family; level: number; question?: string; correction?: string; check?: string; expect: string }
interface Run {
  config: Config; case: string; family: Family; session: string; turn: string; attempt: number; judged: boolean;
  prompt: string; answer: string; exit: number; error?: string;
  duration_ms: number; num_turns: number; cost_usd: number; input_tokens: number; cached_tokens: number; output_tokens: number;
  model_ids?: string[];
}
type Verdict = "exact" | "partial" | "wrong";

const CONFIGS: Config[] = ["A", "B", "C", "D"];
const MODEL = "opus";      // every config, A included, is pinned to opus/high
const EFFORT = "high";
const RUN_TIMEOUT_MS = 600_000;
export const RECALL_INSTRUCTIONS = "This is a recall evaluation. Answer only from the context already provided in this session. Do not infer missing past decisions. If the answer is absent, say you do not know. Answer in at most three sentences.";
const FILLER = "Quel est le port de brain-postgres ?";
const PROJECT = projectKey(ROOT);

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

const OPTIONS = {
    config: { type: "string", default: "A,B,C" },
    family: { type: "string" },
    case: { type: "string" },
    "persona-runs": { type: "string", default: "5" },
    repeat: { type: "string", default: "1" },
    jobs: { type: "string", default: "3" },
    hindsight: { type: "string", default: "" },
    "no-seed": { type: "boolean", default: false },
    "no-judge": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "allow-paid": { type: "boolean", default: false },
    judge: { type: "string" },
    ref: { type: "string" },
    "brain-snapshot": { type: "string" },
  } as const;
export function parseMemoireOptions(args: string[]) {
  return parseArgs({ args, options: OPTIONS, strict: true }).values as {
    config: string; family?: string; case?: string; "persona-runs": string; repeat: string; jobs: string; hindsight: string;
    "no-seed": boolean; "no-judge": boolean; "dry-run": boolean; judge?: string; ref?: string; "brain-snapshot"?: string;
  };
}
let opt = parseMemoireOptions(import.meta.main ? process.argv.slice(2) : []);

const log = (line: string) => process.stderr.write(`[memoire] ${line}\n`);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ---------------------------------------------------------------- cases
function loadCases(corpus: string, options = opt): Case[] {
  const doc = parse(corpus) as { cases: Case[] };
  return doc.cases.filter((c) => (!options.family || c.family === options.family) && (!options.case || c.id === options.case));
}

// ---------------------------------------------------------------- seed
// ---------------------------------------------------------------- claude runs
interface Ctx { run: BenchRun; out: string; cwds: Record<Config, string>; sourceCwd: string; sourceConfig: Config; stateDirs: Record<Config, string>; binPaths: Partial<Record<Config, string>>; benchBrains: Partial<Record<Config, string>>; leadSettings: Partial<Record<Config, string>>; leadDenied?: Partial<Record<Config, string[]>>; llmConfig: string; claudeExecutable: string; envOverrides?: Record<string, string>; brainSnapshot?: string; brainProject?: string }

export function claudeEnv(config: Config, session: string, ctx: Ctx, sandboxId = session): Record<string, string> {
  return benchClaudeEnv(config, session, ctx, sandboxId);
}

export async function runClaude(config: Config, kase: Case, turn: string, prompt: string, session: string, ctx: Ctx, claude?: { id: string; resume: boolean }, judged = false, attempt = 1, sandboxId = session): Promise<Run> {
  const argv = [ctx.claudeExecutable, "-p", prompt, "--output-format", "json", "--model", MODEL, "--effort", EFFORT, "--permission-mode", "bypassPermissions"];
  // Recall measures injected memory, without reading answer keys or old reports.
  if (kase.family === "rappel") argv.push("--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--append-system-prompt", RECALL_INSTRUCTIONS);
  if (claude) argv.push(claude.resume ? "--resume" : "--session-id", claude.id);
  else argv.push("--no-session-persistence");
  if (config === "A") argv.push("--settings", JSON.stringify({ autoMemoryEnabled: true }));
  else {
    // Recall keeps --tools "" and the empty strict MCP config above: the kiba MCP is left out there.
    const kiba = benchKibaFlags(ctx.cwds[config], ctx.leadDenied?.[config], kase.family !== "rappel");
    argv.push("--settings", ctx.leadSettings[config]!, ...kiba.prompt, ...kiba.tools);
  }
  const t0 = Date.now();
  const captured = await captureProcess(argv, { cwd: ctx.cwds[config], env: claudeEnv(config, session, ctx, sandboxId), timeoutMs: RUN_TIMEOUT_MS });
  const { stdout, stderr, exit } = captured;
  const run: Run = { config, case: kase.id, family: kase.family, session, turn, attempt, judged, prompt, answer: "", exit, duration_ms: Date.now() - t0, num_turns: 0, cost_usd: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0 };
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const u = (j.usage ?? {}) as Record<string, number>;
    const modelUsage = (j.modelUsage ?? {}) as Record<string, unknown>;
    run.model_ids = [...new Set([...(typeof j.model === "string" ? [j.model] : []), ...Object.keys(modelUsage)])].sort();
    run.answer = typeof j.result === "string" ? j.result : "";
    run.num_turns = Number(j.num_turns ?? 0);
    run.cost_usd = Number(j.total_cost_usd ?? 0);
    run.input_tokens = Number(u.input_tokens ?? 0);
    run.cached_tokens = Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    run.output_tokens = Number(u.output_tokens ?? 0);
    if (j.is_error) run.error = run.answer.slice(0, 300) || "is_error";
  } catch {
    run.error = `no JSON (exit ${exit}): ${(stderr || stdout).slice(0, 300).replace(/\s+/g, " ")}`;
  }
  const parsed = parseClaudeResult(stdout, stderr, exit);
  if (parsed.error) run.error = parsed.error;
  if (captured.timedOut) run.error = `claude timed out after ${RUN_TIMEOUT_MS} ms`;
  appendFileSync(join(ctx.out, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  log(`${config} ${kase.id} ${turn}: ${run.error ? `ERROR ${run.error.slice(0, 80)}` : `${run.num_turns} turns, ${Math.round(run.duration_ms / 1000)} s, $${run.cost_usd.toFixed(3)}`}`);
  return run;
}

type Job = { label: string; runs: number; run: () => Promise<void> };

function jobs(cases: Case[], configs: Config[], ctx: Ctx, personaRuns: number, repeats: number): Job[] {
  const out: Job[] = [];
  for (const c of cases) for (const config of configs) {
    const sid = (suffix: string, attempt: number) => `${ctx.run.sessionNamespace}-${config}-${c.id}${suffix}-r${attempt}`;
    if (c.family === "persona") {
      for (let attempt = 1; attempt <= repeats; attempt++) for (let k = 1; k <= personaRuns; k++) out.push({ label: `${config} ${c.id}/${k} r${attempt}`, runs: 1, run: () => runClaude(config, c, `s${k}`, c.question!, sid(`-${k}`, attempt), ctx, undefined, true, attempt, `${c.id}-persona-${k}-r${attempt}`).then(() => {}) });
    } else if (c.family === "apprentissage") {
      for (let attempt = 1; attempt <= repeats; attempt++) out.push({ label: `${config} ${c.id} r${attempt}`, runs: 4, run: async () => {
        const id = randomUUID();
        const sandbox = `${c.id}-learning-r${attempt}`;
        await runClaude(config, c, "N/task", c.check!, sid("-n", attempt), ctx, { id, resume: false }, false, attempt, sandbox);
        await runClaude(config, c, "N/correction", c.correction!, sid("-n", attempt), ctx, { id, resume: true }, false, attempt, sandbox);
        await runClaude(config, c, "N+1/filler", FILLER, sid("-n1", attempt), ctx, undefined, false, attempt, sandbox);
        await runClaude(config, c, "N+2/check", c.check!, sid("-n2", attempt), ctx, undefined, true, attempt, sandbox);
      } });
    } else {
      for (let attempt = 1; attempt <= repeats; attempt++) out.push({ label: `${config} ${c.id} r${attempt}`, runs: 1, run: () => runClaude(config, c, "q", c.question!, sid("", attempt), ctx, undefined, true, attempt, `${c.id}-r${attempt}`).then(() => {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- judge
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function assertHookReceipts(stateDir: string, runId: string, provider: string, sessions: string[]): void {
  const file = join(stateDir, "hooks", "bench-receipts.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  for (const session of sessions) for (const event of ["session-start", "prompt-submit"]) {
    if (!rows.some((row) => row.run === runId && row.session === session && row.event === event && row.provider === provider)) throw new Error(`missing native hook receipt: ${provider}/${session}/${event}`);
  }
}

export function parseJudgeScores(report: string, answer: string, expectedKeys: string[]): Record<string, Verdict> {
  const exit = /^EXIT:\s*(-?\d+)\s*$/m.exec(report);
  if (!exit || Number(exit[1]) !== 0) throw new Error("judge did not succeed: " + (exit ? `exit ${exit[1]}` : "missing EXIT status"));
  const expected = new Set(expectedKeys);
  const scores: Record<string, Verdict> = {};
  for (const match of answer.matchAll(/^SCORE\s+(\S+)\s+([A-Z]\d*)\s+(exact|partial|wrong)\s*$/gmi)) {
    const key = `${match[1]}:${match[2].toUpperCase()}`;
    if (!expected.has(key) || scores[key]) throw new Error("judge returned an unexpected or duplicate score: " + key);
    scores[key] = match[3].toLowerCase() as Verdict;
  }
  const missing = expectedKeys.filter((key) => !scores[key]);
  if (missing.length) throw new Error("judge omitted scores: " + missing.join(", "));
  return scores;
}

async function judge(out: string, cases: Case[], ctx: Ctx): Promise<Record<string, Record<string, Verdict | "missing">>> {
  const runs = readJsonl(join(out, "runs.jsonl")) as unknown as Run[];
  const scores: Record<string, Record<string, Verdict | "missing">> = {};
  const families = [...new Set(cases.map((c) => c.family))];
  for (const family of families) {
    const blocks: string[] = [];
    const mapping: Record<string, { config: Config; session: string }> = {};
    for (const c of cases.filter((k) => k.family === family)) {
      const answered = runs.filter((r) => r.case === c.id && r.judged && !r.error);
      // Fisher-Yates: the judge must not learn the configuration from the order.
      for (let i = answered.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [answered[i], answered[j]] = [answered[j], answered[i]]; }
      const question = c.family === "apprentissage" ? `${c.check} (une correction a été donnée deux sessions plus tôt : « ${c.correction} »)` : c.question!;
      const lines = [`### CASE ${c.id}`, `QUESTION: ${question}`, `EXPECTED: ${c.expect}`, ""];
      answered.forEach((r, i) => {
        const label = LABELS[i] ?? `Z${i}`;
        mapping[`${c.id}:${label}`] = { config: r.config, session: r.session };
        lines.push(`ANSWER ${label}:`, r.answer.trim().slice(0, 1800), "");
      });
      for (const r of runs.filter((r) => r.case === c.id && r.judged && r.error)) (scores[c.id] ??= {})[r.session] = "missing";
      blocks.push(lines.join("\n"));
    }
    if (!Object.keys(mapping).length) continue;
    const file = join(out, `judge-${family}.md`);
    writeFileSync(file, `You are the blind judge of a memory bench. Several assistants answered each question below in fresh sessions, with different memory systems. Score each answer against EXPECTED on content only, never on style or length:
- exact: the answer states the expected fact, decision or stance; when EXPECTED is a note id (a string starting with a date like 20261020T...), the answer cites that id or the decision it holds with its date.
- partial: right direction, but the key element (the id, the date, the reason, the refusal) is missing.
- wrong: the answer is absent, contradicts EXPECTED, invents, or asks instead of answering.
Do not read the repository. Output exactly one line per answer and nothing else, in this form:
SCORE <case> <label> <exact|partial|wrong>

${blocks.join("\n\n")}
`);
    writeFileSync(join(out, `judge-${family}.json`), `${JSON.stringify(mapping, null, 2)}\n`);
    log(`judge ${family}: ${Object.keys(mapping).length} answers`);
    const cwd = ctx.sourceCwd;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    Object.assign(env, {
      ENABLE_CLAUDEAI_MCP_SERVERS: "false", ORCH_LEAD: "1", ORCH_HARNESS: "claude", ORCH_STATE: ctx.stateDirs[ctx.sourceConfig], ORCH_BENCH_RUN: ctx.run.id,
      ORCH_MEM_SANDBOX: join(out, "mem-judge"), ORCH_LLM_CONFIG: ctx.llmConfig,
      PATH: (ctx.binPaths[ctx.sourceConfig] ?? "") + ":" + (env.PATH ?? ""),
      ...(ctx.brainSnapshot ? { ORCH_BRAIN_SNAPSHOT: ctx.brainSnapshot } : {}),
      ...(ctx.brainProject ? { ORCH_BRAIN_PROJECT: ctx.brainProject } : {}),
    });
    const captured = await captureProcess([process.execPath, "--no-env-file", join(cwd, "src", "lane.ts"), "ask", "--to", "claude", "--file", file], { cwd, env, timeoutMs: RUN_TIMEOUT_MS });
    const report = captured.stdout;
    writeFileSync(join(out, `judge-${family}.report.md`), report);
    if (captured.timedOut || captured.exit !== 0) throw new Error(`judge ${family} failed (exit ${captured.exit}${captured.timedOut ? ", timed out" : ""}): ${captured.stderr.slice(0, 300)}`);
    const logPath = /^LOG: (.+)$/m.exec(report)?.[1];
    const last = logPath && existsSync(join(dirname(logPath), "last.txt")) ? readFileSync(join(dirname(logPath), "last.txt"), "utf8") : report;
    writeFileSync(join(out, `judge-${family}.answer.md`), last);
    const judged = parseJudgeScores(report, last, Object.keys(mapping));
    for (const [key, verdict] of Object.entries(judged)) {
      const [id] = key.split(":");
      (scores[id] ??= {})[mapping[key].session] = verdict;
    }
  }
  writeFileSync(join(out, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);
  return scores;
}

// ---------------------------------------------------------------- hook latency
async function hookLatency(ctx: Ctx, config: Config, event: "prompt-submit" | "session-start", n = 10): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const cwd = ctx.cwds[config];
    const session = ctx.run.sessionNamespace + "-latency-" + i;
    const captured = await captureProcess([process.execPath, "--no-env-file", join(cwd, "src", "orch.ts"), "hook", event, "--harness", "claude"], {
      cwd, env: claudeEnv(config, session, ctx), timeoutMs: 15_000,
      stdin: JSON.stringify({ session_id: session, cwd, prompt: "Où tourne la base mémoire et sur quel port ?" }),
    });
    if (captured.timedOut || captured.exit !== 0) throw new Error("snapshot hook failed: " + event + " exited " + captured.exit);
    times.push(Date.now() - t0);
  }
  return median(times);
}

// ---------------------------------------------------------------- report
function report(out: string, cases: Case[], configs: Config[], scores: Record<string, Record<string, Verdict | "missing">>, extra: Record<string, string>): string {
  const runs = readJsonl(join(out, "runs.jsonl")) as unknown as Run[];
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const families = [...new Set(cases.map((c) => c.family))];
  const count = (family: Family | null, config: Config) => {
    const tally = { exact: 0, partial: 0, wrong: 0, missing: 0 };
    for (const run of runs.filter((r) => r.config === config && r.judged && (!family || byCase.get(r.case)?.family === family))) {
      const verdict = scores[run.case]?.[run.session] ?? (run.error ? "missing" : undefined);
      if (verdict) tally[verdict] += 1;
    }
    return tally;
  };
  const lines = ["# Banc mémoire " + basename(out), "", "Cas : " + cases.length + " ; configs : " + configs.join(", ") + " ; runs : " + runs.length + " (" + runs.filter((r) => r.error).length + " en erreur).", ""];
  lines.push("## Scores (juge aveugle)", "", "| famille | config | exact | partiel | faux | manquant |", "|---|---|---|---|---|---|");
  for (const family of [...families, null]) for (const config of configs) {
    const t = count(family, config);
    lines.push("| " + (family ?? "TOTAL") + " | " + config + " | " + t.exact + " | " + t.partial + " | " + t.wrong + " | " + t.missing + " |");
  }
  if (families.includes("persona")) {
    lines.push("", "## Persona : constance sur les sessions (cas où toutes les sessions ont le même verdict)", "");
    for (const config of configs) {
      const ids = cases.filter((c) => c.family === "persona").map((c) => c.id);
      const steady = ids.filter((id) => {
        const vs = runs.filter((r) => r.case === id && r.config === config && r.judged).map((r) => scores[id]?.[r.session]).filter((v): v is Verdict | "missing" => !!v);
        return vs.length > 1 && new Set(vs).size === 1;
      });
      lines.push("- " + config + " : " + steady.length + "/" + ids.length);
    }
  }
  lines.push("", "## Coût et tokens (tous les runs, par config)", "", "| config | réussis/tentés | tours moy. | durée moy. (s) | entrée (hors cache) | cache | sortie | coût tenté ($) | coût réussi ($) |", "|---|---|---|---|---|---|---|---|---|");
  for (const config of configs) {
    const attempted = runs.filter((r) => r.config === config);
    const succeeded = attempted.filter((r) => !r.error);
    const sum = (rows: Run[], f: (r: Run) => number) => rows.reduce((n, r) => n + f(r), 0);
    lines.push("| " + config + " | " + succeeded.length + "/" + attempted.length + " | " + (sum(succeeded, (r) => r.num_turns) / Math.max(1, succeeded.length)).toFixed(1)
      + " | " + (sum(succeeded, (r) => r.duration_ms) / 1000 / Math.max(1, succeeded.length)).toFixed(0)
      + " | " + sum(succeeded, (r) => r.input_tokens) + " | " + sum(succeeded, (r) => r.cached_tokens) + " | " + sum(succeeded, (r) => r.output_tokens)
      + " | " + sum(attempted, (r) => r.cost_usd).toFixed(2) + " | " + sum(succeeded, (r) => r.cost_usd).toFixed(2) + " |");
  }
  lines.push("", "## Mesures annexes", "");
  for (const [k, v] of Object.entries(extra)) lines.push("- " + k + " : " + v);
  lines.push("", "## Par cas", "", "| cas | config | session | verdict |", "|---|---|---|---|");
  for (const c of cases) for (const run of runs.filter((r) => r.case === c.id && r.judged)) {
    lines.push("| " + c.id + " | " + run.config + " | " + run.session + " | " + (scores[c.id]?.[run.session] ?? "missing") + " |");
  }
  lines.push("", "Les coûts Claude viennent des estimations rapportées par Claude Code. Ils distinguent tous les essais des réponses réussies.", "");
  const text = lines.join("\n") + "\n";
  writeFileSync(join(out, "report.md"), text);
  return text;
}

// ---------------------------------------------------------------- main
export async function main(args = process.argv.slice(2)): Promise<void> {
  requireAllowPaid(args, "memoire");
  opt = parseMemoireOptions(args);
  let requestedRef = opt.ref;
  if (opt.judge && !requestedRef && existsSync(join(opt.judge, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(join(opt.judge, "manifest.json"), "utf8")) as { source?: { revision?: string } };
    requestedRef = manifest.source?.revision;
  }
  const source = resolveSource(requestedRef);
  const dryRun = opt["dry-run"];
  if (source.dirtyHash && !requestedRef && !dryRun) throw new Error("working tree is dirty; use --ref <commit> to pin a snapshot explicitly");
  if (!dryRun && !supportsIsolatedBenchMemory(source.revision)) throw new Error("selected --ref has no ORCH_BENCH_RUN snapshot memory guard; that revision is unsafe for model runs");

  const configs = parseBenchConfigs(opt.config);
  const personaRuns = positiveInteger("persona-runs", opt["persona-runs"]);
  const repeats = positiveInteger("repeat", opt.repeat);
  const jobsCount = positiveInteger("jobs", opt.jobs);
  const corpusText = sourceFile(source.revision, "tests/parity/memoire.yaml");
  const configText = sourceFile(source.revision, "catalog/brain.yaml");
  const llmCatalogText = sourceFile(source.revision, "catalog/llm.yaml");
  const lockText = sourceFile(source.revision, "bun.lock");
  if (!dryRun && createHash("sha256").update(lockText).digest("hex") !== createHash("sha256").update(readFileSync(join(ROOT, "bun.lock"))).digest("hex")) {
    throw new Error("selected source bun.lock differs from the installed dependency lock; use a ref with the current lockfile");
  }
  const cases = loadCases(corpusText, opt);
  if (!cases.length) throw new Error("no matching cases in tests/parity/memoire.yaml");
  const hasLearning = cases.some((item) => item.family === "apprentissage");
  if (hasLearning && cases.some((item) => item.family !== "apprentissage")) throw new Error("run apprentissage separately with --family apprentissage; mixing cohorts contaminates the shared memory");
  if (hasLearning && (configs.includes("C") || configs.includes("D"))) throw new Error("C apprenticeship needs isolated per-case retain and queue accounting; D cannot learn from its immutable snapshot");
  const sourceState = stateDir();
  const leadContext = freezeLeadContext(sourceState);
  const llmContext = freezeLlmContext(llmCatalogText, sourceState);
  const needsSnapshot = !dryRun && !opt.judge && configs.some((config) => config === "C" || config === "D");
  if (needsSnapshot && !opt["brain-snapshot"]) throw new Error("config C and D require --brain-snapshot <file>");
  for (const config of ["C", "D"] as const) if (configs.includes(config)) {
    benchBrainYaml(configText, "bench-preflight-" + config, hindsightRetainOverride(opt.hindsight, false));
  }
  let snapshotText = "";
  let brainProject = "";
  if (opt["brain-snapshot"]) {
    snapshotText = readFileSync(opt["brain-snapshot"], "utf8");
    const snapshot: unknown = JSON.parse(snapshotText);
    validateSnapshot(snapshot);
    validateSnapshotLlmSpace(snapshot, llmContext);
    brainProject = snapshot.project;
    if (brainProject !== PROJECT) throw new Error("brain snapshot project " + brainProject + " does not match " + PROJECT);
  }
  if (opt.judge && !existsSync(join(opt.judge, "runs.jsonl"))) throw new Error("judge source has no runs.jsonl");

  const oldRuns = opt.judge ? readFileSync(join(opt.judge, "runs.jsonl"), "utf8") : "";
  const listRun = allocateRun({
    suite: "memoire", feature: "memory-provider-v1", source,
    corpus: { cases: corpusText, brainSnapshotSha256: snapshotText ? createHash("sha256").update(snapshotText).digest("hex") : null, leadContext: Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, { present: file.present, sha256: file.sha256 }])), llmConfigSha256: llmContext.configSha256, llmSelectionSha256: llmContext.selection.sha256, llmProviders: llmContext.selectedProviders },
    settings: { hindsight: opt.hindsight, noSeed: opt["no-seed"], family: opt.family ?? null, case: opt.case ?? null },
    models: { claude: MODEL, effort: EFFORT }, protocol: { configs, personaRuns, repeat: repeats, jobs: jobsCount, noJudge: opt["no-judge"], rappelTools: "none", judgeProtocol: 2, hookReceipts: true, cloudConnectors: false, recallInstructions: RECALL_INSTRUCTIONS, leadLaunch: LEAD_LAUNCH }, paid: true, dryRun,
  });
  const out = listRun.outDir;
  const bankIds: Partial<Record<Config, string>> = {};
  for (const config of ["C", "D"] as const) if (configs.includes(config)) bankIds[config] = listRun.bankId(config);

  const previewCwds = Object.fromEntries(CONFIGS.map((config) => [config, join(tmpdir(), "orch-bench-" + listRun.id + "-" + config)])) as Record<Config, string>;
  const previewStates = Object.fromEntries(configs.map((config) => [config, listRun.stateDirFor(config)])) as Record<Config, string>;
  const previewBrains: Partial<Record<Config, string>> = {};
  const previewSettings: Partial<Record<Config, string>> = {};
  for (const config of ["C", "D"] as const) if (configs.includes(config)) previewBrains[config] = join(out, "brain-" + config + ".yaml");
  for (const config of configs) if (config !== "A") previewSettings[config] = join(out, "settings", config + ".json");
  const preview: Ctx = {
    run: listRun, out, cwds: previewCwds, sourceCwd: previewCwds[configs[0]], sourceConfig: configs[0], stateDirs: previewStates, binPaths: {},
    benchBrains: previewBrains, leadSettings: previewSettings, llmConfig: join(out, "catalog/llm.yaml"), claudeExecutable: "claude", brainSnapshot: snapshotText ? join(out, "brain-snapshot.json") : undefined,
    brainProject: brainProject || undefined,
  };
  const list = jobs(cases, configs, preview, personaRuns, repeats);
  const runsPlanned = list.reduce((n, job) => n + job.runs, 0);
  log(cases.length + " cases, configs " + configs.join("") + ", " + list.length + " jobs, " + runsPlanned + " claude runs, run " + listRun.id + ", out " + out);
  if (dryRun) {
    for (const job of list) process.stdout.write(job.label + "\n");
    process.stdout.write("run " + listRun.id + " (no files written)\n");
    return;
  }

  const executable = executableFingerprint();
  const cwds = addWorktrees(listRun, configs, source.revision);
  const stateDirs = {} as Record<Config, string>;
  const benchBrains: Partial<Record<Config, string>> = {};
  const leadSettings: Partial<Record<Config, string>> = {};
  const leadDenied: Partial<Record<Config, string[]>> = {};
  const binPaths: Partial<Record<Config, string>> = {};
  const turns: Run[] = [];
  const extra: Record<string, string> = {};
  const scores: Record<string, Record<string, Verdict | "missing">> = {};
  const observations: Array<{ caseId: string; config: string; attempt: number; quality?: number | null; cost?: number | null; latencyMs?: number | null; error?: string }> = [];
  let hconfig: ReturnType<typeof loadHindsightConfig> | undefined;
  const bank = bankIds.C;
  const ownedBanks = bank ? [bank, bank + "-" + PROJECT] : [];
  let before: HindsightUsage | undefined;
  let seedUsage: HindsightUsage | undefined;
  let afterUsage: HindsightUsage | undefined;
  let costComplete = true;
  const ctx: Ctx = {
    run: listRun, out, cwds, sourceCwd: cwds[configs[0]], sourceConfig: configs[0], stateDirs, binPaths, benchBrains, leadSettings, leadDenied,
    llmConfig: join(out, "catalog/llm.yaml"), claudeExecutable: executable.path,
    brainSnapshot: snapshotText ? join(out, "brain-snapshot.json") : undefined, brainProject: brainProject || undefined,
  };

  try {
    for (const config of configs) stateDirs[config] = listRun.stateDirFor(config);
    listRun.writeArtifact("catalog/llm.yaml", llmContext.configText);
    for (const config of configs) stageLlmSelection(llmContext, stateDirs[config]);
    listRun.writeJsonArtifact("llm-manifest.json", { configSource: llmContext.configSource, configSha256: llmContext.configSha256, selectionPresent: llmContext.selection.present, selectionSha256: llmContext.selection.sha256, selectedProviders: llmContext.selectedProviders });
    if (opt.judge) listRun.writeArtifact("runs.jsonl", oldRuns);
    else listRun.writeArtifact("runs.jsonl", "");
    if (snapshotText) listRun.writeArtifact("brain-snapshot.json", snapshotText);
    for (const config of ["C", "D"] as const) if (configs.includes(config)) {
      const bankForConfig = bankIds[config]!;
      const overrides = hindsightRetainOverride(opt.hindsight, false);
      const artifact = "brain-" + config + ".yaml";
      listRun.writeArtifact(artifact, benchBrainYaml(configText, bankForConfig, overrides));
      benchBrains[config] = join(out, artifact);
    }
    if (configs.includes("C") && !opt.judge) hconfig = loadHindsightConfig(benchBrains.C!);
    if (!opt.judge) for (const config of configs) if (config !== "A") stageLeadContext(leadContext, stateDirs[config]);
    listRun.writeJsonArtifact("context-manifest.json", Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, { present: file.present, sha256: file.sha256 }])));

    const settingsHashes: Partial<Record<Config, string>> = {};
    const promptHashes: Partial<Record<Config, string>> = {};
    const cliShimHashes: Partial<Record<Config, Record<string, string>>> = {};
    for (const config of configs) {
      if (config !== "A") {
        const staged = await stageLeadSettings(cwds[config], config, listRun);
        leadSettings[config] = staged.path;
        settingsHashes[config] = staged.settingsHash;
        promptHashes[config] = staged.promptHash;
        leadDenied[config] = staged.denied;
      }
      const shims = stageCliShims(cwds[config], config, listRun);
      binPaths[config] = shims.path;
      cliShimHashes[config] = shims.hashes;
    }
    listRun.writeJsonArtifact("provenance.json", {
      source, executable, dependencyLockSha256: createHash("sha256").update(lockText).digest("hex"),
      corpus: createHash("sha256").update(corpusText).digest("hex"),
      brainSnapshotSha256: snapshotText ? createHash("sha256").update(snapshotText).digest("hex") : null,
      leadContext: Object.fromEntries(Object.entries(leadContext.files).map(([name, file]) => [name, file.sha256])),
      settings: settingsHashes, leadLaunch: LEAD_LAUNCH, leadPrompts: promptHashes, leadDisallowedTools: leadDenied, cliShims: cliShimHashes,
      llm: { configSource: llmContext.configSource, configSha256: llmContext.configSha256, selectionSha256: llmContext.selection.sha256, selectedProviders: llmContext.selectedProviders },
    });

    if (opt.judge) {
    const result = await judge(out, cases, ctx);
      Object.assign(scores, result);
    } else {
      if (configs.includes("C") && bank && hconfig) {
        const hbase = hconfig.url.replace(/\/$/, "");
        for (const ownedBank of ownedBanks) {
          const ensured = await ensureBank(hconfig, ownedBank);
          if (!ensured.ok) throw new Error("bank " + ownedBank + ": " + ensured.error);
        }
        if (opt["no-seed"]) {
          extra["seed"] = "skipped; run-owned empty bank";
        } else {
          const store = snapshotMem(join(out, "brain-snapshot.json"), { includeTranscripts: true });
          const seeded = await seedHindsight(hconfig, bank, {
            sourceState, manifestState: listRun.stateDirFor("seed-C"), full: true, concurrency: jobsCount,
            store, includeExhaust: false, log,
          });
          extra["seed"] = seeded.notes + " frozen notes, " + seeded.failed + " failed";
          if (seeded.failed) throw new Error("Hindsight seed failed for " + seeded.failed + " item(s); run " + listRun.id + " is incomplete");
        }
        const busy = await drainOwnedBanks(hbase, ownedBanks);
        if (busy) throw new Error("run bank " + bank + " still has " + busy + " queued operation(s) before prompts");
        seedUsage = await exactOwnedBankUsage(hbase, ownedBanks);
        before = seedUsage;
      }
      const hookConfig = configs.includes("C") ? "C" : configs.includes("D") ? "D" : undefined;
      if (hookConfig) {
        extra["latence hook prompt-submit (médiane, 10 appels)"] = await hookLatency(ctx, hookConfig, "prompt-submit") + " ms";
        extra["latence hook session-start (médiane, 10 appels)"] = await hookLatency(ctx, hookConfig, "session-start") + " ms";
      }
      const started = Date.now();
      await pool(list, jobsCount, async (job) => { await job.run(); });
      extra["durée des runs"] = Math.round((Date.now() - started) / 60_000) + " min, " + jobsCount + " en parallèle";
      extra["notes orch mem du banc (jamais dans la vraie mémoire)"] = sandboxSummary(Object.fromEntries(configs.map((config) => [config, join(out, "mem-" + config)])));
      const measured = readJsonl(join(out, "runs.jsonl")) as unknown as Run[];
      for (const config of ["C", "D"] as const) if (configs.includes(config)) {
        assertHookReceipts(stateDirs[config], listRun.id, config === "C" ? "hindsight" : "brain", measured.filter((row) => row.config === config && !row.error).map((row) => row.session));
      }
      if (!opt["no-judge"]) Object.assign(scores, await judge(out, cases, ctx));
    }
  } finally {
    cleanupWorktrees(cwds, configs);
  }

  const runs = readJsonl(join(out, "runs.jsonl")) as unknown as Run[];
  if (before && hconfig && bank) {
    const hbase = hconfig.url.replace(/\/$/, "");
    const left = await drainOwnedBanks(hbase, ownedBanks);
    if (left) {
      costComplete = false;
      extra["couverture coût Hindsight"] = "incomplète: " + left + " opérations toujours en attente";
    }
    try { afterUsage = diffUsage(await exactOwnedBankUsage(hbase, ownedBanks), before); }
    catch (error) {
      costComplete = false;
      extra["couverture coût Hindsight"] = "incomplète: " + (error instanceof Error ? error.message : String(error));
    }
    if (afterUsage) {
      extra["coût Hindsight estimé C"] = PRICES_VERSION + ": " + afterUsage.llm_calls + " appels LLM, " + afterUsage.embed_calls + " embeddings, " + hindsightCost(afterUsage).toFixed(4) + " $";
      if (seedUsage) extra["coût seed Hindsight estimé C"] = PRICES_VERSION + ": " + hindsightCost(seedUsage).toFixed(4) + " $";
      listRun.writeJsonArtifact("hindsight.json", { pricingVersion: PRICES_VERSION, seedUsage, seedEstimatedUsd: seedUsage ? hindsightCost(seedUsage) : null, usage: afterUsage, estimatedUsd: hindsightCost(afterUsage), complete: costComplete });
    }
    extra["banks du banc supprimés"] = await dropOwnedBanks(hconfig, ownedBanks);
  }
  if (configs.some((config) => config === "B" || config === "C" || config === "D")) extra["comparabilité coût mémoire"] = "les embeddings à la demande du provider brain ne sont pas instrumentés; les coûts B/C/D totaux sont exclus des métriques comparatives";
  if (configs.includes("C")) extra["couverture coût C"] = "coût Hindsight estimé à part; embeddings brain non instrumentés";
  if (configs.includes("D")) extra["couverture coût D"] = "coût embeddings de requête brain non instrumenté";
  const successfulRuns = runs.filter((run) => !run.error);
  const runtimeModels = [...new Set(runs.flatMap((run) => run.model_ids ?? []))].sort();
  const modelIdentityComplete = successfulRuns.length > 0 && successfulRuns.every((run) => !!run.model_ids?.length);
  extra["modèles runtime"] = runtimeModels.length ? runtimeModels.join(", ") + (modelIdentityComplete ? "" : " (identité incomplète)") : "identités inconnues";
  const text = report(out, cases, configs, scores, extra);
  listRun.writeJsonArtifact("runtime-models.json", { models: runtimeModels, complete: modelIdentityComplete });
  const observationsOut = runs.map((run) => {
    const verdict = scores[run.case]?.[run.session];
    return {
      caseId: run.case + "-" + run.turn, config: run.config, attempt: run.attempt ?? 1,
      quality: verdict === "exact" ? 1 : verdict === "partial" ? 0.5 : verdict === "wrong" ? 0 : verdict === "missing" ? null : undefined,
      cost: run.config === "A" ? run.cost_usd : null,
      latencyMs: run.duration_ms, ...(run.error ? { error: run.error } : {}),
    };
  });
  listRun.finalize(observationsOut);
  process.stdout.write(text);
  if (!costComplete) throw new Error("Hindsight cost coverage is incomplete for run " + listRun.id);
}

if (import.meta.main) main().catch((e) => { log("failed: " + (e as Error).message); process.exit(1); });
