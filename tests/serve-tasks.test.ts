import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, LIVE_LIMITS, RECOVERY_NOTE, TaskStore, type Effect, type Mandate, type TaskEvent } from "../src/core/tasks.ts";
import { threadHolderAt } from "../src/core/threads.ts";
import { commentOnce, DEFAULT_SERVE_POLICY, drainOutbox, pollGithubSource, syncThreads, type EngineDeps } from "../src/serve/engine.ts";
import { publishDecision } from "../src/serve/publish-guard.ts";
import { parseRouterDecision } from "../src/serve/router.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const mandate: Mandate = { repo: "/repo", files: ["value.txt"], verify: "true", risk: "normal", baseBranch: "main", source: "operator", sender: "cli", policy: 1 };
const request: TaskEvent = { key: "op-1", source: "operator", sender: "cli", kind: "request", thread: "task:T1", task: "T1", text: "do it", request: { objective: "do it", mandate } };

async function created(risk: Mandate["risk"] = "normal") {
  const root = mkdtempSync(join(tmpdir(), "orch-tasks-test-"));
  dirs.push(root);
  const store = new TaskStore(join(root, "tasks"));
  await store.receive({ ...request, request: { objective: "do it", mandate: { ...mandate, risk } } });
  await store.createTask("op-1", { id: "T1", objective: "do it", mandate: { ...mandate, risk }, thread: "task:T1" }, "operator");
  return store;
}
const deadPid = () => spawnSync("true").pid!;
async function run(store: TaskStore, kind: "execute" | "verify" | "review", receipt: Parameters<TaskStore["reconcile"]>[1]) {
  const job = (await store.plan("T1", kind))!;
  expect(job.kind).toBe(kind);
  await store.reconcile(job.id, receipt);
  return job;
}

test("receive persists once: duplicate by key, conflicting reuse refused, filtered rows kept", async () => {
  const store = await created();
  expect(await store.receive(request)).toBe("duplicate");
  await expect(store.receive({ ...request, text: "other" })).rejects.toThrow("different content");
  expect(await store.receive({ key: "gh-1", source: "github", sender: "github", kind: "ci_pass", thread: "b", text: "green" }, () => "green CI")).toBe("filtered");
  expect(store.read().events["gh-1"]).toMatchObject({ disposition: "filtered", reason: "green CI" });
});

test("a task runs execute, verify and delivery, ends, then resumes on its thread with the same session", async () => {
  const store = await created();
  const session = store.read().tasks.T1.session;
  await run(store, "execute", { ok: true, session });
  expect(store.read().events["op-1"].disposition).toBe("consumed");
  await run(store, "verify", { ok: true, lane: "L1", sha: "a".repeat(40), changed: true });
  expect(store.read().tasks.T1.next).toBe("deliver");
  await store.enqueue({ key: "T1:r1", kind: "deliver", task: "T1", revision: 1, payload: { lane: "L1" } }, (t) => { t.next = "wait"; });
  await store.completed("deliver:T1:r1", { branch: "orch/T1-r1", pr: "https://pr/1" });
  expect(store.read().tasks.T1).toMatchObject({ state: "ended", next: "none", deliveredRevision: 1, pr: "https://pr/1" });
  await store.receive({ key: "op-2", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "more" });
  expect(await store.route("op-2", "T1", "input", "operator")).toBe("input");
  const t = store.read().tasks.T1;
  expect(t).toMatchObject({ state: "working", next: "execute", revision: 2, session, sessionStarted: true, mandate });
  expect((await store.plan("T1", "execute"))!.inputs).toEqual(["op-2"]);
});

test("a dead verify job is planned again as verify with the recovery note, never as execute", async () => {
  const store = await created();
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  const job = (await store.plan("T1", "verify"))!;
  await store.started(job.id, deadPid());
  expect(await store.reconcile(job.id)).toBe("interrupted");
  expect(store.read().tasks.T1.next).toBe("verify");
  expect(store.history("T1", [])).toContain(RECOVERY_NOTE);
});

test("a failed VERIFY becomes an orch input of the same session and counts a failure", async () => {
  const store = await created();
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  await run(store, "verify", { ok: false, error: "expected 2, got 1" });
  const t = store.read().tasks.T1;
  expect(t).toMatchObject({ next: "execute", failures: 1, revision: 2 });
  expect(store.history("T1", Object.keys(store.read().events).filter((k) => k.startsWith("orch:")))).toContain("[orch; new] VERIFY failed: expected 2, got 1");
});

test("a worker question waits for a person; a risky change without ship waits for review", async () => {
  const store = await created("risky");
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session, question: "Which format?" });
  expect(store.read().tasks.T1).toMatchObject({ state: "person/answer", next: "wait" });
  await store.receive({ key: "op-2", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "CSV" });
  await store.route("op-2", "T1", "input", "operator");
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  await run(store, "verify", { ok: true, lane: "L1", sha: "b".repeat(40), changed: true });
  expect(store.read().tasks.T1.next).toBe("review");
  await run(store, "review", { ok: true, verdict: "change" });
  expect(store.read().tasks.T1).toMatchObject({ state: "person/review", next: "wait" });
});

