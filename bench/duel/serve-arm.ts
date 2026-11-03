// One feature through orch serve, as production runs it: an operator task
// (fixed mandate), worker runtime A (`claude -p --agent worker`, resumable),
// VERIFY through `orch task adopt`, the ladder and watchdog, then the outbox.
// Only the publisher differs: local delivery (`lane integrate --branch` with
// no push and no PR), then the bench merges the delivered branch into the toy
// repository as the operator would. The parent (run.ts) sets the environment:
// ORCH_STATE, ORCH_HOME and TMPDIR under the run root, no forge token.
//   bun --no-env-file bench/duel/serve-arm.ts <config.json>
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { git } from "../../src/core/git.ts";
import { loadProfile } from "../../src/core/profile.ts";
import { newTaskId, tasksDir, TaskStore, type Task } from "../../src/core/tasks.ts";
import { DEFAULT_KIBA, validateKibaConfig, type KibaConfig } from "../../src/kiba/rules.ts";
import { admitOperator, DEFAULT_SERVE_POLICY, pass, type EngineDeps, type Publisher, type RunState } from "../../src/serve/engine.ts";

export interface ServeFeatureConfig {
  root: string; repo: string; base: string; objective: string; files: string[]; verify: string; risky: boolean;
  timeoutMs: number; nudge: string; rung?: { model: string; effort: string }; out: string; log: string;
}
export interface ServeFeatureResult {
  task: string; state: string; delivered: boolean; branch?: string; merged: boolean; seconds: number;
  cost: number | null; costComplete: boolean; models: string[]; executions: number; verifications: number; reviews: number;
  failures: number; nudges: number; timedOut: boolean; evidence: string[]; error?: string;
}

// The production publisher, minus the forge: same gate and local commit.
export const localPublisher: Publisher = {
  async deliver(e) {
    const { laneIntegrate } = await import("../../src/lane.ts");
    const r = await laneIntegrate(e.payload.lane, { branch: e.payload.branch, message: e.payload.message, push: false, pr: false });
    const status = /^STATUS: (\S+)/m.exec(r.report)?.[1];
    if (r.integrated) return { done: true, receipt: { branch: e.payload.branch, commit: /^COMMIT: ([0-9a-f]+)/m.exec(r.report)?.[1] ?? "" } };
    return { done: false, error: r.report.trim(), final: status === "refused" && !/held the lock/.test(r.report) };
  },
  async comment() { return { done: false, error: "duel bench: no forge" }; },
  async notify() { return { done: true, receipt: { sent: "no (duel bench)" } }; },
};

export function benchKiba(rung?: { model: string; effort: string }): KibaConfig {
  let kiba = DEFAULT_KIBA;
  try { kiba = validateKibaConfig(loadProfile("kiba").kiba ?? {}); } catch {}
  // --serve-rung pins every kind to one rung (same model as the other arms).
  return rung ? { ...kiba, ladder: { mechanical: rung, normal: rung, risky: rung } } : kiba;
}

const WAITING = new Set(["ended", "blocked", "person/review", "person/answer"]);

async function operator(store: TaskStore, root: string, ev: Parameters<TaskStore["receive"]>[0]): Promise<string> {
  await store.receive(ev);
  return admitOperator(store, store.read().events[ev.key], DEFAULT_SERVE_POLICY.version, root);
}

