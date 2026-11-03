// `orch serve migrate` (P5): the retired conductor's live state under
// `<state>/kiba/` is imported once into the orch serve task store. One test
// per migrated kind, plus idempotence and PAUSE. Fakes only, no model call.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, fakeGh, readPrs, runLane, runOrch, tempEnv, tempRepo, type TempEnv } from "./harness.ts";

const fixtures: TempEnv[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

const VERIFY = "grep -q revision value.txt";

function setup() {
  const env = tempEnv();
  fixtures.push(env);
  const repo = tempRepo(env, { files: { "value.txt": "base\n" } });
  repo.git("config", "user.name", "agent-local");
  repo.git("config", "user.email", "agent-local@localhost");
  // Notifications go nowhere: no channel, no network.
  writeFileSync(join(env.root, "presence.yaml"), "session: kiba\nworkdir: /tmp\nnotify: none\n");
  env.env.ORCH_PRESENCE_CONFIG = join(env.root, "presence.yaml");
  const calls = join(env.root, "claude-calls.jsonl");
  writeFileSync(calls, "");
  fakeClaude(env, `
const fs = await import("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ agent: flags["--agent"], prompt, before: fs.existsSync("value.txt") ? fs.readFileSync("value.txt", "utf8") : null }) + "\\n");
if (flags["--agent"] === "router") return { result: JSON.stringify({ action: "ignore" }) };
return { files: { "value.txt": "revision 1\\n" }, result: "Changed value.txt; VERIFY passes." };`);
  const gh = fakeGh(env);
  const kiba = join(env.env.ORCH_STATE, "kiba");
  mkdirSync(join(kiba, "intents"), { recursive: true });
  return { env, ...repo, gh, calls, kiba };
}
type F = ReturnType<typeof setup>;

const deadPid = () => spawnSync("true").pid!;
const state = (f: F) => JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "tasks", "state.json"), "utf8"));
const workerCalls = (f: F) => readFileSync(f.calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.agent === "worker");
const jsonl = (path: string, rows: object[]) => appendFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""));
const snapshot = (dir: string): string => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => `${join(e.parentPath, e.name)}:${readFileSync(join(e.parentPath, e.name), "utf8")}`).sort().join("\n");
async function migrate(f: F) {
  const r = await runOrch(f.env, ["serve", "migrate"], { cwd: f.repo });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r.stdout;
}
async function serveOnce(f: F) {
  const r = await runOrch(f.env, ["serve", "--once"], { cwd: f.repo, timeoutMs: 90_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r;
}

// A running code intent of the old conductor, its spec and its last lane.
function runningIntent(f: F, id: string, pid: number, extra: object = {}) {
  const spec = { id, kind: "normal", objective: "Write the revision into value.txt", files: ["value.txt"], verify: VERIFY, thread: "T7" };
  mkdirSync(join(f.kiba, "intents", id), { recursive: true });
  writeFileSync(join(f.kiba, "intents", id, "intent.json"), JSON.stringify(spec));
  jsonl(join(f.kiba, "intents.jsonl"), [{ ...spec, status: "running", pid, repo: f.repo, owner: "mcp-1-x", at: "2026-11-03T09:00:00Z", ...extra }]);
}
function oldLane(f: F, id: string, intent: string) {
  f.git("branch", `lane/${id}`, "main");
  const dir = join(f.env.env.ORCH_STATE, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id, to: "claude", repo: f.repo, base: f.git("rev-parse", "main"), baseBranch: "main",
    branch: `lane/${id}`, worktree: join(f.env.root, "gone"), status: "failed", changed: false, usage: {}, intent, cleaned: true,
    started: "2026-11-03T09:00:01Z", ended: "2026-11-03T09:01:00Z", declared: ["value.txt"], verify: VERIFY }));
}

