// `orch serve migrate`: imports the retired dispatch-only conductor's live
// state (`<state>/kiba/`) into the task store of `orch serve`, once. Also run
// at every `orch serve` start; a completed import is never repeated.
//   running or queued intents  tasks with their objective, repo, FILES and
//                              VERIFY; a dead runner is recovered like a dead
//                              P4 job (recovery note, the worker checks first);
//                              a live runner defers the import until it ends
//   delivery checkpoints       a conductor lane whose `lane integrate --branch`
//                              stopped half way becomes a pending delivery
//                              effect; the outbox resumes it through the same
//                              lane integrate, which finds an existing PR first
//   unacknowledged results     pending notification effects (at most once)
//   held threads               thread bindings of the imported tasks
// Cancelled intents stay cancelled: no task, no delivery. The old files are
// only read, never changed. No model call here.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../core/git.ts";
import { stateDir } from "../core/paths.ts";
import { heldThreadsAt } from "../core/threads.ts";
import { evidence, hash, RECOVERY_NOTE, tasksDir, TaskStore, type Effect, type Mandate, type SourceName, type StoredEvent, type Task } from "../core/tasks.ts";
import { processGroupAlive } from "../harness/proc.ts";
import { listLanes, reapDeadLanes, type LaneState } from "../lane.ts";
import { deliveryMessage, loadServePolicy, syncThreads } from "./engine.ts";

export const oldConductorDir = (root = stateDir()) => join(root, "kiba");

interface OldIntent {
  id: string; kind: string; status: string; at?: string; owner?: string; repo?: string; pid?: number;
  objective?: string; files?: string[]; verify?: string; thread?: string; lane?: string; reason?: string; integrate?: string;
  followupsPending?: OldFollowup[];
}
interface OldFollowup { at?: string; text: string; source?: string }
interface OldInbox { id: string; source: string; line: string; repo?: string; owner?: string }

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

// The journal is append-only: the latest line of an id is its state.
export function oldIntents(root = stateDir()): OldIntent[] {
  const last = new Map<string, OldIntent>();
  for (const r of readJsonl<OldIntent>(join(oldConductorDir(root), "intents.jsonl"))) last.set(r.id, { ...last.get(r.id), ...r });
  return [...last.values()];
}

// Every acknowledged offer, whoever its recipient (no recipient exists any more).
function acknowledged(root: string): { signals: Set<string>; intents: Set<string> } {
  const rows = readJsonl<{ kind: string; id?: string; ids?: string[]; signals?: string[]; intents?: string[] }>(join(oldConductorDir(root), "notifications.jsonl"));
  const offers = new Map(rows.filter((r) => r.kind === "offer" && r.id).map((r) => [r.id!, r]));
  const out = { signals: new Set<string>(), intents: new Set<string>() };
  for (const r of rows) if (r.kind === "ack") for (const id of r.ids ?? []) {
    for (const s of offers.get(id)?.signals ?? []) out.signals.add(s);
    for (const i of offers.get(id)?.intents ?? []) out.intents.add(i);
  }
  // Delivery rows from before receipts carried a recipient counted as read.
  // The wake recorded intent and event ids alike: both sets take them.
  for (const r of readJsonl<{ id: string; repo?: string; owner?: string }>(join(oldConductorDir(root), "wake", "delivered.jsonl"))) {
    if (!r.repo && !r.owner) { out.intents.add(r.id); out.signals.add(r.id); }
  }
  return out;
}

const WAKE_STATUSES = ["done", "failed", "env-failed", "needs-lead", "escalated"];
const CODE_KINDS = ["mechanical", "normal", "risky"];
const NOTIFY_CAP = 50;