export async function runServeFeature(c: ServeFeatureConfig): Promise<ServeFeatureResult> {
  const store = new TaskStore(tasksDir(c.root));
  const lines: string[] = [];
  const d: EngineDeps = {
    root: c.root, store, policy: { ...DEFAULT_SERVE_POLICY, router: "off", notify: false }, publisher: localPublisher,
    router: { classify: async () => { throw new Error("duel bench: the router is never called for an operator task"); } },
    gh: () => null, kiba: benchKiba(c.rung), channels: [], log: (l) => lines.push(`${new Date().toISOString()} ${l}`),
  };
  const id = newTaskId(), started = Date.now();
  const got = await operator(store, c.root, { key: `op-${randomUUID()}`, source: "operator", sender: "operator-cli", kind: "request", task: id, thread: `task:${id}`, text: c.objective, repo: c.repo,
    request: { objective: c.objective, mandate: { repo: c.repo, files: c.files, verify: c.verify, risk: c.risky ? "risky" : "normal", baseBranch: c.base, source: "operator", sender: "operator-cli" } } });
  if (got !== "created") throw new Error(`task not created: ${got}`);
  const run: RunState = { once: false, attempted: new Map(), polledAt: 0, recovered: false };
  let nudges = 0, timedOut = false, stopAt = 0;
  for (;;) {
    await pass(d, run);
    const t = store.read().tasks[id]!;
    const idle = !Object.values(store.read().jobs).some((j) => j.task === id && ["planned", "running"].includes(j.status));
    // The session arms get one nudge when nothing changed; the same here, on
    // a question or a no-change end (an ended task resumes on a new message).
    if (!stopAt && idle && nudges === 0 && (t.state === "person/answer" || t.state === "ended" && t.deliveredRevision === 0)) {
      nudges++;
      await operator(store, c.root, { key: `op-${randomUUID()}`, source: "operator", sender: "operator-cli", kind: "follow", task: id, thread: t.thread, text: c.nudge });
      continue;
    }
    const busy = Object.values(store.read().jobs).some((j) => j.task === id && ["planned", "running"].includes(j.status));
    if (stopAt && !busy) break;
    if (!stopAt && WAITING.has(t.state) && !busy) break;
    if (!stopAt && Date.now() - started > c.timeoutMs) {
      timedOut = true; stopAt = Date.now();
      await operator(store, c.root, { key: `op-${randomUUID()}`, source: "operator", sender: "operator-cli", kind: "stop", task: id, thread: t.thread, text: "stop" });
    }
    if (stopAt && Date.now() - stopAt > 60_000) break;
    await Bun.sleep(1000);
  }
  const seconds = (Date.now() - started) / 1000;
  const s = store.read(), t: Task = s.tasks[id]!;
  const jobs = Object.values(s.jobs).filter((j) => j.task === id);
  const paid = jobs.filter((j) => j.kind !== "verify");
  const costs = paid.map((j) => j.receipt?.cost);
  const effect = Object.values(s.outbox).find((e) => e.task === id && e.kind === "deliver" && e.status === "done");
  const branch = effect?.receipt?.branch;
  let merged = false, error: string | undefined;
  if (branch) {
    const m = git(c.repo, "merge", "-q", "--ff-only", branch);
    merged = m.ok;
    if (!m.ok) error = `merge of ${branch} failed: ${m.err || m.out}`;
  }
  writeFileSync(c.log, `${lines.join("\n")}\n`);
  return {
    task: id, state: t.state, delivered: t.deliveredRevision > 0, branch, merged, seconds,
    // A job without a receipt cost (interrupted, review by another harness) makes the total a lower bound.
    cost: costs.reduce<number>((n, x) => n + (typeof x === "number" ? x : 0), 0), costComplete: costs.every((x) => typeof x === "number"),
    models: [...new Set(jobs.map((j) => j.receipt?.model).filter((m): m is string => !!m))],
    executions: jobs.filter((j) => j.kind === "execute").length, verifications: jobs.filter((j) => j.kind === "verify").length,
    reviews: jobs.filter((j) => j.kind === "review").length, failures: t.failures, nudges, timedOut,
    evidence: t.evidence.slice(-8).map((e) => `${e.kind}: ${e.text.split("\n")[0]!.slice(0, 160)}`), ...(error ? { error } : {}),
  };
}

if (import.meta.main) {
  const c = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as ServeFeatureConfig;
  runServeFeature(c).then((r) => { writeFileSync(c.out, JSON.stringify(r, null, 2) + "\n"); process.exit(0); },
    (e) => { writeFileSync(c.out, JSON.stringify({ error: String(e) }) + "\n"); process.exit(1); });
}