test("a stop by a person withdraws pending effects and refuses later inputs", async () => {
  const store = await created();
  await store.enqueue({ key: "T1:r1", kind: "deliver", task: "T1", revision: 1, payload: {} });
  await store.stop("T1", "operator-cli");
  expect(store.read().outbox["deliver:T1:r1"].status).toBe("withdrawn");
  await store.receive({ key: "op-3", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "go on" });
  expect(await store.route("op-3", "T1", "input", "operator")).toBe("refused");
  expect(await store.plan("T1", "execute")).toBeUndefined();
});

test("a PR comment whose response was lost is found by its marker, never posted twice", async () => {
  const comments: { body: string; url: string }[] = [];
  let lose = true;
  const gh = (args: string[]) => {
    if (args[1] === "view") return JSON.stringify({ comments });
    comments.push({ body: args[args.indexOf("--body") + 1], url: `c${comments.length + 1}` });
    if (lose) { lose = false; return null; }
    return "c";
  };
  const e = { key: "comment:T1:r2", kind: "comment", task: "T1", payload: { repo: "/repo", pr: "https://pr/1", body: "superseded" }, status: "pending", attempts: 0, at: "" } as Effect;
  expect(await commentOnce(e, gh)).toMatchObject({ done: false });
  expect(await commentOnce(e, gh)).toEqual({ done: true, receipt: { pr: "https://pr/1", comment: "c1" } });
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toContain("<!-- orch:comment:T1:r2 -->");
});

test("the router answer is a closed list; publishing commands are denied to workers", () => {
  expect(parseRouterDecision('{"action":"forward","task":"T1"}', ["T1"])).toEqual({ action: "forward", task: "T1" });
  expect(parseRouterDecision('{"action":"forward","task":"T9"}', ["T1"]).action).toBe("ignore");
  expect(parseRouterDecision('plan: fix the bug\n{"action":"new","files":"x"}', []).action).toBe("ignore");
  for (const command of ["git push", "cd x && git push origin HEAD", "gh pr create --fill", "gh api repos/x/y", "git -C . push"]) {
    expect(publishDecision({ tool_name: "Bash", tool_input: { command } })).toContain('"deny"');
  }
  expect(publishDecision({ tool_name: "Bash", tool_input: { command: "git status && bun test" } })).toBeNull();
});

// ---- Review fixes (one test per finding).

test("a follow-up with no running job invalidates a pending verify or delivery and executes first", async () => {
  const store = await created();
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  expect(store.read().tasks.T1.next).toBe("verify");
  await store.receive({ key: "op-2", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "also this" });
  await store.route("op-2", "T1", "input", "operator");
  expect(store.read().tasks.T1).toMatchObject({ next: "execute", revision: 2 });
  expect(await store.plan("T1", "verify")).toBeUndefined();
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  await run(store, "verify", { ok: true, lane: "L2", sha: "c".repeat(40), changed: true });
  await store.receive({ key: "op-3", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "one more" });
  await store.route("op-3", "T1", "input", "operator");
  expect(store.read().tasks.T1).toMatchObject({ next: "execute", revision: 3 });
});

test("delivery completion records the thread and downstream effects in one write; a restarted engine rebinds the thread", async () => {
  const store = await created();
  await store.change((s) => { s.tasks.T1.pr = "https://pr/1"; });
  await store.enqueue({ key: "T1:r2", kind: "deliver", task: "T1", revision: 2, payload: {} });
  // The engine dies right after this write: nothing else ran.
  await store.completed("deliver:T1:r2", { branch: "orch/T1-r2", pr: "https://pr/2" }, { notify: true, thread: "branch:/repo:orch/T1-r2" });
  const s = store.read();
  expect(s.tasks.T1.threads).toEqual(["task:T1", "branch:/repo:orch/T1-r2"]);
  expect(s.outbox["comment:T1:r2"]).toMatchObject({ status: "pending", payload: { pr: "https://pr/1" } });
  expect(s.outbox["notify:T1:delivered:r2"].status).toBe("pending");
  const root = join(store.root, "..");
  await syncThreads({ root, store: new TaskStore(store.root) });
  expect(threadHolderAt(join(root, "tasks", "threads.json"), "branch:/repo:orch/T1-r2")).toBe("T1");
});