// A conductor lane whose delivery stopped half way: the PR was created but
// its response lost, so the checkpoint says delivery-pending.
async function pendingDelivery(f: F, intent: string, status: string, extra: object = {}) {
  const wt = join(f.env.root, "work");
  f.git("worktree", "add", "-q", "-b", "work/revision", wt, "main");
  writeFileSync(join(wt, "value.txt"), "revision native\n");
  const adopted = await runOrch(f.env, ["task", "adopt", "--worktree", wt, "--files", "value.txt", "--verify", VERIFY, "--goal", "Write the revision", "--base-branch", "main"], { cwd: f.repo });
  const lane = /^ID: (.+)$/m.exec(adopted.stdout)?.[1];
  expect(lane, adopted.stdout + adopted.stderr).toBeDefined();
  const message = join(f.env.root, "message.txt");
  writeFileSync(message, "fix: write the revision\n\nDelivered by the old conductor.\n");
  writeFileSync(f.gh.dropCreate, "");
  const first = await runLane(f.env, ["integrate", lane!, "--branch", "fix/revision", "--message-file", message], { cwd: f.repo });
  expect(first.stdout).toContain("STATUS: delivery-pending");
  expect(readPrs(f.gh.prs)).toHaveLength(1);
  const file = join(f.env.env.ORCH_STATE, "lanes", lane!, "state.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), intent }));
  jsonl(join(f.kiba, "intents.jsonl"), [{ id: intent, kind: "normal", status, repo: f.repo, owner: "mcp-1-x", objective: "Write the revision", at: "2026-11-03T09:00:00Z", ...extra }]);
  return lane!;
}

test("a running intent whose runner died becomes a task with its mandate, lane branch and a recovery note", async () => {
  const f = setup();
  runningIntent(f, "Kdead1", deadPid());
  oldLane(f, "L-dead1", "Kdead1");
  const before = snapshot(f.kiba);
  expect(await migrate(f)).toContain("TASKS: Kdead1");
  const t = state(f).tasks.Kdead1;
  expect(t).toMatchObject({ objective: "Write the revision into value.txt", state: "working", next: "execute", recovery: true, workBranch: "orch/task-Kdead1",
    mandate: { files: ["value.txt"], verify: VERIFY, risk: "normal", baseBranch: "main", source: "orch", sender: "kiba-conductor" } });
  expect(t.evidence.map((e: { kind: string }) => e.kind)).toEqual(["migrated", "recovery"]);
  expect(f.git("rev-parse", "orch/task-Kdead1")).toBe(f.git("rev-parse", "lane/L-dead1"));
  // The worker is relaunched only with the recovery note: it checks before redoing.
  await serveOnce(f);
  const calls = workerCalls(f);
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain("Recovery: an earlier attempt was interrupted");
  expect(calls[0].prompt).toContain("Write the revision into value.txt");
  expect(state(f).tasks.Kdead1).toMatchObject({ state: "ended", deliveredRevision: 1 });
  // The old state is only read.
  expect(snapshot(f.kiba)).toBe(before);
});

test("a running intent whose runner still lives is deferred, then imported once it ended", async () => {
  const f = setup();
  runningIntent(f, "Klive1", process.pid);
  const out = await migrate(f);
  expect(out).toContain("STATUS: partial");
  expect(out).toContain("DEFERRED: Klive1: its runner still runs");
  expect(state(f).tasks).toEqual({});
  expect(state(f).migration.done).toBeUndefined();
  jsonl(join(f.kiba, "intents.jsonl"), [{ id: "Klive1", kind: "normal", status: "running", pid: deadPid() }]);
  expect(await migrate(f)).toContain("STATUS: done");
  expect(state(f).tasks.Klive1).toMatchObject({ next: "execute", recovery: true });
});

test("a delivery-pending lane becomes an outbox delivery that finds the existing PR instead of opening another", async () => {
  const f = setup();
  const lane = await pendingDelivery(f, "Kdeliver", "done");
  expect(await migrate(f)).toContain("deliver:Kdeliver:r1");
  expect(state(f).outbox["deliver:Kdeliver:r1"]).toMatchObject({ status: "pending", payload: { lane, branch: "fix/revision" } });
  expect(state(f).tasks.Kdeliver).toMatchObject({ next: "wait", lane });
  await serveOnce(f);
  const prs = readPrs(f.gh.prs);
  expect(prs).toHaveLength(1);
  const s = state(f);
  expect(s.outbox["deliver:Kdeliver:r1"].status).toBe("done");
  expect(s.tasks.Kdeliver).toMatchObject({ state: "ended", branch: "fix/revision", pr: prs[0].url });
  expect(workerCalls(f)).toHaveLength(0);
});

test("unacknowledged results and events become notification effects, sent at most once", async () => {
  const f = setup();
  jsonl(join(f.kiba, "intents.jsonl"), [
    { id: "Kdone1", kind: "normal", status: "done", integrate: "L-9", repo: f.repo, owner: "mcp-1-x", objective: "fix it" },
    { id: "Kseen1", kind: "normal", status: "failed", repo: f.repo, owner: "mcp-1-x", reason: "acknowledged" },
  ]);
  jsonl(join(f.kiba, "inbox.jsonl"), [
    { id: "E1", source: "ci", line: "ci_fail main: build red", detail: "x" },
    { id: "E2", source: "ci", line: "ci_fail main: already read", detail: "x" },
    { id: "Kdone1-result", source: "orch", line: "normal done", detail: "x" },
  ]);
  jsonl(join(f.kiba, "notifications.jsonl"), [{ kind: "offer", id: "R1", recipient: { repo: f.repo }, signals: ["E2"], intents: ["Kseen1"] }, { kind: "ack", ids: ["R1"] }]);
  await migrate(f);
  const notes = Object.keys(state(f).outbox).sort();
  expect(notes).toEqual(["notify:migration:inbox:E1", "notify:migration:result:Kdone1"]);
  expect(state(f).outbox["notify:migration:result:Kdone1"].payload.title).toBe("Kiba: Kdone1 normal to integrate (L-9)");
  await serveOnce(f);
  const sent = state(f).outbox;
  for (const k of notes) expect(sent[k].status).toBe("done");
  const attempts = notes.map((k) => sent[k].attempts);
  await serveOnce(f);
  expect(notes.map((k) => state(f).outbox[k].attempts)).toEqual(attempts);
});

test("a thread held by a migrated intent becomes that task's thread binding", async () => {
  const f = setup();
  runningIntent(f, "Kthread", deadPid());
  writeFileSync(join(f.kiba, "threads.json"), JSON.stringify({ T7: "Kthread", T8: "Kfinished" }));
  await migrate(f);
  expect(state(f).tasks.Kthread.threads).toEqual(["T7"]);
  const bound = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "tasks", "threads.json"), "utf8"));
  expect(bound).toEqual({ T7: "Kthread" });
});

