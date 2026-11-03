#!/usr/bin/env bun
// Duel bench: the same features, in the same order, on identical toy
// repositories, through three systems, to see which costs more, which is
// faster and which delivers better code:
//   claude  plain `claude -p`, one session resumed from feature to feature
//   kiba    native Kiba (`claude --agent kiba`, production hooks, memory off)
//   serve   orch serve: one task per feature, worker runtime A, VERIFY gate,
//           local delivery (serve-arm.ts)
// After each feature the bench judges every arm the same way: hidden
// acceptance test, full suite, files touched outside the feature's FILES and
// tests/, then an operator commit. The hidden tests are rerun at the end
// (regressions). Arms run one after another (no shared CPU or rate limit),
// in reversed order on even repetitions.
//   bun bench/duel/run.ts --dry-run [--arms claude,kiba,serve] [--tasks T2,T4]
//   bun bench/duel/run.ts --yes [--arms ...] [--tasks ...] [--reps N] [--model opus/medium] [--serve-rung sonnet/medium]
//   bun bench/duel/run.ts --report <run dir>
// Paid (Claude Code subscription quota): nothing starts without --yes.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSandbox } from "../../src/harness/harness.ts";
import { nativeKibaArgv } from "../../src/kiba/native.ts";
import { rungFor } from "../../src/kiba/rules.ts";
import { claudeWorkerSettings, outsideWrites } from "../../src/lanes/guard.ts";
import { inScope } from "../../src/lanes/route.ts";
import { taskKind } from "../../src/serve/engine.ts";
import { nativeReceipt } from "../../src/serve/workers.ts";
import type { ModelChoice } from "../../src/core/profile.ts";
import type { Task } from "../../src/core/tasks.ts";
import { createToyRepo, loadWorkload, type TaskSpec } from "../versus/workload.ts";
import { benchKiba, type ServeFeatureConfig, type ServeFeatureResult } from "./serve-arm.ts";

export type Arm = "claude" | "kiba" | "serve";
export const ARMS: Arm[] = ["claude", "kiba", "serve"];
// Mechanical and normal features: a risky one sends orch serve through a ship
// review by another harness (Codex), whose cost the Claude estimate misses.
export const DEFAULT_TASKS = ["T2", "T4", "T7", "T9", "T10"];
const VERIFY = "bun test";
const NUDGE = "Oui, vas-y : fais-le, jusqu'à ce que bun test soit vert.";
const FEATURE_TIMEOUT_MS = 20 * 60_000;
const BUDGET_USD = 3;
const STRIP = /^(ORCH_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/;

export interface FeatureRun {
  task: string; seconds: number; cost: number | null; costComplete: boolean; accepted: boolean; suiteGreen: boolean;
  outside: string[]; nudges: number; timedOut: boolean; models: string[]; escaped?: boolean; turns?: number;
  lanes?: number; delivered?: boolean; state?: string; executions?: number; failures?: number; error?: string;
}
export interface ArmRun { arm: Arm; rep: number; repo: string; features: FeatureRun[]; finalAccepted: Record<string, boolean>; error?: string }

// ---- Arms: argv and environment ------------------------------------------

export const choiceOf = (s = "opus/medium") => { const [model, effort] = s.split("/"); return { model: model!, effort: effort ?? "medium" }; };

function sandboxed(repo: string, writable: string[]): { sandbox: object; guard: { hooks: { PreToolUse: unknown[] } } & object } {
  const base = claudeSandbox(writable[0]) as { sandbox: Record<string, unknown> };
  const sandbox = { sandbox: { ...base.sandbox, filesystem: { allowWrite: writable } } };
  return { sandbox, guard: claudeWorkerSettings(repo, sandbox) as { hooks: { PreToolUse: unknown[] } } };
}

// Same transport, sandbox, scope guard and budget in both session arms; Agent
// (subagents) stays allowed in both, as in normal use.
export function sessionArgv(arm: "claude" | "kiba", repo: string, root: string, session: string, started: boolean, choice = choiceOf()): string[] {
  const extra = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--max-budget-usd", String(BUDGET_USD),
    ...(started ? ["--resume", session] : ["--session-id", session])];
  if (arm === "claude") {
    const { guard } = sandboxed(repo, [join(root, "tmp")]);
    return ["claude", "--model", choice.model, "--effort", choice.effort, "--permission-mode", "acceptEdits", "--settings", JSON.stringify(guard), ...extra];
  }
  // Kiba may start lanes: its sandbox may also write the run's orch state.
  const { sandbox, guard } = sandboxed(repo, [join(root, "tmp"), join(root, "state"), join(root, "orch-home")]);
  const argv = nativeKibaArgv({ model: choice.model, effort: choice.effort as ModelChoice["effort"], permission_mode: "acceptEdits" }, extra);
  const i = argv.indexOf("--settings") + 1;
  const settings = JSON.parse(argv[i]!) as { hooks?: { PreToolUse?: unknown[] } };
  argv[i] = JSON.stringify({ ...settings, ...sandbox, hooks: { ...settings.hooks, PreToolUse: [...(settings.hooks?.PreToolUse ?? []), ...guard.hooks.PreToolUse] } });
  return argv;
}

