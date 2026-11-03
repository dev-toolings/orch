// `orch serve`: the conductor v2 engine, deterministic. One pass admits the
// persisted events (rules first; the model router only for an ambiguous
// event that matches no task), supervises jobs (adopt live ones, mark dead
// ones interrupted with a recovery note, watchdog), plans the next step of
// each task (ladder, PAUSE) and drains the outbox, the only publisher. A
// follow-up on a thread a task owns goes straight to that task's session.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "../core/git.ts";
import { ghDefault, githubEvents, type Gh } from "../core/github.ts";
import { filterEvent, type InboundEvent } from "../core/inbound.ts";
import { pauseFile } from "../core/kill.ts";
import { stateDir } from "../core/paths.ts";
import { loadProfile } from "../core/profile.ts";
import { atomicJson, jobAlive, newTaskId, processStamp, tasksDir, terminateJob, TaskStore, type Effect, type Job, type Mandate, type StoredEvent, type Task, type TaskEvent } from "../core/tasks.ts";
import { heldThreadsAt, subscribeThreadAt, threadHolderAt } from "../core/threads.ts";
import { codeKind, DEFAULT_KIBA, rungFor, validateKibaConfig, type KibaConfig } from "../kiba/rules.ts";
import { killGroup, Watchdog, type LaneWatch } from "../kiba/watchdog.ts";
import { withFileLock } from "../lanes/lock.ts";
import { neutralizeWorktreeHooks } from "../lanes/protect.ts";
import { specFeatures } from "../lanes/route.ts";
import { statusEntries, statusPaths, testRepoRefusal } from "../lanes/worktree.ts";
import type { Channel } from "../presence/notify.ts";
import { loadPresenceConfig } from "../presence/presence.ts";
import { jobDir, type JobContext } from "./job.ts";
import { claudeRouter, type Router } from "./router.ts";

// ---- Policy: `~/.orch/policy/serve.yaml` (ORCH_SERVE_POLICY), operator owned.

// Per GitHub event kind. admit: work (a new task by rule when no task owns
// the thread); route: work for an owner, the router decides otherwise;
// context: attached to an owner's next revision only; ignore: dropped.
export type Admission = "admit" | "context" | "route" | "ignore";
export interface ServeRepo { path: string; files: string[]; verify: string; risk: "normal" | "risky"; base?: string }
export interface ServePolicy {
  version: number; router: "claude" | "off"; notify: boolean; worker_budget_usd: number; poll_seconds: number;
  repos: ServeRepo[]; github: { ci_fail: Admission; review: Admission };
}
export const DEFAULT_SERVE_POLICY: ServePolicy = {
  version: 1, router: "claude", notify: false, worker_budget_usd: 5, poll_seconds: 120, repos: [], github: { ci_fail: "context", review: "context" },
};
const ADMISSIONS: Admission[] = ["admit", "context", "route", "ignore"];

export const servePolicyPath = (env: NodeJS.ProcessEnv = process.env) => env.ORCH_SERVE_POLICY || join(env.HOME || "", ".orch", "policy", "serve.yaml");

export function loadServePolicy(path = servePolicyPath()): ServePolicy {
  if (!existsSync(path)) return DEFAULT_SERVE_POLICY;
  const raw = (Bun.YAML.parse(readFileSync(path, "utf8")) ?? {}) as Partial<ServePolicy> & { repos?: Partial<ServeRepo & { files: string | string[] }>[] };
  const p: ServePolicy = { ...DEFAULT_SERVE_POLICY, ...raw, github: { ...DEFAULT_SERVE_POLICY.github, ...raw.github }, repos: [] };
  const fail = (why: string) => { throw new Error(`serve policy ${path}: ${why}`); };
  if (!Number.isInteger(p.version) || p.version < 1) fail("version must be a positive integer");
  if (!["claude", "off"].includes(p.router)) fail("router: claude or off");
  for (const k of ["ci_fail", "review"] as const) if (!ADMISSIONS.includes(p.github[k])) fail(`github.${k}: ${ADMISSIONS.join(", ")}`);
  for (const r of raw.repos ?? []) {
    const files = typeof r.files === "string" ? splitFiles(r.files) : r.files ?? [];
    if (!r.path || !files.length || !r.verify) fail("each repo needs path, files and verify");
    p.repos.push({ path: resolve(r.path!), files, verify: r.verify!, risk: r.risk === "risky" ? "risky" : "normal", ...(r.base ? { base: r.base } : {}) });
  }
  return p;
}