test("a cancelled intent stays cancelled: no task, its pending delivery is left undone", async () => {
  const f = setup();
  const lane = await pendingDelivery(f, "Kcancel", "cancelled");
  const out = await migrate(f);
  expect(out).toContain(`SKIPPED: ${lane}: intent Kcancel was cancelled`);
  expect(state(f).tasks).toEqual({});
  expect(Object.keys(state(f).outbox)).toEqual([]);
  await serveOnce(f);
  expect(readPrs(f.gh.prs)).toHaveLength(1);
  expect(existsSync(join(f.env.env.ORCH_STATE, "lanes", lane, "delivery.json"))).toBe(true);
});

test("migrate twice imports nothing new, and orch serve start does not import again", async () => {
  const f = setup();
  runningIntent(f, "Konce", deadPid());
  jsonl(join(f.kiba, "inbox.jsonl"), [{ id: "E1", source: "ci", line: "ci_fail main", detail: "x" }]);
  await migrate(f);
  const first = state(f);
  expect(Object.keys(first.tasks)).toEqual(["Konce"]);
  expect(first.migration.done).toBeString();
  expect(await migrate(f)).toContain("STATUS: already done");
  // A new old-state line after the marker is history: never imported.
  jsonl(join(f.kiba, "inbox.jsonl"), [{ id: "E9", source: "ci", line: "late", detail: "x" }]);
  writeFileSync(join(f.env.env.ORCH_STATE, "PAUSE"), "");
  await serveOnce(f);
  const again = state(f);
  expect(Object.keys(again.tasks)).toEqual(["Konce"]);
  expect(Object.keys(again.outbox).sort()).toEqual(Object.keys(first.outbox).sort());
  expect(again.migration).toEqual(first.migration);
});