// The caller's environment minus orch, API keys (subscription login, as an
// operator runs) and forge tokens; state, orch home and temp under the run root.
export function armEnv(arm: Arm, root: string, runId: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  Object.assign(env, { TMPDIR: join(root, "tmp"), ORCH_BENCH_RUN: runId });
  if (arm === "claude") return env;
  Object.assign(env, { ORCH_STATE: join(root, "state"), ORCH_HOME: join(root, "orch-home"), ORCH_MEM_SANDBOX: join(root, "mem"), ORCH_MEMORY: "off" });
  if (arm === "kiba") Object.assign(env, { ORCH_LEAD: "1", ORCH_HARNESS: "claude", ORCH_CONDUCTOR: "native" });
  else env.ORCH_SERVE_POLICY = join(root, "serve.yaml");
  return env;
}

export const sessionPrompt = (t: TaskSpec) =>
  `${t.objective} Fichiers : ${t.files.join(", ")}. Ajoute un test dans tests/ qui couvre ce comportement. Termine quand \`${VERIFY}\` est vert, sans commit, puis réponds en une ligne.`;
export const serveObjective = (t: TaskSpec) => `${t.objective} Ajoute un test dans tests/ qui couvre ce comportement.`;
export const serveFiles = (t: TaskSpec) => [...t.files, "tests/**"];

// ---- One stream-json claude process ----------------------------------------

interface Step { seconds: number; cost: number | null; costComplete: boolean; model?: string; session?: string; escaped: boolean; turns: number; timedOut: boolean; error?: string }