export const splitFiles = (s: string) => s.split(/[,\n]/).map((f) => f.trim()).filter(Boolean);
const realRepo = (path: string) => { const top = git(path, "rev-parse", "--show-toplevel"); return top.ok ? top.out : resolve(path); };
export const branchThread = (repo: string, branch: string) => `branch:${realRepo(repo)}:${branch}`;
export const threadsFile = (root = stateDir()) => join(tasksDir(root), "threads.json");

// ---- Operator admission: deterministic, also run by the CLI so `task new`
// answers with its id and `task stop` takes effect with no engine running.

export async function admitOperator(store: TaskStore, ev: StoredEvent, policyVersion: number, root = stateDir()): Promise<string> {
  if (ev.kind === "request" && ev.request && ev.task) {
    const t = await store.createTask(ev.key, { id: ev.task, objective: ev.request.objective, mandate: { ...ev.request.mandate, policy: policyVersion }, thread: ev.thread }, "operator");
    if (!t) return "refused";
    await subscribeThreadAt(threadsFile(root), ev.thread, t.id);
    return "created";
  }
  const owner = ev.task ?? threadHolderAt(threadsFile(root), ev.thread);
  if (!owner) { await store.dispose(ev.key, "refused", "no task owns this thread", "operator"); return "refused"; }
  if (ev.kind === "stop") return (await store.stop(owner, ev.sender, ev.key)) ? "stopped" : "refused";
  return store.route(ev.key, owner, "input", "operator");
}

// ---- Engine.

export interface Publisher {
  deliver(e: Effect): Promise<{ done: true; receipt: Record<string, string> } | { done: false; error: string; final?: boolean }>;
  comment(e: Effect): Promise<{ done: true; receipt: Record<string, string> } | { done: false; error: string }>;
  notify(e: Effect): Promise<{ done: true; receipt: Record<string, string> } | { done: false; error: string }>;
}

export interface EngineDeps {
  root: string; store: TaskStore; policy: ServePolicy; router: Router; publisher: Publisher; gh: Gh;
  kiba: KibaConfig; channels: Channel[]; log: (line: string) => void;
  launch?: (job: Job) => number | undefined;
}

export interface RunState { once: boolean; attempted: Map<string, number>; launched?: Map<string, number>; polledAt: number; watchdog?: Watchdog; recovered: boolean }

const inbound = (ev: TaskEvent): InboundEvent => ({ id: ev.key, source: ev.source === "github" ? "ci" : ev.source === "operator" ? "operator" : "orch",
  kind: ev.kind === "review" || ev.kind === "follow" ? "comment" : ev.kind === "ci_fail" || ev.kind === "ci_pass" || ev.kind === "chatter" ? ev.kind : "comment",
  task: ev.thread, text: ev.text, repo: ev.repo });

// Chatter, green CI and status pings from outside: kept, never handled.
export function deterministicDrop(ev: TaskEvent): string | null {
  if (ev.source !== "github") return null;
  const v = filterEvent(inbound(ev), { holder: () => undefined, fastPath: false, trivial: () => false });
  return v.to === "drop" ? v.why : null;
}

function repoMandate(policy: ServePolicy, repo: string | undefined, ev: StoredEvent): Mandate | undefined {
  const r = repo ? policy.repos.find((x) => realRepo(x.path) === realRepo(repo)) : undefined;
  if (!r) return undefined;
  const base = r.base ?? git(r.path, "branch", "--show-current").out;
  if (!base) return undefined;
  return { repo: realRepo(r.path), files: r.files, verify: r.verify, risk: r.risk, baseBranch: base, source: ev.source, sender: ev.sender, policy: policy.version };
}

async function createFromEvent(d: EngineDeps, ev: StoredEvent, routed: "rule" | "router"): Promise<void> {
  const mandate = repoMandate(d.policy, ev.repo, ev);
  if (!mandate) { await d.store.dispose(ev.key, "refused", "no declared mandate for this repository", routed); return; }
  const t = await d.store.createTask(ev.key, { id: newTaskId(), objective: `Investigate and fix (${ev.kind}): ${ev.text}`, mandate, thread: ev.thread }, routed);
  if (t) { await subscribeThreadAt(threadsFile(d.root), ev.thread, t.id); d.log(`task ${t.id} created from ${ev.key} (${routed})`); }
}