const alive = (pid?: number) => {
  if (!pid || pid <= 1) return false;
  if (processGroupAlive(pid)) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

interface Delivery { verifiedSha: string; base: string; branch: string; message: string; commit: string }
const deliveryOf = (root: string, lane: LaneState) => {
  const d = readJson<Delivery>(join(root, "lanes", lane.id, "delivery.json"));
  return d && [d.branch, d.message, d.commit].every((v) => typeof v === "string" && v.length) ? d : undefined;
};

// Follow-ups of an intent: the late file and the record's pending list,
// deduplicated, in arrival order.
function oldFollowups(root: string, rec?: OldIntent): OldFollowup[] {
  if (!rec) return [];
  const rows = [...readJsonl<OldFollowup>(join(oldConductorDir(root), "intents", rec.id, "followups.jsonl")), ...(rec.followupsPending ?? [])];
  const seen = new Set<string>();
  return rows.filter((f) => typeof f?.text === "string" && f.text.trim())
    .filter((f) => { const k = `${f.at ?? ""}\0${f.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

// Provenance kept: operator and orch stay trusted, any other source is
// outside data (the github source of the task store is untrusted).
const followupSource = (s?: string): SourceName => s === "operator" ? "operator" : s === "orch" || s === "lane" ? "orch" : "github";

// A durable working branch of the task, rooted at the work it already has
// (a verified commit, a delivered commit, a dead lane's branch tip), so a
// later revision starts from it, never from the base branch.
function durableBranch(repo: string, id: string, sha?: string): string | undefined {
  if (!sha) return undefined;
  const branch = `orch/task-${id}`;
  if (git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok) return branch;
  return git(repo, "branch", branch, sha).ok ? branch : undefined;
}

export interface MigrationReport { already: boolean; done: boolean; tasks: string[]; effects: string[]; deferred: string[]; skipped: string[] }

type Plan = { key: string; task?: Task; effects: Effect[]; event?: Task["id"]; text?: string; followups?: { revision: number; rows: OldFollowup[] } };

export async function migrateConductor(root = stateDir(), store = new TaskStore(tasksDir(root))): Promise<MigrationReport> {
  const report: MigrationReport = { already: false, done: false, tasks: [], effects: [], deferred: [], skipped: [] };
  const before = store.read().migration;
  if (before?.done) return { ...report, already: true, done: true };
  const imported = new Set(before?.items ?? []);
  const old = oldIntents(root);
  const lanes = listLanes(root);
  const policy = (() => { try { return loadServePolicy().version; } catch { return 1; } })();
  const at = new Date().toISOString();
  const plans: Plan[] = [];
  const notice = (key: string, title: string, text: string): Effect =>
    ({ key: `notify:${key}`, kind: "notify", task: "migration", payload: { title, text: text.slice(0, 1500) }, status: "pending", attempts: 0, at });
  const newTask = (id: string, objective: string, mandate: Mandate, thread: string): Task =>
    ({ id, objective, mandate, thread, session: randomUUID(), sessionStarted: false, revision: 1, deliveredRevision: 0, attempt: 0, failures: 0,
      state: "working", next: "execute", threads: [thread], evidence: [], created: at, updated: at });

  // Intents that were running or queued.
  const handled = new Set<string>();
  for (const rec of old.filter((r) => r.status === "running" || r.status === "queued")) {
    const key = `intent:${rec.id}`;
    if (imported.has(key)) continue;
    const own = lanes.filter((l) => l.intent === rec.id).sort((a, b) => a.started.localeCompare(b.started));
    if (alive(rec.pid) || own.some((l) => l.status === "running" && alive(l.pid))) {
      report.deferred.push(`${rec.id}: its runner still runs (pid ${rec.pid ?? "?"}); migrate again once it ends`);
      continue;
    }
    // Its dead lanes keep their work on their branch (the lane finalizer).
    reapDeadLanes(root, { intent: rec.id });
    const spec = { ...rec, ...readJson<Partial<OldIntent>>(join(oldConductorDir(root), "intents", rec.id, "intent.json")) };
    const lane = listLanes(root).filter((l) => l.intent === rec.id).sort((a, b) => a.started.localeCompare(b.started)).at(-1);
    const repo = spec.repo ?? lane?.repo;
    const base = lane?.baseBranch ?? (repo ? git(repo, "branch", "--show-current").out : "");
    if (!CODE_KINDS.includes(spec.kind) || !spec.objective || !spec.files?.length || !spec.verify || !repo || !base) {
      plans.push({ key, effects: [notice(`migration:${rec.id}`, `Kiba: intent ${rec.id} not resumed`,
        `The retired conductor was running ${rec.id} (${spec.kind}: ${(spec.objective ?? "").slice(0, 300)}) when its runner died. orch serve resumes only code tasks with FILES and VERIFY: ask again with orch task new.`)] });
      continue;
    }
    const thread = spec.thread ?? `task:${rec.id}`;
    const t = newTask(rec.id, spec.objective, { repo, files: spec.files, verify: spec.verify, risk: spec.kind === "risky" ? "risky" : "normal", baseBranch: base,
      source: "orch", sender: "kiba-conductor", policy }, thread);
    const follow = oldFollowups(root, rec);
    const d = lane ? deliveryOf(root, lane) : undefined;
    evidence(t, "migrated", `intent ${rec.id} (${spec.kind}) of the retired conductor${lane ? `, last lane ${lane.id}` : ""}`);
    if (lane && lane.status === "complete" && lane.verifyOk === true && lane.verifiedSha) {
      // The work finished and passed VERIFY before the runner died: one task
      // carries the lane and its delivery; it is never executed again for it.
      Object.assign(t, { lane: lane.id, workBranch: durableBranch(repo, rec.id, d?.commit ?? lane.verifiedSha) });
      const effects: Effect[] = [];
      if (follow.length) t.revision = 2;
      if (!lane.changed) Object.assign(t, { state: "ended", next: "none" });
      else if (d || (follow.length && t.mandate.risk !== "risky")) {
        const r1 = { ...t, revision: 1 };
        effects.push({ key: `deliver:${rec.id}:r1`, kind: "deliver", task: rec.id, revision: 1, status: "pending", attempts: 0, at,
          payload: { lane: lane.id, branch: d?.branch ?? `orch/${rec.id}-r1`, message: d?.message ?? deliveryMessage(r1) } });
        t.next = "wait";
      } else t.next = follow.length ? "execute" : t.mandate.risk === "risky" ? "review" : "deliver";
      evidence(t, "verified", `lane ${lane.id} completed and passed VERIFY (sha ${lane.verifiedSha.slice(0, 12)}) before the runner died: not executed again${d ? `; its delivery to ${d.branch} resumes` : ""}${follow.length ? `; ${follow.length} follow-up(s) open revision 2` : ""}`);
      if (d) handled.add(lane.id);
      plans.push({ key, task: t, effects, event: rec.id, text: spec.objective, ...(follow.length ? { followups: { revision: 2, rows: follow } } : {}) });
      if (d) plans.push({ key: `delivery:${lane.id}`, effects: [] });
      continue;
    }
    const tip = lane ? git(lane.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${lane.branch}`) : undefined;
    if (lane && tip?.ok) t.workBranch = durableBranch(repo, rec.id, tip.out);
    t.recovery = true;
    evidence(t, "recovery", `the runner of intent ${rec.id} died without a report. ${RECOVERY_NOTE}`);
    plans.push({ key, task: t, effects: [], event: rec.id, text: spec.objective, ...(follow.length ? { followups: { revision: 1, rows: follow } } : {}) });
  }

  // Deliveries a conductor lane left half way (lane integrate --branch).
  for (const lane of lanes.filter((l) => l.intent)) {
    const key = `delivery:${lane.id}`;
    const d = deliveryOf(root, lane);
    if (!d || imported.has(key) || handled.has(lane.id)) continue;
    const rec = old.find((r) => r.id === lane.intent);
    if (rec?.status === "cancelled") { report.skipped.push(`${lane.id}: intent ${rec.id} was cancelled, its delivery stays undone`); continue; }
    const taken = new Set([...Object.keys(store.read().tasks), ...plans.flatMap((p) => p.task ? [p.task.id] : [])]);
    const id = taken.has(lane.intent!) ? `l-${lane.id}` : lane.intent!;
    const t = newTask(id, lane.objective ?? rec?.objective ?? `deliver lane ${lane.id}`, { repo: lane.repo, files: lane.declared ?? [], verify: lane.verify ?? "",
      risk: lane.risk?.length ? "risky" : "normal", baseBranch: lane.baseBranch ?? "", source: "orch", sender: "kiba-conductor", policy }, `task:${id}`);
    const follow = oldFollowups(root, rec);
    Object.assign(t, { next: "wait", lane: lane.id, workBranch: durableBranch(lane.repo, id, d.commit), ...(follow.length ? { revision: 2 } : {}) });
    evidence(t, "migrated", `delivery of lane ${lane.id} to ${d.branch} was pending in the retired conductor; the outbox resumes it`);
    plans.push({ key, task: t, effects: [{ key: `deliver:${id}:r1`, kind: "deliver", task: id, revision: 1,
      payload: { lane: lane.id, branch: d.branch, message: d.message }, status: "pending", attempts: 0, at }],
      ...(follow.length ? { followups: { revision: 2, rows: follow } } : {}) });
  }

  // Results and outside events nobody acknowledged.
  const acks = acknowledged(root);
  const results = old.filter((r) => WAKE_STATUSES.includes(r.status) && !acks.intents.has(r.id) && (r.owner || r.repo) && !imported.has(`result:${r.id}`));
  const cursor = Number(readJson<number>(join(oldConductorDir(root), "inbox.cursor")) ?? 0) || 0;
  const inbox = readJsonl<OldInbox>(join(oldConductorDir(root), "inbox.jsonl")).slice(cursor)
    .filter((l) => l.source !== "orch" && !acks.signals.has(l.id) && !imported.has(`inbox:${l.id}`));
  for (const r of results.slice(0, NOTIFY_CAP)) plans.push({ key: `result:${r.id}`, effects: [notice(`migration:result:${r.id}`,
    `Kiba: ${r.id} ${r.kind} ${r.status === "done" && r.integrate ? `to integrate (${r.integrate})` : r.status}`,
    [r.reason ?? r.objective ?? "", ...(plans.some((p) => p.task?.id === r.id) ? [] : oldFollowups(root, r).map((f) => `follow-up pending (${f.source ?? "other"}): ${f.text}`))].filter(Boolean).join("\n"))] });
  for (const l of inbox.slice(0, NOTIFY_CAP)) plans.push({ key: `inbox:${l.id}`, effects: [notice(`migration:inbox:${l.id}`, `Kiba: unread ${l.source} event ${l.id}`, l.line)] });
  const more = Math.max(0, results.length - NOTIFY_CAP) + Math.max(0, inbox.length - NOTIFY_CAP);
  if (more) plans.push({ key: `overflow:${at}`, effects: [notice(`migration:overflow:${at}`, `Kiba: ${more} more unread notifications`, `See ${oldConductorDir(root)} (intents.jsonl, inbox.jsonl).`)] });

  // Held threads go with the task that owns them.
  const held = heldThreadsAt(join(oldConductorDir(root), "threads.json"));

  const done = await store.change((s) => {
    s.migration ??= { items: [] };
    if (s.migration.done) return true;
    for (const p of plans) {
      if (s.migration.items.includes(p.key)) continue;
      if (p.task && !s.tasks[p.task.id]) {
        const t = p.task;
        for (const [thread, owner] of Object.entries(held)) if (owner === t.id) t.threads = [...new Set([...(t.threads ?? []), thread])];
        s.tasks[t.id] = t;
        report.tasks.push(t.id);
        if (p.event) {
          const key = `migrate:${t.id}:request`;
          const { policy: _p, ...mandate } = t.mandate;
          s.events[key] ??= { key, source: "orch", sender: "migration", kind: "request", thread: t.thread, task: t.id, text: p.text!, repo: t.mandate.repo,
            request: { objective: t.objective, mandate }, hash: hash(key), at, disposition: "input", revision: 1, routed: "rule" };
        }
        // Follow-ups after the request, in arrival order (stamped right after
        // it so the worker's history keeps that order), with their provenance.
        p.followups?.rows.forEach((f, n) => {
          const key = `migrate:${t.id}:followup:${n + 1}`;
          const ev: StoredEvent = { key, source: followupSource(f.source), sender: `kiba-conductor:${f.source ?? "other"}`, kind: "follow", thread: t.thread, task: t.id,
            text: f.text, repo: t.mandate.repo, hash: hash([key, f.at ?? "", f.text]), at: new Date(Date.parse(at) + n + 1).toISOString(), disposition: "input", revision: p.followups!.revision, routed: "rule" };
          s.events[key] ??= ev;
        });
      }
      for (const e of p.effects) if (!s.outbox[e.key]) { s.outbox[e.key] = e; report.effects.push(e.key); }
      s.migration.items.push(p.key);
    }
    if (!report.deferred.length) s.migration.done = at;
    return !report.deferred.length;
  });
  report.done = done;
  if (report.tasks.length) await syncThreads({ root, store });
  return report;
}

export function migrationText(r: MigrationReport): string {
  if (r.already) return "SERVE MIGRATE\nSTATUS: already done (the retired conductor's state was imported once)\n";
  return [
    "SERVE MIGRATE", `STATUS: ${r.done ? "done" : "partial: run it again once the deferred items end"}`,
    `TASKS: ${r.tasks.join(", ") || "none"}`, `EFFECTS: ${r.effects.join(", ") || "none"}`,
    ...r.deferred.map((d) => `DEFERRED: ${d}`), ...r.skipped.map((d) => `SKIPPED: ${d}`), "",
  ].join("\n");
}