async function claudeStep(argv: string[], env: Record<string, string>, repo: string, text: string, dir: string, session: string): Promise<Step> {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "model.jsonl"), started = Date.now();
  writeFileSync(log, "");
  const err = openSync(join(dir, "model.stderr"), "w");
  const child = spawn(argv[0]!, argv.slice(1), { cwd: repo, env, detached: true, stdio: ["pipe", "pipe", err] });
  closeSync(err);
  const results: any[] = [];
  let model: string | undefined, observed: string | undefined, buf = "";
  const onLine = (line: string) => {
    try {
      const e = JSON.parse(line);
      if (e.type === "result") results.push(e);
      if (e.type === "system" && e.subtype === "init") { model = e.model; observed = e.session_id; }
    } catch {}
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    appendFileSync(log, s);
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stdin!.on("error", () => {});
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => { if (buf) onLine(buf); resolve(code ?? (signal ? 128 : null)); });
  });
  const pid = child.pid ?? -1;
  const kill = (sig: NodeJS.Signals) => { if (pid > 1) try { process.kill(-pid, sig); } catch {} };
  child.stdin!.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([exited, new Promise<number>((resolve) => { timer = setTimeout(() => { kill("SIGTERM"); resolve(124); }, FEATURE_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
  kill("SIGKILL");
  const escaped = outsideWrites("claude", readFileSync(log, "utf8"), repo).written.length > 0;
  const r = nativeReceipt(results, code, session, observed, escaped, model);
  return { seconds: (Date.now() - started) / 1000, cost: r.cost ?? null, costComplete: r.costComplete === true, model, session: observed, escaped,
    turns: results.reduce((n, x) => n + (x.num_turns ?? 0), 0), timedOut: code === 124, ...(r.error ? { error: r.error } : {}) };
}

// ---- Judge (same for every arm) --------------------------------------------

function sh(cwd: string, argv: string[]): { ok: boolean; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: 180_000, env });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const head = (repo: string) => sh(repo, ["git", "rev-parse", "HEAD"]).out.trim();
const dirty = (repo: string, since: string) => sh(repo, ["git", "status", "--porcelain"]).out.trim().length > 0 || head(repo) !== since;

function hidden(repo: string, t: TaskSpec): boolean {
  const dir = join(repo, "tests", "accept");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}.test.ts`), t.accept);
  try { return sh(repo, ["bun", "test", `./tests/accept/${t.id}.test.ts`]).ok; } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Hidden acceptance, full suite, scope since the feature started, then the
// operator's commit so the next feature starts from a clean tree.
export function judge(repo: string, t: TaskSpec, since: string): { accepted: boolean; suiteGreen: boolean; outside: string[] } {
  const accepted = hidden(repo, t);
  const suiteGreen = sh(repo, ["bun", "test"]).ok;
  sh(repo, ["git", "add", "-A"]);
  const touched = sh(repo, ["git", "diff", "--cached", "--name-only", since]).out.split("\n").filter(Boolean);
  sh(repo, ["git", "-c", "user.name=orch-bench", "-c", "user.email=bench@localhost", "commit", "-q", "--no-verify", "--allow-empty", "-m", `bench: ${t.id}`]);
  return { accepted, suiteGreen, outside: touched.filter((f) => !inScope(f, serveFiles(t))) };
}

export function finalAccept(repo: string, tasks: TaskSpec[]): Record<string, boolean> {
  return Object.fromEntries(tasks.map((t) => [t.id, hidden(repo, t)]));
}

// ---- Arm runners ------------------------------------------------------------

function lanesOf(root: string): { runs: number; cost: number; complete: boolean } {
  const file = join(root, "state", "lanes.jsonl");
  const acc = { runs: 0, cost: 0, complete: true };
  if (!existsSync(file)) return acc;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line) as { kind?: string; usage?: { costUsd?: number } };
      if (r.kind !== "run") continue;
      acc.runs++;
      if (typeof r.usage?.costUsd === "number") acc.cost += r.usage.costUsd; else acc.complete = false;
    } catch {}
  }
  return acc;
}

async function runSessionArm(arm: "claude" | "kiba", root: string, repo: string, tasks: TaskSpec[], logs: string, env: Record<string, string>, choice: { model: string; effort: string }): Promise<FeatureRun[]> {
  const session = randomUUID();
  let started = false;
  const out: FeatureRun[] = [];
  for (const t of tasks) {
    const since = head(repo), lanesBefore = lanesOf(root);
    const steps: Step[] = [];
    const step = async (text: string, name: string) => {
      const s = await claudeStep(sessionArgv(arm, repo, root, session, started, choice), env, repo, text, join(logs, name), session);
      if (s.session === session) started = true;
      steps.push(s);
    };
    await step(sessionPrompt(t), t.id);
    let nudges = 0;
    if (!dirty(repo, since) && !steps[0]!.timedOut) { nudges++; await step(NUDGE, `${t.id}-nudge`); }
    const lanes = lanesOf(root), j = judge(repo, t, since);
    const laneCost = lanes.cost - lanesBefore.cost;
    const run: FeatureRun = {
      task: t.id, seconds: steps.reduce((n, s) => n + s.seconds, 0),
      cost: steps.reduce((n, s) => n + (s.cost ?? 0), 0) + laneCost, costComplete: steps.every((s) => s.costComplete) && lanes.complete,
      ...j, nudges, timedOut: steps.some((s) => s.timedOut), models: [...new Set(steps.map((s) => s.model).filter((m): m is string => !!m))],
      escaped: steps.some((s) => s.escaped), turns: steps.reduce((n, s) => n + s.turns, 0), lanes: lanes.runs - lanesBefore.runs,
      ...(steps.find((s) => s.error) ? { error: steps.find((s) => s.error)!.error } : {}),
    };
    out.push(run);
    console.log(line(arm, run));
  }
  return out;
}

async function runServeArm(root: string, repo: string, tasks: TaskSpec[], logs: string, env: Record<string, string>, rung?: { model: string; effort: string }): Promise<FeatureRun[]> {
  const out: FeatureRun[] = [];
  for (const t of tasks) {
    const since = head(repo), dir = join(logs, t.id);
    mkdirSync(dir, { recursive: true });
    const config: ServeFeatureConfig = { root: join(root, "state"), repo, base: "develop", objective: serveObjective(t), files: serveFiles(t), verify: VERIFY,
      risky: t.size === "risky", timeoutMs: FEATURE_TIMEOUT_MS, nudge: NUDGE, ...(rung ? { rung } : {}), out: join(dir, "result.json"), log: join(dir, "engine.log") };
    writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
    const p = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "serve-arm.ts"), join(dir, "config.json")], { cwd: repo, env, encoding: "utf8", timeout: FEATURE_TIMEOUT_MS + 180_000 });
    writeFileSync(join(dir, "driver.log"), `${p.stdout ?? ""}${p.stderr ?? ""}`);
    let r: Partial<ServeFeatureResult> & { error?: string } = { error: `serve driver exit ${p.status}` };
    try { r = JSON.parse(readFileSync(config.out, "utf8")); } catch {}
    const j = judge(repo, t, since);
    const run: FeatureRun = {
      task: t.id, seconds: r.seconds ?? 0, cost: r.cost ?? null, costComplete: r.costComplete === true, ...j, nudges: r.nudges ?? 0,
      timedOut: r.timedOut === true, models: r.models ?? [], delivered: r.delivered === true, state: r.state, executions: r.executions, failures: r.failures,
      ...(r.error ? { error: r.error } : {}),
    };
    out.push(run);
    console.log(line("serve", run));
  }
  return out;
}

const line = (arm: Arm, r: FeatureRun) =>
  `[${arm}] ${r.task} ${r.accepted ? "OK" : "ÉCHEC"} ${r.seconds.toFixed(0)} s ${r.cost === null ? "?" : r.cost.toFixed(3)} $${r.costComplete ? "" : " (partiel)"}${r.outside.length ? ` hors périmètre : ${r.outside.join(",")}` : ""}${r.error ? ` erreur : ${r.error.slice(0, 120)}` : ""}`;

// ---- Summary and report ------------------------------------------------------

export interface ArmSummary {
  arm: Arm; reps: number; features: number; accepted: number; finalAccepted: number; suiteGreen: number; outside: number; nudges: number; timeouts: number;
  cost: number; costComplete: boolean; seconds: number; costPerFeature: number; secondsPerFeature: number; models: string[];
  costVsClaude?: number; timeVsClaude?: number;
}

export function summarize(runs: ArmRun[]): ArmSummary[] {
  const out: ArmSummary[] = [];
  for (const arm of ARMS) {
    const mine = runs.filter((r) => r.arm === arm);
    if (!mine.length) continue;
    const f = mine.flatMap((r) => r.features);
    const n = Math.max(1, f.length);
    const cost = f.reduce((s, x) => s + (x.cost ?? 0), 0), seconds = f.reduce((s, x) => s + x.seconds, 0);
    out.push({ arm, reps: mine.length, features: f.length, accepted: f.filter((x) => x.accepted).length,
      finalAccepted: mine.reduce((s, r) => s + Object.values(r.finalAccepted).filter(Boolean).length, 0),
      suiteGreen: f.filter((x) => x.suiteGreen).length, outside: f.reduce((s, x) => s + x.outside.length, 0),
      nudges: f.reduce((s, x) => s + x.nudges, 0), timeouts: f.filter((x) => x.timedOut).length,
      cost, costComplete: f.every((x) => x.costComplete && x.cost !== null), seconds, costPerFeature: cost / n, secondsPerFeature: seconds / n,
      models: [...new Set(f.flatMap((x) => x.models))] });
  }
  const ref = out.find((s) => s.arm === "claude");
  for (const s of out) if (ref && ref.cost > 0 && ref.seconds > 0) { s.costVsClaude = s.cost / ref.cost - 1; s.timeVsClaude = s.seconds / ref.seconds - 1; }
  return out;
}

const pct = (x?: number) => x === undefined ? "" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)} %`;

export function renderReport(doc: { runId: string; tasks: string[]; reps: number; choice: string; serveRung: string; runs: ArmRun[] }): string {
  const sum = summarize(doc.runs);
  const rows = sum.map((s) => `| ${s.arm} | ${s.accepted}/${s.features} | ${s.finalAccepted}/${s.features} | ${s.suiteGreen}/${s.features} | ${s.outside} | ${s.cost.toFixed(3)} $${s.costComplete ? "" : " (min.)"} | ${pct(s.costVsClaude)} | ${s.seconds.toFixed(0)} s | ${pct(s.timeVsClaude)} | ${s.models.join(", ")} |`);
  const per = doc.runs.flatMap((r) => r.features.map((f) => `| ${r.rep} | ${r.arm} | ${f.task} | ${f.accepted ? "oui" : "non"} | ${f.suiteGreen ? "oui" : "non"} | ${f.outside.join(", ")} | ${f.cost === null ? "?" : f.cost.toFixed(3)}${f.costComplete ? "" : " (min.)"} | ${f.seconds.toFixed(0)} | ${f.nudges} | ${f.lanes ?? ""}${f.state ? ` ${f.state}` : ""} | ${(f.error ?? "").slice(0, 80)} |`));
  return [
    `# Banc duel ${doc.runId}`, "",
    `Tâches : ${doc.tasks.join(", ")}. Répétitions : ${doc.reps}. Modèle des sessions : ${doc.choice}. Échelle orch serve : ${doc.serveRung}.`, "",
    "| Bras | Acceptation cachée | Finale (régressions) | Suite verte | Fichiers hors périmètre | Coût | vs claude | Temps | vs claude | Modèles |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    "Coût : estimation de Claude Code (deltas par résultat, sous-agents compris), plus le coût des lanes du ledger pour Kiba ; \"(min.)\" signale un coût incomplet. Temps : du prompt à la fin du travail, jugement exclu.", "",
    "| Rép. | Bras | Tâche | Acceptée | Suite | Hors périmètre | Coût $ | Secondes | Relances | Lanes / état | Erreur |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...per, "",
  ].join("\n");
}

// ---- CLI ----------------------------------------------------------------------

const stateRoot = () => process.env.ORCH_STATE ?? join(process.env.HOME ?? homedir(), ".local", "state", "orch");

export function orderFor(rep: number, arms: Arm[]): Arm[] { return rep % 2 ? [...arms] : [...arms].reverse(); }

async function main(args: string[]): Promise<number> {
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const report = opt("--report");
  if (report) {
    const doc = JSON.parse(readFileSync(join(report, "results.json"), "utf8"));
    const md = renderReport(doc);
    writeFileSync(join(report, "report.md"), md);
    console.log(md);
    return 0;
  }
  const w = loadWorkload();
  const ids = opt("--tasks")?.split(",") ?? DEFAULT_TASKS;
  const tasks = ids.map((id) => { const t = w.tasks.find((x) => x.id === id); if (!t) throw new Error(`unknown task ${id} (T1..T${w.tasks.length})`); return t; });
  const arms = (opt("--arms")?.split(",") ?? ARMS) as Arm[];
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a} (${ARMS.join(", ")})`);
  const reps = Number(opt("--reps") ?? 1);
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps: a positive integer");
  const choice = choiceOf(opt("--model"));
  const rung = opt("--serve-rung") ? choiceOf(opt("--serve-rung")) : undefined;
  const kiba = benchKiba(rung);
  const rungs = tasks.map((t) => {
    const fake = { objective: serveObjective(t), mandate: { files: serveFiles(t), risk: t.size === "risky" ? "risky" : "normal" } } as Task;
    const step = rungFor(taskKind(fake), 0, kiba);
    return `${t.id}=${step.to === "lane" ? `${step.rung.model}/${step.rung.effort}` : "operator"}`;
  });
  if (args.includes("--dry-run")) {
    const root = "/tmp/orch-duel-<run>/<rep>-<arm>";
    console.log(JSON.stringify({
      tasks: tasks.map((t) => ({ id: t.id, size: t.size, files: t.files })), arms, reps, sessions: `${choice.model}/${choice.effort}`, serveRungs: rungs,
      argv: Object.fromEntries((["claude", "kiba"] as const).filter((a) => arms.includes(a)).map((a) => [a, sessionArgv(a, `${root}/repo`, root, "<session>", false, choice).map((x) => x.length > 160 ? `${x.slice(0, 157)}...` : x)])),
      envAdded: Object.fromEntries(arms.map((a) => { const e = armEnv(a, root, "<run>"); return [a, Object.keys(e).filter((k) => !(k in process.env) || /^ORCH_|^TMPDIR$/.test(k)).sort()]; })),
      paid: `${tasks.length * arms.length * reps} feature runs; order of magnitude 0.1 to 0.5 USD each (estimate, not a quote)`,
    }, null, 2));
    return 0;
  }
  if (!args.includes("--yes")) { console.error("paid bench (Claude Code quota): run --dry-run first, then again with --yes"); return 2; }
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = opt("--out") ?? join(stateRoot(), "bench", "duel", runId);
  mkdirSync(outDir, { recursive: true });
  const runs: ArmRun[] = [];
  const save = () => writeFileSync(join(outDir, "results.json"), JSON.stringify({ runId, tasks: ids, reps, choice: `${choice.model}/${choice.effort}`, serveRung: rung ? `${rung.model}/${rung.effort}` : `profil kiba (${rungs.join(", ")})`, runs }, null, 2) + "\n");
  console.log(`banc duel ${runId}: ${arms.join(", ")} x ${ids.join(", ")} x ${reps}; résultats ${outDir}`);
  for (let rep = 1; rep <= reps; rep++) {
    for (const arm of orderFor(rep, arms)) {
      const root = join("/tmp", `orch-duel-${runId}`, `${rep}-${arm}`);
      for (const d of ["tmp", "state", "orch-home", "mem"]) mkdirSync(join(root, d), { recursive: true });
      const repo = createToyRepo(w, "toy-", root);
      sh(repo, ["git", "checkout", "-q", "-b", "develop"]);
      const logs = join(outDir, `${rep}-${arm}`), env = armEnv(arm, root, runId);
      const run: ArmRun = { arm, rep, repo, features: [], finalAccepted: {} };
      runs.push(run);
      try {
        run.features = arm === "serve" ? await runServeArm(root, repo, tasks, logs, env, rung) : await runSessionArm(arm, root, repo, tasks, logs, env, choice);
      } catch (e) { run.error = String(e); console.error(`[${arm}] ${run.error}`); }
      run.finalAccepted = finalAccept(repo, tasks);
      save();
    }
  }
  const md = renderReport(JSON.parse(readFileSync(join(outDir, "results.json"), "utf8")));
  writeFileSync(join(outDir, "report.md"), md);
  console.log(md);
  return 0;
}

if (import.meta.main) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