export async function admit(d: EngineDeps): Promise<void> {
  for (const ev of d.store.pendingEvents()) {
    if (ev.source !== "github") { d.log(`${ev.key}: ${await admitOperator(d.store, ev, d.policy.version, d.root)}`); continue; }
    const admission = d.policy.github[ev.kind === "ci_fail" ? "ci_fail" : "review"];
    const verdict = filterEvent(inbound(ev), { holder: (thread) => threadHolderAt(threadsFile(d.root), thread), fastPath: false, trivial: () => false });
    if (verdict.to === "drop") { await d.store.dispose(ev.key, "filtered", verdict.why); continue; }
    if (verdict.to === "lane") {
      // A known thread: straight to its owner, no router call. Outside text
      // is context unless the policy takes this kind as work (admit, route).
      if (admission === "ignore") { await d.store.dispose(ev.key, "ignored", "policy ignores this kind", "direct"); continue; }
      d.log(`${ev.key}: ${await d.store.route(ev.key, verdict.owner, admission === "context" ? "context" : "input", "direct")} for ${verdict.owner} (direct)`);
      continue;
    }
    if (admission === "admit") { await createFromEvent(d, ev, "rule"); continue; }
    if (admission !== "route" || d.policy.router === "off") { await d.store.dispose(ev.key, "filtered", `no task owns this thread; policy: ${admission}`, "rule"); continue; }
    const s = d.store.read();
    const open = Object.values(s.tasks).filter((t) => !t.stopped && t.mandate.repo === (ev.repo ? realRepo(ev.repo) : "")).map((t) => ({ id: t.id, objective: t.objective, thread: t.thread }));
    await d.store.countRouter();
    const decision = await d.router.classify(ev, open);
    d.log(`${ev.key}: router ${decision.action}`);
    if (decision.action === "new") await createFromEvent(d, ev, "router");
    else if (decision.action === "forward") await d.store.route(ev.key, decision.task, "input", "router");
    else await d.store.dispose(ev.key, "ignored", `router: ignore${decision.why ? ` (${decision.why})` : ""}`, "router");
  }
}

// ---- Jobs.

// The job records its own identity under its lock (job.ts); the engine never
// writes a pid it did not observe in the owner file.
export function launchJob(root: string, job: Job, ctx: JobContext, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const dir = jobDir(root, job.id);
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, "context.json"), ctx);
  const fd = openSync(join(dir, "process.log"), "a", 0o600);
  const child = spawn(process.execPath, ["--no-env-file", join(import.meta.dir, "job.ts"), root, job.id], { detached: true, stdio: ["ignore", fd, fd], env });
  closeSync(fd);
  child.unref();
  return child.pid;
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export const jobOwner = (root: string, id: string) => readJson<{ pid: number; start?: string }>(join(jobDir(root, id), "owner.json"));

async function stopJob(root: string, job: Job): Promise<void> {
  const child = readJson<{ pid: number; start?: string }>(join(jobDir(root, job.id), "child.json"));
  const owner = jobOwner(root, job.id);
  if (owner?.pid) await terminateJob(owner.pid, owner.start);
  if (job.pid) await terminateJob(job.pid, job.start);
  if (child?.pid) await terminateJob(child.pid, child.start);
}

export function ensureWorktree(root: string, t: Task): { wt: string; branch: string } {
  const wt = t.worktree ?? join(tasksDir(root), "wt", t.id), branch = t.workBranch ?? `orch/task-${t.id}`;
  if (existsSync(join(wt, ".git"))) return { wt, branch };
  const refusal = testRepoRefusal(t.mandate.repo);
  if (refusal) throw new Error(refusal);
  const exists = git(t.mandate.repo, "show-ref", "--verify", `refs/heads/${branch}`).ok;
  const r = exists ? git(t.mandate.repo, "worktree", "add", "-q", wt, branch) : git(t.mandate.repo, "worktree", "add", "-q", "-b", branch, wt, t.mandate.baseBranch);
  if (!r.ok) throw new Error(`task worktree: ${r.err || r.out}`);
  neutralizeWorktreeHooks(wt, join(tasksDir(root), "no-hooks", t.id));
  return { wt, branch };
}

export const taskKind = (t: Task) => t.mandate.risk === "risky" ? "risky" as const
  : codeKind(specFeatures({ raw: "", fields: { OBJECTIVE: t.objective, FILES: t.mandate.files.join(", ") } }));