test("a renamed PR never poisons the GitHub poll: known reviews are skipped by identity and later events still arrive", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-poll-test-"));
  dirs.push(root);
  const prs = [{ number: 1, headRefName: "a", title: "first", url: "u1", reviews: [{ id: "R1", state: "CHANGES_REQUESTED", submittedAt: "", author: { login: "x" } }] }];
  const gh = (args: string[]) => args[0] === "repo" ? "o/r\n" : args[0] === "run" ? "[]" : JSON.stringify(prs);
  const d = { root, store: new TaskStore(join(root, "tasks")), policy: { ...DEFAULT_SERVE_POLICY, repos: [{ path: join(root, "repo"), files: ["x"], verify: "true", risk: "normal" as const }] },
    gh, log: () => {} } as unknown as EngineDeps;
  await pollGithubSource(d); // backlog
  prs[0].title = "renamed";
  prs.push({ number: 2, headRefName: "b", title: "second", url: "u2", reviews: [{ id: "R2", state: "CHANGES_REQUESTED", submittedAt: "", author: { login: "y" } }] });
  expect(await pollGithubSource(d)).toBe(1);
  expect(d.store.read().events["gh-review-o/r-R2"].disposition).toBe("new");
  expect(d.store.read().events["gh-review-o/r-R1"].text).toContain("first");
});

test("an effect withdrawn while an earlier publication was awaited is never published", async () => {
  const store = await created();
  await store.enqueue({ key: "T1:r1", kind: "deliver", task: "T1", revision: 1, payload: {} });
  await store.enqueue({ key: "T1:x", kind: "comment", task: "T1", payload: { repo: "/repo", pr: "p", body: "b" } });
  const published: string[] = [];
  const publisher = {
    async deliver(e: Effect) { published.push(e.key); await store.stop("T1", "operator-cli"); return { done: false as const, error: "pending" }; },
    async comment(e: Effect) { published.push(e.key); return { done: true as const, receipt: {} }; },
    async notify(e: Effect) { published.push(e.key); return { done: true as const, receipt: {} }; },
  };
  const root = join(store.root, "..");
  await drainOutbox({ root, store, publisher, policy: DEFAULT_SERVE_POLICY, channels: [], log: () => {} } as unknown as EngineDeps, { once: true, attempted: new Map(), polledAt: 0, recovered: true }, false);
  expect(published).toEqual(["deliver:T1:r1"]);
  expect(store.read().outbox["comment:T1:x"].status).toBe("withdrawn");
});

test("a long run keeps the live state file bounded; archived keys still deduplicate and an ended task still resumes", async () => {
  const store = await created();
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  await store.change((s) => {
    for (let n = 0; n < 3000; n++) {
      const id = `T${n + 2}`, t = { ...s.tasks.T1, id, thread: `task:${id}`, threads: [`task:${id}`], state: "ended" as const, next: "none" as const, updated: at(n), evidence: s.tasks.T1.evidence.slice() };
      s.tasks[id] = t;
      s.events[`e${n}`] = { key: `e${n}`, source: "github", sender: "github", kind: "review", thread: t.thread, task: id, text: "x".repeat(200), hash: hash([`e${n}`, "github", "github", "review", t.thread, id, "", "x".repeat(200), null]), at: at(n), disposition: "consumed" };
      s.jobs[`${id}-r1-execute-1`] = { id: `${id}-r1-execute-1`, task: id, revision: 1, kind: "execute", inputs: [], status: "complete", receipt: { ok: true, result: "y".repeat(300) } };
      s.outbox[`deliver:${id}:r1`] = { key: `deliver:${id}:r1`, kind: "deliver", task: id, revision: 1, payload: { lane: "L", branch: "b", message: "m".repeat(200) }, status: "done", attempts: 1, at: at(n) };
    }
  });
  await store.compact();
  const size = statSync(join(store.root, "state.json")).size;
  expect(size).toBeLessThan(600 * 1024);
  const s = store.read();
  expect(Object.keys(s.tasks).length).toBeLessThanOrEqual(LIVE_LIMITS.endedTasks + 1);
  expect(Object.keys(s.events).length).toBeLessThanOrEqual(LIVE_LIMITS.events + 1);
  // e0 was archived with its task; the compact index still knows it.
  expect(s.events.e0).toBeUndefined();
  expect(await store.receive({ key: "e0", source: "github", sender: "github", kind: "review", thread: "task:T2", task: "T2", text: "x".repeat(200) })).toBe("duplicate");
  await store.receive({ key: "op-9", source: "operator", sender: "cli", kind: "follow", thread: "task:T2", task: "T2", text: "again" });
  expect(await store.route("op-9", "T2", "input", "operator")).toBe("input");
  expect(store.read().tasks.T2).toMatchObject({ state: "working", next: "execute" });
});

test("a started session gets only the new messages and a one-line summary", async () => {
  const store = await created();
  await run(store, "execute", { ok: true, session: store.read().tasks.T1.session });
  await store.receive({ key: "op-2", source: "operator", sender: "cli", kind: "follow", thread: "task:T1", task: "T1", text: "second" });
  await store.route("op-2", "T1", "input", "operator");
  const text = store.history("T1", ["op-2"]);
  expect(text).toContain("[operator, trusted; new] second");
  expect(text).toContain("Earlier messages are in this session");
  expect(text).not.toContain("do it");
});
