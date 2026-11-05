// Durable tasks of `orch serve`, promoted from the durable POC store
// (archived on the `archive/benches` branch, durable-1: 7/7 continuity
// checks under real process faults). One JSON state under `<state>/tasks/`,
// changed only under a kernel lock with atomic replacement and fsync, so
// every process (engine, jobs, `orch task` CLI) goes through one writer path.
//   events  persisted before handling, idempotent by key (a reused key with
//           other content is refused); receive answers stored, duplicate or
//           filtered (deterministic drops, kept for the record).
//   tasks   objective, fixed mandate (repo, FILES, VERIFY, risk, admitting
//           source and sender, policy version), origin thread, native session,
//           lane and delivered branch, evidence, state and next action.
//   jobs    execute, verify and review attempts with the process identity
//           (pid and Linux start time) that lets a restarted engine adopt a
//           live job or recognize a dead one without trusting a reused pid.
//   outbox  the only publication path: one row per effect, keyed by kind and
//           key, reconciled with its destination before any retry.
// No model call here.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "../lanes/lock.ts";
import { stateDir } from "./paths.ts";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Atomic replacement with file and directory fsync (POC contract).
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = path + ".next", fd = openSync(next, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

// Linux process start time: a pid plus this stamp names one process, never a
// later process that reused the pid. Undefined for a zombie or a gone pid.
export function processStamp(pid: number): string | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" ? undefined : f[19];
  } catch { return undefined; }
}

export function jobAlive(job: { pid?: number; start?: string }): boolean {
  return !!job.pid && !!job.start && processStamp(job.pid) === job.start;
}

// SIGTERM to the job's process group, SIGKILL after a second.
export async function terminateJob(pid: number, start?: string): Promise<void> {
  if (!jobAlive({ pid, start })) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  for (let n = 0; n < 20 && jobAlive({ pid, start }); n++) await Bun.sleep(50);
  if (jobAlive({ pid, start })) try { process.kill(-pid, "SIGKILL"); } catch {}
}

export const tasksDir = (root = stateDir()) => join(root, "tasks");