const RELAUNCH_MS = 30_000;

async function superviseJobs(d: EngineDeps, run: RunState, paused: boolean): Promise<void> {
  for (const job of Object.values(d.store.read().jobs)) {
    if (!["planned", "running"].includes(job.status)) continue;
    const s = d.store.read(), task = s.tasks[job.task], dir = jobDir(d.root, job.id);
    if (task?.stopped) { await stopJob(d.root, job); await d.store.cancel(job.id); d.log(`job ${job.id}: cancelled (task stopped)`); continue; }
    const receipt = readJson<Parameters<TaskStore["reconcile"]>[1]>(join(dir, "receipt.json"));
    const sessionSeen = readJson<{ session: string }>(join(dir, "session.json"))?.session === task?.session;
    if (receipt) { await d.store.reconcile(job.id, receipt, sessionSeen); d.log(`job ${job.id}: ${receipt.ok ? "ok" : `failed: ${receipt.error ?? receipt.verdict ?? ""}`.slice(0, 200)}`); await afterStep(d, job.task); continue; }
    if (job.status === "planned") {
      // Planned and not started: a live lock owner (spawned before an engine
      // crash) is adopted; a launch is never repeated while one may start,
      // nor under PAUSE. A duplicate that loses the job lock exits unpaid.
      const owner = jobOwner(d.root, job.id);
      if (owner && jobAlive(owner)) continue;
      const last = run.launched?.get(job.id);
      if (paused || last !== undefined && Date.now() - last < RELAUNCH_MS) continue;
      launch(d, run, job, task!);
      continue;
    }
    if (jobAlive(job)) continue; // adopted: still running, possibly started by an earlier engine
    const child = readJson<{ pid: number; start?: string }>(join(dir, "child.json"));
    if (child?.pid) await terminateJob(child.pid, child.start);
    if ((await d.store.reconcile(job.id, undefined, sessionSeen)) === "interrupted") d.log(`job ${job.id}: interrupted, recovery note added`);
  }
}

function launch(d: EngineDeps, run: RunState, job: Job, t: Task): void {
  (run.launched ??= new Map()).set(job.id, Date.now());
  const pid = (d.launch ?? ((j) => launchJob(d.root, j, jobContext(d, t))))(job);
  d.log(`job ${job.id}: launched${pid ? ` (pid ${pid})` : ""}`);
}

function jobContext(d: EngineDeps, t: Task): JobContext {
  const step = rungFor(taskKind(t), t.failures, d.kiba);
  return { ...(step.to === "lane" ? { rung: step.rung } : {}), budgetUsd: d.policy.worker_budget_usd, timeoutMs: d.kiba.lane_timeout_seconds * 1000 };
}

// Notifications after a state change worth a person's attention.
async function afterStep(d: EngineDeps, taskId: string): Promise<void> {
  const t = d.store.read().tasks[taskId];
  if (!t || !d.policy.notify || !d.channels.length) return;
  const worth: Partial<Record<Task["state"], string>> = { blocked: "blocked", "person/answer": "asks a question", "person/review": "needs a review" };
  const what = worth[t.state];
  if (what) await d.store.enqueue({ key: `${t.id}:${t.state}:r${t.revision}`, kind: "notify", task: t.id, revision: t.revision, payload: { title: `orch task ${t.id} ${what}`, text: t.evidence.at(-1)?.text ?? "" } });
}

async function planSteps(d: EngineDeps, run: RunState, paused: boolean): Promise<void> {
  for (const t of Object.values(d.store.read().tasks)) {
    if (t.stopped || t.job) continue;
    if (t.next === "deliver") {
      await d.store.enqueue({ key: `${t.id}:r${t.revision}`, kind: "deliver", task: t.id, revision: t.revision,
        payload: { lane: t.lane!, branch: `orch/${t.id}-r${t.revision}`, message: deliveryMessage(t) } }, (task) => { task.next = "wait"; });
      continue;
    }
    if (!["execute", "verify", "review"].includes(t.next)) continue;
    if (paused) { await d.store.setIdle(t.id, true); continue; }
    if (t.state === "idle") await d.store.setIdle(t.id, false);
    if (t.next === "execute") {
      const step = rungFor(taskKind(t), t.failures, d.kiba);
      if (step.to === "operator") { await d.store.block(t.id, step.why); await afterStep(d, t.id); continue; }
      try {
        const { wt, branch } = ensureWorktree(d.root, t);
        if (t.worktree !== wt) await d.store.setWorktree(t.id, wt, branch);
      } catch (e) { await d.store.block(t.id, String(e)); continue; }
    }
    const job = await d.store.plan(t.id, t.next as Job["kind"]);
    if (!job) continue;
    launch(d, run, job, d.store.read().tasks[t.id]);
  }
}