test("PAUSE holds a migrated task and its effects; orch serve resumes them once cleared", async () => {
  const f = setup();
  runningIntent(f, "Kpause", deadPid());
  writeFileSync(join(f.env.env.ORCH_STATE, "PAUSE"), "");
  // orch serve imports at start, then PAUSE holds every step.
  await serveOnce(f);
  expect(state(f).tasks.Kpause).toMatchObject({ state: "idle", next: "execute" });
  expect(workerCalls(f)).toHaveLength(0);
  expect(readPrs(f.gh.prs)).toHaveLength(0);
  const resumed = await runOrch(f.env, ["resume"], { cwd: f.repo });
  expect(resumed.status, resumed.stderr).toBe(0);
  await serveOnce(f);
  expect(workerCalls(f)).toHaveLength(1);
  expect(state(f).tasks.Kpause).toMatchObject({ state: "ended", deliveredRevision: 1 });
});

// A real lane, complete and verified (orch task adopt), owned by an intent.
async function verifiedLane(f: F, intent: string) {
  const wt = join(f.env.root, `work-${intent}`);
  f.git("worktree", "add", "-q", "-b", `work/${intent}`, wt, "main");
  writeFileSync(join(wt, "value.txt"), "revision native\n");
  const adopted = await runOrch(f.env, ["task", "adopt", "--worktree", wt, "--files", "value.txt", "--verify", VERIFY, "--goal", "Write the revision", "--base-branch", "main"], { cwd: f.repo });
  const lane = /^ID: (.+)$/m.exec(adopted.stdout)![1]!;
  const file = join(f.env.env.ORCH_STATE, "lanes", lane, "state.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), intent }));
  return lane;
}
const intentSpec = (f: F, id: string) => {
  mkdirSync(join(f.kiba, "intents", id), { recursive: true });
  writeFileSync(join(f.kiba, "intents", id, "intent.json"), JSON.stringify({ id, kind: "normal", objective: "Write the revision", files: ["value.txt"], verify: VERIFY }));
};

test("a runner that died after its lane completed and passed VERIFY: one task, delivered, never executed again", async () => {
  // Without a delivery checkpoint: the verified lane is delivered as it is.
  const a = setup();
  const lane = await verifiedLane(a, "Kverified");
  intentSpec(a, "Kverified");
  jsonl(join(a.kiba, "intents.jsonl"), [{ id: "Kverified", kind: "normal", status: "running", pid: deadPid(), repo: a.repo, objective: "Write the revision" }]);
  await migrate(a);
  expect(state(a).tasks.Kverified).toMatchObject({ lane, next: "deliver", workBranch: "orch/task-Kverified" });
  expect(state(a).tasks.Kverified.recovery).toBeUndefined();
  await serveOnce(a);
  expect(workerCalls(a)).toHaveLength(0);
  expect(readPrs(a.gh.prs).map((p) => p.headRefName)).toEqual(["orch/Kverified-r1"]);
  expect(state(a).tasks.Kverified).toMatchObject({ state: "ended", deliveredRevision: 1 });
  // With a delivery checkpoint: the same single task resumes that delivery.
  const b = setup();
  intentSpec(b, "Kmidway");
  const pending = await pendingDelivery(b, "Kmidway", "running", { pid: deadPid() });
  await migrate(b);
  const s = state(b);
  expect(Object.keys(s.tasks)).toEqual(["Kmidway"]);
  expect(s.tasks.Kmidway).toMatchObject({ lane: pending, next: "wait" });
  expect(Object.keys(s.outbox).filter((k) => k.startsWith("deliver:"))).toEqual(["deliver:Kmidway:r1"]);
  await serveOnce(b);
  expect(workerCalls(b)).toHaveLength(0);
  expect(readPrs(b.gh.prs)).toHaveLength(1);
  expect(state(b).tasks.Kmidway).toMatchObject({ state: "ended", branch: "fix/revision" });
});

test("a legacy CI event the retired wake already delivered is not notified again", async () => {
  const f = setup();
  jsonl(join(f.kiba, "inbox.jsonl"), [
    { id: "E-old", source: "ci", line: "ci_fail main: delivered by the old wake", detail: "x" },
    { id: "E-tried", source: "ci", line: "ci_fail main: only a transport attempt", detail: "x" },
    { id: "E-new", source: "ci", line: "ci_fail main: never delivered", detail: "x" },
  ]);
  mkdirSync(join(f.kiba, "wake"), { recursive: true });
  // Pre-receipt rows carry no recipient (delivered); later rows are attempts only.
  jsonl(join(f.kiba, "wake", "delivered.jsonl"), [{ id: "E-old", via: "hook" }, { id: "E-tried", via: "tmux", repo: f.repo }]);
  await migrate(f);
  expect(Object.keys(state(f).outbox).sort()).toEqual(["notify:migration:inbox:E-new", "notify:migration:inbox:E-tried"]);
});

test("pending operator follow-ups are imported once, in order, with their provenance", async () => {
  const f = setup();
  runningIntent(f, "Kfollow", deadPid(), { followupsPending: [{ at: "2026-11-03T09:05:00Z", text: "Keep the old format readable.", source: "operator" }] });
  jsonl(join(f.kiba, "intents", "Kfollow", "followups.jsonl"), [
    { at: "2026-11-03T09:05:00Z", text: "Keep the old format readable.", source: "operator" },
    { at: "2026-11-03T09:06:00Z", text: "CI says the parser fails on empty input.", source: "ci" },
  ]);
  await migrate(f);
  const events = Object.values(state(f).events).filter((e: any) => e.task === "Kfollow" && e.kind === "follow") as any[];
  expect(events.map((e) => [e.source, e.text, e.revision, e.disposition])).toEqual([
    ["operator", "Keep the old format readable.", 1, "input"],
    ["github", "CI says the parser fails on empty input.", 1, "input"],
  ]);
  await serveOnce(f);
  const prompt = workerCalls(f)[0].prompt as string;
  const op = prompt.indexOf("[operator, trusted; new] Keep the old format readable.");
  const ci = prompt.indexOf("[github, untrusted data; new] CI says the parser fails on empty input.");
  expect(op).toBeGreaterThan(prompt.indexOf("Write the revision into value.txt"));
  expect(ci).toBeGreaterThan(op);
});

test("a migrated delivery keeps a working branch at its delivered commit, so a later revision starts from it", async () => {
  const f = setup();
  const lane = await pendingDelivery(f, "Kbranch", "done");
  const commit = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "lanes", lane, "delivery.json"), "utf8")).commit;
  await migrate(f);
  expect(state(f).tasks.Kbranch.workBranch).toBe("orch/task-Kbranch");
  expect(f.git("rev-parse", "orch/task-Kbranch")).toBe(commit);
  await serveOnce(f);
  const follow = await runOrch(f.env, ["task", "follow", "Kbranch", "Also log the revision."], { cwd: f.repo });
  expect(follow.stdout, follow.stderr).toContain("STATUS: input");
  await serveOnce(f);
  expect(workerCalls(f)).toHaveLength(1);
  expect(workerCalls(f)[0].before).toBe("revision native\n");
});