// DeepSeek ticket stages: working (a step runs or is due), person/answer (the
// worker asked a question), person/review (a risky change lacks a ship
// review), blocked (failures past the ladder, policy refusal), idle (due work
// held, e.g. by PAUSE), ended (delivered, nothing to change, or stopped).
export const TASK_STATES = ["working", "person/answer", "person/review", "blocked", "idle", "ended"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type NextAction = "execute" | "verify" | "review" | "deliver" | "wait" | "none";
export type SourceName = "operator" | "github" | "orch";
export type EventKind = "request" | "follow" | "stop" | "ci_fail" | "ci_pass" | "review" | "comment" | "chatter";

export interface Mandate {
  repo: string; files: string[]; verify: string; risk: "normal" | "risky"; baseBranch: string;
  source: SourceName; sender: string; policy: number;
}
export interface Evidence { at: string; kind: string; text: string }

export interface Task {
  id: string; objective: string; mandate: Mandate; thread: string;
  session: string; sessionStarted: boolean;
  revision: number; deliveredRevision: number; attempt: number; failures: number;
  state: TaskState; next: NextAction; stopped?: { by: string; at: string };
  // Threads the task owns (origin, then each delivered branch), written with
  // the transition that creates them; the engine re-applies them every pass.
  threads?: string[]; recovery?: boolean;
  worktree?: string; workBranch?: string;
  lane?: string; branch?: string; pr?: string;
  job?: string; failure?: string; evidence: Evidence[]; created: string; updated: string;
  // Security hold (an escape): nothing launches until a person answers. Unlike
  // a plain block, an outside event cannot lift it.
  hold?: { reason: string; at: string };
}

export interface TaskEvent {
  key: string; source: SourceName; sender: string; kind: EventKind; thread: string; text: string;
  task?: string; repo?: string;
  // A request carries its mandate; any other event never changes one.
  request?: { objective: string; mandate: Omit<Mandate, "policy"> };
}
export type Disposition = "new" | "input" | "consumed" | "context" | "filtered" | "refused" | "ignored";
export interface StoredEvent extends TaskEvent {
  hash: string; at: string; disposition: Disposition; reason?: string; revision?: number; sent?: boolean;
  routed?: "operator" | "direct" | "rule" | "router";
}

export type JobKind = "execute" | "verify" | "review";
export interface JobReceipt {
  ok: boolean; error?: string; session?: string; cost?: number | null; costComplete?: boolean; model?: string; elapsedMs?: number;
  result?: string; question?: string; lane?: string; sha?: string; changed?: boolean; verdict?: string;
  // A write left the task worktree: a security outcome, never a plain failure.
  escaped?: boolean;
}
export interface Job {
  id: string; task: string; revision: number; kind: JobKind; inputs: string[]; context?: string[];
  status: "planned" | "running" | "complete" | "interrupted" | "cancelled"; pid?: number; start?: string; receipt?: JobReceipt;
}

export type EffectKind = "deliver" | "comment" | "notify";
export interface Effect {
  key: string; kind: EffectKind; task: string; revision?: number; payload: Record<string, string>;
  // unknown: a notification was attempted and its fate cannot be looked up;
  // it is never resent (at most once).
  status: "pending" | "done" | "withdrawn" | "unknown"; attempts: number; receipt?: Record<string, string>; error?: string; at: string;
}

export interface TasksState {
  version: 1; tasks: Record<string, Task>; events: Record<string, StoredEvent>; jobs: Record<string, Job>; outbox: Record<string, Effect>;
  sources: { github: string[] }; counters: { router: number; direct: number };
  // Keys (and short hashes) of archived events: dedup survives compaction.
  seen?: Record<string, string>;
  // Import of the retired conductor's state (src/serve/migrate.ts): each
  // item key once, `done` once nothing was left to wait for.
  migration?: { items: string[]; done?: string };
}

// Live state bounds: past them, the oldest terminal rows go to
// `<tasks>/archive/*.jsonl` (rotated), so the state file keeps a fixed size.
export const LIVE_LIMITS = { events: 300, jobs: 100, effects: 100, endedTasks: 50, seen: 5000, archiveBytes: 5 * 1024 * 1024 };

const now = () => new Date().toISOString();
const KEY = /^[A-Za-z0-9_.:@/-]{1,200}$/;
export const RECOVERY_NOTE = "Recovery: an earlier attempt was interrupted. Check the worktree, git history and the destination before repeating any outside action.";
const EVIDENCE_MAX = 60;

export function evidence(t: Task, kind: string, text: string): void {
  t.evidence.push({ at: now(), kind, text: text.replace(/\s+/g, " ").trim().slice(0, 400) });
  if (t.evidence.length > EVIDENCE_MAX) t.evidence.splice(0, t.evidence.length - EVIDENCE_MAX);
  t.updated = now();
}

export const newTaskId = () => `t-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;

export class TaskStore {
  readonly root: string;
  constructor(root = tasksDir()) { this.root = root; }

  read(): TasksState {
    const file = join(this.root, "state.json");
    if (!existsSync(file)) return { version: 1, tasks: {}, events: {}, jobs: {}, outbox: {}, sources: { github: [] }, counters: { router: 0, direct: 0 } };
    const s = JSON.parse(readFileSync(file, "utf8")) as TasksState;
    if (s.version !== 1 || !s.tasks || !s.events || !s.jobs || !s.outbox) throw new Error("invalid task journal");
    s.sources ??= { github: [] };
    s.counters ??= { router: 0, direct: 0 };
    return s;
  }

  async change<T>(fn: (s: TasksState) => T): Promise<T> {
    if (process.env.ORCH_LANE === "1") throw new Error("tasks: a worker never writes the task journal");
    const r = await withFileLock(join(this.root, "state.lock"), () => {
      const s = this.read();
      const result = fn(s);
      atomicJson(join(this.root, "state.json"), s);
      return { result };
    }, { waitMs: 30_000, pollMs: 20 });
    if (!r) throw new Error("tasks: journal locked");
    return r.result;
  }

  // Persist first; the deterministic filter only labels the stored row.
  async receive(ev: TaskEvent, filter?: (ev: TaskEvent) => string | null): Promise<"stored" | "duplicate" | "filtered"> {
    if (!KEY.test(ev.key) || !ev.thread || !ev.text.trim() || !["operator", "github", "orch"].includes(ev.source)) throw new Error("invalid task event");
    if (ev.request && (!ev.request.mandate.files.length || !ev.request.mandate.verify.trim() || !ev.request.mandate.repo)) throw new Error("a request needs repo, FILES and VERIFY");
    const digest = hash([ev.key, ev.source, ev.sender, ev.kind, ev.thread, ev.task ?? "", ev.repo ?? "", ev.text, ev.request ?? null]);
    return this.change((s) => {
      const old = s.events[ev.key]?.hash ?? s.seen?.[ev.key];
      if (old) {
        if (!digest.startsWith(old)) throw new Error(`event ${ev.key} reused with different content`);
        return "duplicate";
      }
      const why = filter?.(ev) ?? null;
      s.events[ev.key] = { ...ev, hash: digest, at: now(), disposition: why ? "filtered" : "new", ...(why ? { reason: why } : {}) };
      return why ? "filtered" : "stored";
    });
  }

  pendingEvents(): StoredEvent[] {
    return Object.values(this.read().events).filter((e) => e.disposition === "new").sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---- Admission outcomes (the engine decides; these only record).

  async createTask(eventKey: string, t: { id: string; objective: string; mandate: Mandate; thread: string }, routed: StoredEvent["routed"]): Promise<Task | undefined> {
    return this.change((s) => {
      const ev = s.events[eventKey];
      if (!ev || ev.disposition !== "new") return undefined;
      if (s.tasks[t.id]) { ev.disposition = "refused"; ev.reason = "task id exists"; return undefined; }
      const at = now();
      const task: Task = {
        id: t.id, objective: t.objective, mandate: t.mandate, thread: t.thread, session: randomUUID(), sessionStarted: false,
        revision: 1, deliveredRevision: 0, attempt: 0, failures: 0, state: "working", next: "execute", evidence: [], created: at, updated: at,
        threads: [t.thread],
      };
      evidence(task, "admitted", `${ev.source} ${ev.sender}: ${ev.kind} (${routed})`);
      s.tasks[t.id] = task;
      Object.assign(ev, { disposition: "input", task: t.id, revision: 1, routed });
      return task;
    });
  }

  // An input opens a new revision (an ended task resumes with the same
  // session and mandate); context is attached for the next revision only.
  async route(eventKey: string, taskId: string, as: "input" | "context", routed: StoredEvent["routed"]): Promise<"input" | "context" | "refused"> {
    return this.change((s) => {
      const ev = s.events[eventKey], t = s.tasks[taskId] ?? this.restore(s, taskId);
      if (!ev || ev.disposition !== "new") return "refused";
      if (routed === "direct") s.counters.direct++;
      if (!t || t.stopped) {
        Object.assign(ev, { disposition: "refused", reason: t ? "task stopped by a person" : "no such task", routed });
        return "refused";
      }
      ev.task = t.id;
      ev.routed = routed;
      if (as === "context") { ev.disposition = "context"; evidence(t, "context", `${ev.source}: ${ev.text}`); return "context"; }
      if (t.hold && ev.source !== "operator") {
        ev.disposition = "context";
        evidence(t, "held", `${ev.source} ${ev.sender}: kept as context, a person must lift the hold`);
        return "context";
      }
      ev.disposition = "input";
      ev.revision = ++t.revision;
      if (t.hold) { evidence(t, "hold-lifted", `${ev.sender}: ${t.hold.reason}`); t.hold = undefined; }
      if (t.state === "blocked") t.failures = 0;
      t.state = "working";
      // No job runs: a pending verify, review or delivery belongs to the old
      // revision, so the new input is executed first. A running job sees the
      // revision change when it reconciles.
      if (!t.job) t.next = "execute";
      evidence(t, "input", `${ev.source} ${ev.sender}: ${ev.text}`);
      return "input";
    });
  }

  async dispose(eventKey: string, disposition: "filtered" | "ignored" | "refused", reason: string, routed?: StoredEvent["routed"]): Promise<void> {
    await this.change((s) => {
      const ev = s.events[eventKey];
      if (!ev || ev.disposition !== "new") return;
      Object.assign(ev, { disposition, reason, ...(routed ? { routed } : {}) });
    });
  }

  async countRouter(): Promise<void> { await this.change((s) => { s.counters.router++; }); }

  // A person's stop: no automatic resumption, pending effects withdrawn.
  async stop(taskId: string, by: string, eventKey?: string): Promise<boolean> {
    return this.change((s) => {
      const t = s.tasks[taskId];
      if (eventKey && s.events[eventKey]) Object.assign(s.events[eventKey], { disposition: t ? "consumed" : "refused", task: taskId, routed: "operator" });
      if (!t) return false;
      t.stopped = { by, at: now() };
      t.state = "ended";
      t.next = "none";
      for (const e of Object.values(s.outbox)) if (e.task === t.id && e.status === "pending") e.status = "withdrawn";
      evidence(t, "stopped", `stopped by ${by}`);
      return true;
    });
  }

  async block(taskId: string, why: string): Promise<void> {
    await this.change((s) => {
      const t = s.tasks[taskId];
      if (!t || t.stopped) return;
      t.state = "blocked"; t.next = "wait"; t.failure = why;
      evidence(t, "blocked", why);
    });
  }

  async setIdle(taskId: string, idle: boolean): Promise<void> {
    await this.change((s) => {
      const t = s.tasks[taskId];
      if (!t || t.stopped) return;
      if (idle && t.state === "working") t.state = "idle";
      if (!idle && t.state === "idle") t.state = "working";
    });
  }

  async setWorktree(taskId: string, worktree: string, branch: string): Promise<void> {
    await this.change((s) => { const t = s.tasks[taskId]; if (t) { t.worktree = worktree; t.workBranch = branch; } });
  }

  // ---- Jobs (POC plan/started/reconcile, generalized to three kinds).

  async plan(taskId: string, kind: JobKind): Promise<Job | undefined> {
    return this.change((s) => {
      const t = s.tasks[taskId];
      if (!t || t.stopped || t.hold || t.next !== kind) return undefined;
      if (t.job && ["planned", "running"].includes(s.jobs[t.job]?.status)) return undefined;
      const inputs = kind === "execute" ? Object.values(s.events).filter((e) => e.task === t.id && e.disposition === "input").map((e) => e.key) : [];
      const context = kind === "execute" ? Object.values(s.events).filter((e) => e.task === t.id && e.disposition === "context" && !e.sent).map((e) => e.key) : [];
      const id = `${t.id}-r${t.revision}-${kind}-${++t.attempt}`;
      const job: Job = { id, task: t.id, revision: t.revision, kind, inputs, context, status: "planned" };
      s.jobs[id] = job;
      t.job = id;
      t.state = "working";
      return job;
    });
  }

  // The launcher records the child's identity as soon as it exists.
  async started(jobId: string, pid: number): Promise<void> {
    await this.change((s) => {
      const j = s.jobs[jobId];
      if (!j || j.status !== "planned") return;
      j.status = "running"; j.pid = pid; j.start = processStamp(pid);
    });
  }

  async cancel(jobId: string): Promise<void> {
    await this.change((s) => {
      const j = s.jobs[jobId];
      if (!j || !["planned", "running"].includes(j.status)) return;
      j.status = "cancelled";
      const t = s.tasks[j.task];
      if (t?.job === jobId) t.job = undefined;
    });
  }

  // A receipt completes the job; without one, a dead job is interrupted and
  // its step is planned again with the recovery note (a dead verify never
  // relaunches the worker).
  async reconcile(jobId: string, receipt?: JobReceipt, sessionSeen = false): Promise<"waiting" | "interrupted" | "complete"> {
    return this.change((s) => {
      const j = s.jobs[jobId];
      if (!j || !["running", "planned"].includes(j.status)) return "complete";
      const t = s.tasks[j.task];
      if (!receipt) {
        if (j.status === "planned" || jobAlive(j)) return "waiting";
        j.status = "interrupted";
        if (t.job === j.id) t.job = undefined;
        if (sessionSeen) t.sessionStarted = true;
        if (!t.stopped) { t.next = j.kind; t.recovery = true; evidence(t, "recovery", `${j.kind} job ${j.id} died without a receipt. ${RECOVERY_NOTE}`); }
        return "interrupted";
      }
      j.status = "complete"; j.receipt = receipt;
      if (t.job === j.id) t.job = undefined;
      if (t.stopped) return "complete";
      if (j.kind === "execute") {
        // An escape outranks every other outcome: no ladder, no new attempt.
        if (receipt.escaped) {
          if (sessionSeen || receipt.session === t.session) t.sessionStarted = true;
          t.hold = { reason: receipt.error ?? "write outside the task worktree", at: now() };
          t.state = "blocked"; t.next = "wait"; t.failure = t.hold.reason;
          evidence(t, "security-hold", t.hold.reason);
          return "complete";
        }
        if (receipt.session) {
          if (receipt.session !== t.session) { t.state = "blocked"; t.next = "wait"; t.failure = "native session identity changed"; evidence(t, "blocked", t.failure); return "complete"; }
          t.sessionStarted = true;
        } else if (sessionSeen) t.sessionStarted = true;
        if (!receipt.ok) { t.failures++; t.next = "execute"; evidence(t, "worker-failed", receipt.error ?? "worker failed"); return "complete"; }
        for (const key of j.inputs) if (s.events[key]) s.events[key].disposition = "consumed";
        for (const key of j.context ?? []) if (s.events[key]) s.events[key].sent = true;
        t.recovery = false;
        evidence(t, "worker", receipt.result ?? "worker done");
        if (receipt.question) { t.state = "person/answer"; t.next = "wait"; evidence(t, "question", receipt.question); return "complete"; }
        t.next = t.revision === j.revision ? "verify" : "execute";
        return "complete";
      }
      if (t.revision !== j.revision) { t.next = "execute"; return "complete"; }
      if (j.kind === "verify") {
        if (!receipt.ok) {
          t.failures++;
          // The VERIFY output goes back to the same session as an orch input.
          const key = `orch:${j.id}:verify-failed`;
          s.events[key] = { key, source: "orch", sender: "orch", kind: "follow", thread: t.thread, task: t.id, text: `VERIFY failed: ${(receipt.error ?? "").slice(-1500)}`, hash: hash(key), at: now(), disposition: "input", revision: ++t.revision, routed: "rule" };
          t.next = "execute";
          evidence(t, "verify-failed", receipt.error ?? "VERIFY failed");
          return "complete";
        }
        t.lane = receipt.lane;
        if (!receipt.changed) { t.state = "ended"; t.next = "none"; evidence(t, "no-change", "the worker changed nothing: nothing to deliver"); return "complete"; }
        evidence(t, "verified", `lane ${receipt.lane} sha ${receipt.sha}`);
        t.next = t.mandate.risk === "risky" ? "review" : "deliver";
        return "complete";
      }
      // review
      if (receipt.ok && receipt.verdict === "ship") { t.next = "deliver"; evidence(t, "review", "ship"); return "complete"; }
      t.state = "person/review"; t.next = "wait";
      evidence(t, "review", `verdict ${receipt.verdict ?? "unknown"}${receipt.error ? `: ${receipt.error}` : ""}`);
      return "complete";
    });
  }

  // ---- Outbox.

  async enqueue(effect: Omit<Effect, "status" | "attempts" | "at">, after?: (t: Task) => void): Promise<Effect> {
    return this.change((s) => {
      const key = `${effect.kind}:${effect.key}`;
      s.outbox[key] ??= { ...effect, key, status: "pending", attempts: 0, at: now() };
      const t = s.tasks[effect.task];
      if (t && after) after(t);
      return s.outbox[key];
    });
  }

  async attempted(key: string, error: string, final?: "unknown"): Promise<void> {
    await this.change((s) => {
      const e = s.outbox[key];
      if (!e || e.status !== "pending") return;
      e.attempts++; e.error = error.slice(0, 500);
      if (final) e.status = final;
    });
  }

  // A completed effect. A delivery, in the same atomic write, closes or
  // advances its task, takes its branch's thread, and records the downstream
  // effects (comment on the superseded PR, notice), so no crash loses them.
  async completed(key: string, receipt: Record<string, string>, opts: { notify?: boolean; thread?: string } = {}): Promise<void> {
    await this.change((s) => {
      const e = s.outbox[key];
      if (!e || e.status === "done") return;
      e.attempts++; e.status = "done"; e.receipt = receipt; delete e.error;
      const t = s.tasks[e.task];
      if (e.kind !== "deliver" || !t) return;
      const previous = t.pr, rev = e.revision ?? t.revision, at = now();
      t.deliveredRevision = rev;
      t.branch = receipt.branch; if (receipt.pr) t.pr = receipt.pr;
      if (opts.thread) t.threads = [...new Set([...(t.threads ?? [t.thread]), opts.thread])];
      evidence(t, "delivered", `${receipt.branch}${receipt.pr ? ` ${receipt.pr}` : ""}`);
      const add = (x: Omit<Effect, "status" | "attempts" | "at">) => { s.outbox[`${x.kind}:${x.key}`] ??= { ...x, key: `${x.kind}:${x.key}`, status: "pending", attempts: 0, at }; };
      if (previous && receipt.pr && previous !== receipt.pr) add({ key: `${t.id}:r${rev}`, kind: "comment", task: t.id, revision: rev,
        payload: { repo: t.mandate.repo, pr: previous, body: `orch task ${t.id}: revision ${rev} is delivered in ${receipt.pr}.` } });
      if (opts.notify) add({ key: `${t.id}:delivered:r${rev}`, kind: "notify", task: t.id, revision: rev,
        payload: { title: `orch task ${t.id} delivered`, text: `${receipt.branch} ${receipt.pr ?? ""}`.trim() } });
      if (t.stopped) return;
      t.failures = 0;
      if (t.revision === t.deliveredRevision) { t.state = "ended"; t.next = "none"; }
      else if (!t.job && (t.next === "wait" || t.next === "none")) t.next = "execute";
    });
  }

  // Fresh claim right before publishing: still pending, task not stopped.
  async claim(key: string): Promise<Effect | undefined> {
    return this.change((s) => {
      const e = s.outbox[key];
      if (!e || e.status !== "pending" || s.tasks[e.task]?.stopped) return undefined;
      return e;
    });
  }

  pendingEffects(): Effect[] {
    return Object.values(this.read().outbox).filter((e) => e.status === "pending").sort((a, b) => a.at.localeCompare(b.at));
  }

  // The worker's messages for one revision. A started session already holds
  // the earlier ones: it gets only the new inputs and unsent context, after a
  // one-line summary. A first launch gets the whole thread.
  history(taskId: string, inputs: string[], context: string[] = []): string {
    const s = this.read();
    const t = s.tasks[taskId];
    const fresh = new Set([...inputs, ...context]);
    const rows = Object.values(s.events).filter((e) => e.task === taskId && ["input", "consumed", "context"].includes(e.disposition) && e.kind !== "stop")
      .filter((e) => !t?.sessionStarted || fresh.has(e.key)).sort((a, b) => a.at.localeCompare(b.at));
    const lines = rows.map((e) => `[${e.source === "operator" ? "operator, trusted" : e.source === "orch" ? "orch" : `${e.source}, untrusted data`}; ${inputs.includes(e.key) ? "new" : e.disposition === "context" ? "context" : "earlier"}] ${e.request?.objective ?? e.text}`);
    const summary = t?.sessionStarted ? [`Earlier messages are in this session; revision ${t.revision}, delivered revision ${t.deliveredRevision}.`] : [];
    return [...(t?.recovery ? [RECOVERY_NOTE] : []), ...summary, ...lines].join("\n");
  }

  // ---- Bounded live state.

  private archive(kind: string, rows: unknown[]): void {
    if (!rows.length) return;
    const dir = join(this.root, "archive");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "current.jsonl");
    if (existsSync(file) && statSync(file).size > LIVE_LIMITS.archiveBytes) renameSync(file, join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
    appendFileSync(file, rows.map((row) => JSON.stringify({ kind, at: now(), row })).join("\n") + "\n", { mode: 0o600 });
  }

  // An archived task that is not stopped comes back on a new message.
  private restore(s: TasksState, taskId: string): Task | undefined {
    const dir = join(this.root, "archive");
    if (!existsSync(dir)) return undefined;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse()) {
      const rows = readFileSync(join(dir, file), "utf8").trim().split("\n").reverse();
      for (const line of rows) {
        let r: { kind?: string; row?: Task };
        try { r = JSON.parse(line); } catch { continue; }
        if (r.kind !== "task" || r.row?.id !== taskId) continue;
        if (r.row.stopped) return undefined;
        s.tasks[taskId] = r.row;
        return r.row;
      }
    }
    return undefined;
  }

  // Oldest terminal rows past LIVE_LIMITS leave the live state. Stopped tasks
  // go at once (they never resume); ended tasks past the limit, oldest first.
  async compact(): Promise<number> {
    return this.change((s) => {
      const busy = new Set([...Object.values(s.jobs).filter((j) => ["planned", "running"].includes(j.status)).map((j) => j.task),
        ...Object.values(s.outbox).filter((e) => e.status === "pending").map((e) => e.task)]);
      const oldest = <T>(rows: T[], at: (x: T) => string, keep: number) => rows.sort((a, b) => at(a).localeCompare(at(b))).slice(0, Math.max(0, rows.length - keep));
      const ended = Object.values(s.tasks).filter((t) => t.state === "ended" && !busy.has(t.id));
      const tasks = [...ended.filter((t) => t.stopped), ...oldest(ended.filter((t) => !t.stopped), (t) => t.updated, LIVE_LIMITS.endedTasks)];
      const jobs = oldest(Object.values(s.jobs).filter((j) => !["planned", "running"].includes(j.status)), (j) => j.id, LIVE_LIMITS.jobs);
      const effects = oldest(Object.values(s.outbox).filter((e) => e.status !== "pending"), (e) => e.at, LIVE_LIMITS.effects);
      const gone = new Set(tasks.map((t) => t.id));
      const terminal = Object.values(s.events).filter((e) => !["new", "input"].includes(e.disposition) && !(e.disposition === "context" && !e.sent && e.task && !gone.has(e.task)));
      const events = [...terminal.filter((e) => e.task && gone.has(e.task)), ...oldest(terminal.filter((e) => !e.task || !gone.has(e.task)), (e) => e.at, LIVE_LIMITS.events)];
      this.archive("task", tasks); this.archive("job", jobs); this.archive("effect", effects); this.archive("event", events);
      for (const t of tasks) delete s.tasks[t.id];
      for (const j of jobs) delete s.jobs[j.id];
      for (const e of effects) delete s.outbox[e.key];
      s.seen ??= {};
      for (const e of events) { s.seen[e.key] = e.hash.slice(0, 16); delete s.events[e.key]; }
      const keys = Object.keys(s.seen);
      for (const k of keys.slice(0, Math.max(0, keys.length - LIVE_LIMITS.seen))) delete s.seen[k];
      return tasks.length + jobs.length + effects.length + events.length;
    });
  }
}