export function deliveryMessage(t: Task): string {
  const subject = `orch(${t.id}): ${t.objective.split("\n")[0].replace(/\s+/g, " ")}`.slice(0, 100);
  return `${subject}\n\nTask ${t.id}, revision ${t.revision}, delivered by orch serve.\nFILES: ${t.mandate.files.join(", ")}\nVERIFY: ${t.mandate.verify}\nAdmitted from: ${t.mandate.source} (${t.mandate.sender}), policy ${t.mandate.policy}\n`;
}

const backoffMs = (attempts: number) => Math.min(600_000, 30_000 * attempts);

export async function drainOutbox(d: EngineDeps, run: RunState, paused: boolean): Promise<void> {
  if (paused) return;
  for (const listed of d.store.pendingEffects()) {
    const last = run.attempted.get(listed.key);
    if (last !== undefined && (run.once || Date.now() - last < backoffMs(listed.attempts))) continue;
    // The list is a snapshot taken before earlier awaited publications: claim
    // the effect again (still pending, task not stopped) right before use.
    const e = await d.store.claim(listed.key);
    if (!e || existsSync(pauseFile(d.root))) continue;
    run.attempted.set(e.key, Date.now());
    if (e.kind === "notify") await d.store.attempted(e.key, "attempted", "unknown"); // at most once: no lookup exists
    const r = await (e.kind === "deliver" ? d.publisher.deliver(e) : e.kind === "comment" ? d.publisher.comment(e) : d.publisher.notify(e));
    if (!r.done) {
      if (e.kind !== "notify") await d.store.attempted(e.key, r.error);
      d.log(`outbox ${e.key}: pending: ${r.error.split("\n")[0]}`);
      if (e.kind === "deliver" && "final" in r && r.final) { await d.store.change((s) => { s.outbox[e.key].status = "withdrawn"; }); await d.store.block(e.task, `delivery refused by the gate: ${r.error}`); await afterStep(d, e.task); }
      continue;
    }
    // Completion, the branch thread and the downstream effects: one write.
    const repo = d.store.read().tasks[e.task]?.mandate.repo;
    await d.store.completed(e.key, r.receipt, { notify: d.policy.notify && d.channels.length > 0,
      ...(e.kind === "deliver" && repo && r.receipt.branch ? { thread: branchThread(repo, r.receipt.branch) } : {}) });
    d.log(`outbox ${e.key}: done ${Object.values(r.receipt).join(" ")}`);
    if (e.kind === "deliver") await syncThreads(d);
  }
}

// Thread ownership is derived from the journal: every pass re-applies what
// the tasks record, so a crash after a transition never loses a binding.
export async function syncThreads(d: Pick<EngineDeps, "root" | "store">): Promise<void> {
  const file = threadsFile(d.root), held = heldThreadsAt(file);
  for (const t of Object.values(d.store.read().tasks)) {
    for (const thread of t.threads ?? [t.thread]) if (held[thread] !== t.id) await subscribeThreadAt(file, thread, t.id);
  }
}

// ---- GitHub source: the store deduplicates; a repository's first poll only
// records its backlog.

export async function pollGithubSource(d: EngineDeps): Promise<number> {
  let stored = 0;
  const known = new Set(d.store.read().sources.github);
  const seeded: string[] = [];
  for (const r of d.policy.repos) {
    const slug = d.gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], r.path)?.trim();
    if (!slug) continue;
    let events: InboundEvent[];
    try { events = githubEvents([{ path: r.path, slug }], new Set(), d.gh).events; } catch (e) { d.log(`github ${slug}: ${String(e)}`); continue; }
    const backlog = !known.has(slug);
    for (const ev of events) {
      // GitHub identity first: a known run or review is never rebuilt from
      // its mutable payload (a renamed PR changes the text, not the event).
      const st = d.store.read();
      if (st.events[ev.id] || st.seen?.[ev.id]) continue;
      const te: TaskEvent = { key: ev.id, source: "github", sender: "github", kind: ev.kind === "ci_fail" ? "ci_fail" : "review",
        thread: branchThread(r.path, ev.task ?? ""), repo: realRepo(r.path), text: ev.text };
      try {
        if (await d.store.receive(te, (x) => backlog ? `backlog: first poll of ${slug}` : deterministicDrop(x)) === "stored") stored++;
      } catch (e) { d.log(`github ${ev.id}: ${String(e)}`); } // one bad event never aborts the batch
    }
    if (backlog) seeded.push(slug);
  }
  if (seeded.length) await d.store.change((s) => { s.sources.github = [...new Set([...s.sources.github, ...seeded])]; });
  return stored;
}

// ---- Watchdog on worker sessions (src/kiba/watchdog.ts assess/killGroup).

function observeWorkers(d: EngineDeps): LaneWatch[] {
  const s = d.store.read();
  return Object.values(s.jobs).filter((j) => j.kind === "execute" && j.status === "running").flatMap((j) => {
    const t = s.tasks[j.task], dir = jobDir(d.root, j.id);
    const child = readJson<{ pid: number }>(join(dir, "child.json"));
    if (!t?.worktree || !child) return [];
    let turns = 0, steps = 0, size = 0;
    try {
      const log = readFileSync(join(dir, "model.jsonl"), "utf8");
      size = statSync(join(dir, "model.jsonl")).size;
      for (const line of log.split("\n")) {
        if (!line.startsWith("{")) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== "assistant") continue;
        turns++;
        for (const b of e.message?.content ?? []) if (b?.type === "tool_use") steps = b.name === "Bash" && String(b.input?.command ?? "").includes(t.mandate.verify) ? 0 : steps + 1;
      }
    } catch {}
    const entries = statusEntries(t.worktree);
    return [{ id: j.id, phase: "worker", progressKey: String(size), turns, lastTool: null, stepsSinceVerify: steps,
      declared: t.mandate.files, touched: entries ? statusPaths(entries) : [], pgid: child.pid, intent: t.id }];
  });
}

function watchdogFor(d: EngineDeps): Watchdog {
  return new Watchdog(d.kiba.watchdog, {
    observe: () => observeWorkers(d),
    kill: (w, sig) => killGroup(w.pgid, sig),
    signal: (f, action) => {
      const job = d.store.read().jobs[f.lane];
      if (job) void d.store.change((s) => { const t = s.tasks[job.task]; if (t) t.evidence.push({ at: new Date().toISOString(), kind: `watchdog-${f.kind}`, text: `${f.summary}; ${action}` }); });
      d.log(`watchdog ${f.kind} on ${f.lane}: ${f.summary}`);
    },
  });
}

// ---- One pass and the loop.

export async function pass(d: EngineDeps, run: RunState): Promise<{ busy: boolean }> {
  const paused = existsSync(pauseFile(d.root));
  if (!run.recovered) {
    run.recovered = true;
    const live = Object.values(d.store.read().jobs).filter((j) => j.status === "running");
    if (live.length) d.log(`recovery: ${live.length} running job(s) to adopt or mark interrupted`);
  }
  if (d.policy.repos.length && Date.now() - run.polledAt >= d.policy.poll_seconds * 1000) {
    run.polledAt = Date.now();
    try { await pollGithubSource(d); } catch (e) { d.log(`github poll: ${String(e)}`); }
  }
  await syncThreads(d);
  await admit(d);
  await superviseJobs(d, run, paused);
  run.watchdog ??= watchdogFor(d);
  try { await run.watchdog.tick(); } catch (e) { d.log(`watchdog: ${String(e)}`); }
  await planSteps(d, run, paused);
  await drainOutbox(d, run, paused);
  const s = d.store.read();
  // A planned job held by PAUSE (and no live owner) is not work in progress.
  const jobs = Object.values(s.jobs).some((j) => j.status === "running" || j.status === "planned" && (!paused || jobAlive(jobOwner(d.root, j.id) ?? {})));
  const due = !paused && Object.values(s.tasks).some((t) => !t.stopped && !t.job && ["execute", "verify", "review", "deliver"].includes(t.next));
  const effects = !paused && Object.values(s.outbox).some((e) => e.status === "pending" && (!run.once || !run.attempted.has(e.key)));
  const events = Object.values(s.events).some((e) => e.disposition === "new");
  return { busy: jobs || due || effects || events };
}

export function defaultDeps(root = stateDir(), log: (line: string) => void = (l) => console.log(l)): EngineDeps {
  const policy = loadServePolicy();
  let kiba = DEFAULT_KIBA;
  try { kiba = validateKibaConfig(loadProfile("kiba").kiba ?? {}); } catch {}
  let channels: Channel[] = [];
  if (policy.notify) try { channels = loadPresenceConfig().notify; } catch {}
  return { root, store: new TaskStore(tasksDir(root)), policy, router: claudeRouter(), publisher: defaultPublisher(), gh: ghDefault, kiba, channels, log };
}

export async function serve(opts: { once: boolean; root?: string; deps?: EngineDeps }): Promise<number> {
  const root = opts.root ?? stateDir();
  const d = opts.deps ?? defaultDeps(root);
  const held = await withFileLock(join(tasksDir(root), "serve.lock"), async () => {
    atomicJson(join(tasksDir(root), "serve.json"), { pid: process.pid, start: processStamp(process.pid), at: new Date().toISOString() });
    const run: RunState = { once: opts.once, attempted: new Map(), polledAt: 0, recovered: false };
    let passes = 0;
    for (;;) {
      if (passes++ % 50 === 0) try { await d.store.compact(); } catch (e) { d.log(`compact: ${String(e)}`); }
      let busy = true;
      // A failing pass is logged; the service keeps its loop (--once reports it).
      try { busy = (await pass(d, run)).busy; } catch (e) { if (opts.once) throw e; d.log(`pass failed: ${String(e)}`); }
      if (opts.once && !busy) return 0;
      await Bun.sleep(opts.once ? 150 : 2000);
    }
  }, { waitMs: 0 });
  if (held === null) { console.error(`orch serve: another engine holds ${join(tasksDir(root), "serve.lock")}`); return 2; }
  return held;
}

// ---- The real publisher: lane delivery, PR comments with a marker, notices.

export function defaultPublisher(gh: Gh = ghDefault): Publisher {
  return {
    async deliver(e) {
      const { laneIntegrate } = await import("../lane.ts");
      const r = await laneIntegrate(e.payload.lane, { branch: e.payload.branch, message: e.payload.message });
      const status = /^STATUS: (\S+)/m.exec(r.report)?.[1];
      if (r.integrated) {
        const pr = /^PR: (https?:\/\/\S+)/m.exec(r.report)?.[1];
        const commit = /^COMMIT: ([0-9a-f]+)/m.exec(r.report)?.[1];
        return { done: true, receipt: { branch: e.payload.branch, ...(pr ? { pr } : {}), ...(commit ? { commit } : {}) } };
      }
      return { done: false, error: r.report.trim(), final: status === "refused" && !/held the lock/.test(r.report) };
    },
    async comment(e) { return commentOnce(e, gh); },
    async notify(e) {
      const { notify } = await import("../presence/notify.ts");
      try { await notify({ title: e.payload.title, text: e.payload.text || undefined }, loadPresenceConfig().notify); return { done: true, receipt: { sent: "yes" } }; }
      catch (err) { return { done: false, error: String(err) }; }
    },
  };
}

export const commentMarker = (key: string) => `<!-- orch:${key} -->`;

// Reconcile first: a comment whose response was lost is found by its marker.
export async function commentOnce(e: Effect, gh: Gh): Promise<{ done: true; receipt: Record<string, string> } | { done: false; error: string }> {
  const marker = commentMarker(e.key);
  const viewed = gh(["pr", "view", e.payload.pr, "--json", "comments"], e.payload.repo);
  if (viewed === null) return { done: false, error: "cannot read the PR comments" };
  let comments: { body?: string; url?: string }[] = [];
  try { comments = (JSON.parse(viewed) as { comments?: { body?: string; url?: string }[] }).comments ?? []; } catch { return { done: false, error: "unreadable PR comments" }; }
  const found = comments.find((c) => c.body?.includes(marker));
  if (found) return { done: true, receipt: { pr: e.payload.pr, comment: found.url ?? "found by marker" } };
  const posted = gh(["pr", "comment", e.payload.pr, "--body", `${e.payload.body}\n\n${marker}`], e.payload.repo);
  if (posted === null) return { done: false, error: "comment not confirmed; the next attempt looks for its marker first" };
  return { done: true, receipt: { pr: e.payload.pr, comment: posted.trim() || "posted" } };
}
