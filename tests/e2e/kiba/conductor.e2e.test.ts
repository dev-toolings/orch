// orch serve (conductor v2) end to end: temp repo with a bare origin, fake
// claude worker and router, fake gh. One test per behavior; no model call.
import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeClaude, fakeGh, readPrs, runCommand, runOrch, tempEnv, tempRepo, type TempEnv } from "./harness.ts";

const fixtures: TempEnv[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.pid) try { process.kill(c.pid, "SIGKILL"); } catch {}
  for (const f of fixtures.splice(0)) f.cleanup();
});

const VERIFY = "grep -q revision value.txt";

// The fake claude logs every call; a worker writes value.txt, the router
// answers ignore. `extra` runs first inside the fake (fs, calls in scope).
function setup(opts: { extra?: string; verify?: string } = {}) {
  const env = tempEnv();
  fixtures.push(env);
  const repo = tempRepo(env, { files: { "value.txt": "base\n" } });
  repo.git("config", "user.name", "agent-local");
  repo.git("config", "user.email", "agent-local@localhost");
  const calls = join(env.root, "claude-calls.jsonl");
  writeFileSync(calls, "");
  fakeClaude(env, `
const fs = await import("node:fs");
const calls = ${JSON.stringify(calls)};
fs.appendFileSync(calls, JSON.stringify({ agent: flags["--agent"], resume: flags["--resume"] ?? null, sessionId: flags["--session-id"] ?? null, cwd: process.cwd(), settings: flags["--settings"] ?? null, prompt }) + "\\n");
if (flags["--agent"] === "router") return { result: JSON.stringify({ action: "ignore" }) };
${opts.extra ?? ""}
const n = fs.readFileSync(calls, "utf8").trim().split("\\n").filter(l => JSON.parse(l).agent === "worker").length;
return { files: { "value.txt": "revision " + n + "\\n" }, result: "Changed value.txt; VERIFY passes." };`);
  const gh = fakeGh(env);
  return { env, ...repo, gh, calls, verify: opts.verify ?? VERIFY };
}
type F = ReturnType<typeof setup>;

const claudeCalls = (f: F) => readFileSync(f.calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const workerCalls = (f: F) => claudeCalls(f).filter((c) => c.agent === "worker");
const state = (f: F) => JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "tasks", "state.json"), "utf8"));
const serveOnce = async (f: F) => {
  const r = await runOrch(f.env, ["serve", "--once"], { cwd: f.repo, timeoutMs: 90_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r;
};
async function newTask(f: F, extra: string[] = []) {
  const r = await runOrch(f.env, ["task", "new", "--repo", f.repo, "--files", "value.txt", "--verify", f.verify, ...extra, "Write the revision into value.txt"], { cwd: f.repo });
  const id = /^TASK: (\S+)$/m.exec(r.stdout)?.[1];
  expect(id, r.stdout + r.stderr).toBeDefined();
  return id!;
}
function policy(f: F, github: Record<string, string>) {
  const dir = join(f.env.env.HOME, ".orch", "policy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "serve.yaml"), [
    "version: 1", "router: claude", "repos:", `  - path: ${f.repo}`, "    files: value.txt", `    verify: "${f.verify}"`, "    base: main",
    "github:", ...Object.entries(github).map(([k, v]) => `  ${k}: ${v}`), "",
  ].join("\n"));
}
function startServe(f: F): ChildProcess {
  const child = spawn(process.execPath, ["--no-env-file", resolve(import.meta.dir, "../../../src/orch.ts"), "serve", "--once"],
    { cwd: f.repo, env: f.env.env, detached: true, stdio: "ignore" });
  children.push(child);
  return child;
}
async function waitFor(check: () => boolean, ms = 30_000) {
  const until = Date.now() + ms;
  while (!check()) { if (Date.now() > until) throw new Error("timed out waiting"); await Bun.sleep(50); }
}
const exited = (c: ChildProcess) => new Promise<void>((done) => { if (c.exitCode !== null || c.signalCode !== null) done(); else c.once("exit", () => done()); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const originHas = (f: F, branch: string) => {
  try { f.git("--git-dir", f.origin, "rev-parse", "--verify", `refs/heads/${branch}`); return true; } catch { return false; }
};

test("the same GitHub CI event received twice creates one task", async () => {
  const f = setup();
  policy(f, { ci_fail: "admit" });
  await serveOnce(f); // first poll: the repository's backlog is recorded, nothing sent
  writeFileSync(f.gh.runs, JSON.stringify([{ databaseId: 42, headBranch: "main", headSha: "a".repeat(40), workflowName: "ci", conclusion: "failure", url: "https://github.example/agent-local/repo/actions/runs/42", createdAt: "2026-11-03T10:00:00Z" }]));
  await serveOnce(f);
  await serveOnce(f); // the same run again: the store answers duplicate
  const s = state(f);
  expect(Object.keys(s.tasks)).toHaveLength(1);
  const task = Object.values(s.tasks)[0] as any;
  expect(task.mandate).toMatchObject({ source: "github", files: ["value.txt"], verify: f.verify });
  expect(s.events["gh-run-agent-local/repo-42"]).toMatchObject({ disposition: "consumed", routed: "rule" });
  expect(workerCalls(f)).toHaveLength(1);
  expect(readPrs(f.gh.prs)).toHaveLength(1);
});

test("a follow-up on a known thread reaches the owning worker session with zero router calls", async () => {
  const f = setup();
  policy(f, { review: "route" });
  const id = await newTask(f);
  await serveOnce(f);
  const [pr] = readPrs(f.gh.prs);
  expect(pr.headRefName).toBe(`orch/${id}-r1`);
  // A reviewer asks for changes on the delivered PR: its thread belongs to the task.
  writeFileSync(f.gh.prs, JSON.stringify({ ...pr, reviews: [{ id: "R1", state: "CHANGES_REQUESTED", submittedAt: "2026-11-03T11:00:00Z", author: { login: "reviewer" } }] }) + "\n");
  await serveOnce(f);
  await serveOnce(f);
  const s = state(f), calls = workerCalls(f);
  expect(s.counters).toEqual({ router: 0, direct: 1 });
  expect(claudeCalls(f).filter((c) => c.agent === "router")).toHaveLength(0);
  expect(calls).toHaveLength(2);
  expect(calls[1].resume).toBe(calls[0].sessionId);
  expect(calls[1].prompt).toContain("changes requested by reviewer");
  expect(s.tasks[id]).toMatchObject({ state: "ended", revision: 2, deliveredRevision: 2 });
  const prs = readPrs(f.gh.prs);
  expect(prs.map((p) => p.headRefName)).toEqual([`orch/${id}-r1`, `orch/${id}-r2`]);
  // The outbox told the first PR once, found by its marker on the replay.
  expect(prs[0].comments).toHaveLength(1);
  expect(prs[0].comments[0].body).toContain(`<!-- orch:comment:${id}:r2 -->`);
});

test("orch serve killed during VERIFY restarts without relaunching the worker", async () => {
  const f = setup({ verify: "" });
  const marker = join(f.env.root, "verify-started");
  f.verify = `touch ${marker} && sleep 2 && ${VERIFY}`;
  const id = await newTask(f);
  const first = startServe(f);
  await waitFor(() => existsSync(marker));
  process.kill(first.pid!, "SIGKILL"); // the engine only: its jobs run in their own groups
  await exited(first);
  const running = Object.values(state(f).jobs).find((j: any) => j.kind === "verify") as any;
  expect(running.status).toBe("running");
  expect(alive(running.pid)).toBe(true);
  await serveOnce(f);
  const s = state(f);
  expect(workerCalls(f)).toHaveLength(1);
  const verifies = Object.values(s.jobs).filter((j: any) => j.kind === "verify") as any[];
  expect(verifies.map((j) => [j.id, j.status])).toEqual([[running.id, "complete"]]);
  expect(s.tasks[id]).toMatchObject({ state: "ended", deliveredRevision: 1 });
  expect(readPrs(f.gh.prs)).toHaveLength(1);
});

test("a lost delivery acknowledgement is replayed by finding the existing PR, with no duplicate", async () => {
  const f = setup();
  const id = await newTask(f);
  writeFileSync(f.gh.dropCreate, "");
  await serveOnce(f);
  let s = state(f);
  const key = `deliver:${id}:r1`;
  expect(s.outbox[key]).toMatchObject({ status: "pending", attempts: 1 });
  expect(readPrs(f.gh.prs)).toHaveLength(1);
  await serveOnce(f);
  s = state(f);
  const prs = readPrs(f.gh.prs);
  expect(prs).toHaveLength(1);
  expect(s.outbox[key]).toMatchObject({ status: "done", receipt: { branch: `orch/${id}-r1`, pr: prs[0].url } });
  expect(s.tasks[id]).toMatchObject({ state: "ended", pr: prs[0].url });
  const creates = readFileSync(f.gh.calls, "utf8").trim().split("\n").map((l) => JSON.parse(l).argv).filter((a) => a[0] === "pr" && a[1] === "create");
  expect(creates).toHaveLength(1);
  expect(workerCalls(f)).toHaveLength(1);
});

test("PAUSE holds new work; stop cancels a running worker cleanly and blocks any resumption", async () => {
  const f = setup({ extra: `fs.writeFileSync(process.env.LANE_REPO + "/../worker-pid", String(process.pid)); await Bun.sleep(60_000);` });
  const pidFile = join(f.env.root, "worker-pid");
  const id = await newTask(f);
  writeFileSync(join(f.env.env.ORCH_STATE, "PAUSE"), "");
  await serveOnce(f);
  expect(workerCalls(f)).toHaveLength(0);
  expect(state(f).tasks[id]).toMatchObject({ state: "idle", next: "execute" });
  rmSync(join(f.env.env.ORCH_STATE, "PAUSE"));
  const engine = startServe(f);
  await waitFor(() => existsSync(pidFile));
  const worker = Number(readFileSync(pidFile, "utf8"));
  const stop = await runOrch(f.env, ["task", "stop", id], { cwd: f.repo });
  expect(stop.stdout).toContain("STATUS: stopped");
  await exited(engine);
  expect(engine.exitCode).toBe(0);
  await waitFor(() => !alive(worker), 5000);
  const s = state(f);
  expect(Object.values(s.jobs).map((j: any) => j.status)).toEqual(["cancelled"]);
  expect(s.tasks[id]).toMatchObject({ state: "ended", next: "none", stopped: { by: "operator-cli" } });
  const follow = await runOrch(f.env, ["task", "follow", id, "please continue"], { cwd: f.repo });
  expect(follow.stdout).toContain("STATUS: refused");
  await serveOnce(f);
  expect(workerCalls(f)).toHaveLength(1);
  expect(readPrs(f.gh.prs)).toHaveLength(0);
});

test("a worker cannot publish: its push is denied by settings and hook, and the outbox delivers", async () => {
  const f = setup({ extra: `
const settings = JSON.parse(flags["--settings"]);
const command = "git push origin HEAD:refs/heads/worker-push";
const rule = (settings.permissions?.deny ?? []).find(r => { const m = /^Bash\\((.*)\\)$/.exec(r); if (!m) return false; const p = m[1]; return p.endsWith(" *") ? command.startsWith(p.slice(0, -1)) : command === p; });
const {spawnSync} = await import("node:child_process");
const hooks = (settings.hooks?.PreToolUse ?? []).filter(h => new RegExp("^(" + h.matcher + ")$").test("Bash")).flatMap(h => h.hooks);
const hookDenied = hooks.some(h => /"permissionDecision":"deny"/.test(spawnSync("sh", ["-c", h.command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" }).stdout));
fs.writeFileSync(process.env.LANE_REPO + "/../push-attempt.json", JSON.stringify({ rule: rule ?? null, hookDenied }));
if (!rule && !hookDenied) spawnSync("sh", ["-c", command]);` });
  const id = await newTask(f);
  await serveOnce(f);
  const attempt = JSON.parse(readFileSync(join(f.env.root, "push-attempt.json"), "utf8"));
  expect(attempt).toEqual({ rule: "Bash(git push *)", hookDenied: true });
  expect(originHas(f, "worker-push")).toBe(false);
  expect(originHas(f, `orch/${id}-r1`)).toBe(true);
  expect(readPrs(f.gh.prs)).toHaveLength(1);
  expect(state(f).tasks[id].state).toBe("ended");
});

test("an ended task resumes on a new message on its thread with the same session and mandate", async () => {
  const f = setup();
  const id = await newTask(f);
  await serveOnce(f);
  const before = state(f).tasks[id];
  expect(before).toMatchObject({ state: "ended", deliveredRevision: 1 });
  const follow = await runOrch(f.env, ["task", "follow", id, "Also keep the revision number current"], { cwd: f.repo });
  expect(follow.stdout).toContain("STATUS: input");
  await serveOnce(f);
  const after = state(f).tasks[id], calls = workerCalls(f);
  expect(calls).toHaveLength(2);
  expect(calls[0].sessionId).toBe(before.session);
  expect(calls[1].resume).toBe(before.session);
  expect(calls[1].cwd).toBe(calls[0].cwd);
  expect(calls[1].prompt).toContain("[operator, trusted; new] Also keep the revision number current");
  expect(after).toMatchObject({ state: "ended", revision: 2, deliveredRevision: 2, session: before.session, mandate: before.mandate, thread: before.thread });
  expect(f.git("--git-dir", f.origin, "show", `orch/${id}-r2:value.txt`)).toBe("revision 2");
});

test("an ambiguous event with no task triggers exactly one router call", async () => {
  const f = setup();
  policy(f, { review: "route" });
  await serveOnce(f); // seeds the repository
  writeFileSync(f.gh.prs, JSON.stringify({ number: 7, url: "https://github.example/agent-local/repo/pull/7", state: "OPEN", project: f.repo,
    headRefName: "feature/unknown", baseRefName: "main", title: "Someone else's change", body: "",
    reviews: [{ id: "R7", state: "CHANGES_REQUESTED", submittedAt: "2026-11-03T12:00:00Z", author: { login: "reviewer" } }] }) + "\n");
  await serveOnce(f);
  await serveOnce(f);
  const s = state(f);
  expect(s.counters.router).toBe(1);
  expect(claudeCalls(f).filter((c) => c.agent === "router")).toHaveLength(1);
  expect(s.events["gh-review-agent-local/repo-R7"]).toMatchObject({ disposition: "ignored", routed: "router" });
  expect(Object.keys(s.tasks)).toHaveLength(0);
});

// ---- Review fixes.

test("a worker environment cannot publish: push, operator alias, explicit URL and API call fail; the outbox delivers", async () => {
  const token = "operator-secret";
  const authorized: string[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
    authorized.push(new URL(req.url).pathname);
    return Response.json({ number: 99 }, { status: 201 });
  } });
  try {
    const f = setup({ extra: `
const {spawnSync} = await import("node:child_process");
const r = spawnSync("bash", [process.env.LANE_REPO + "/../publish.sh"], { cwd: process.cwd(), encoding: "utf8" });
fs.writeFileSync(process.env.LANE_REPO + "/../publish-results.txt", r.stdout);` });
    // The operator's own credentials: an env token, gh auth and a git alias in HOME.
    f.env.env.GH_TOKEN = token;
    mkdirSync(join(f.env.env.HOME, ".config", "gh"), { recursive: true });
    writeFileSync(join(f.env.env.HOME, ".config", "gh", "hosts.yml"), `github.com:\n    oauth_token: ${token}\n`);
    writeFileSync(join(f.env.env.HOME, ".gitconfig"), `[alias]\n\tship = push ${f.origin} HEAD:refs/heads/alias-push\n`);
    const url = `http://127.0.0.1:${api.port}/repos/agent-local/repo/pulls`;
    writeFileSync(join(f.env.root, "publish.sh"), [
      `tok="\${GH_TOKEN:-$(sed -n 's/.*oauth_token: //p' "$HOME/.config/gh/hosts.yml" 2>/dev/null)}"`,
      `git push origin HEAD:refs/heads/worker-push >/dev/null 2>&1; echo "push $?"`,
      `git ship >/dev/null 2>&1; echo "alias $?"`,
      `git push ${f.origin} HEAD:refs/heads/url-push >/dev/null 2>&1; echo "url $?"`,
      `echo "api $(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $tok" ${url})"`, "",
    ].join("\n"));
    const id = await newTask(f);
    await serveOnce(f);
    const results = Object.fromEntries(readFileSync(join(f.env.root, "publish-results.txt"), "utf8").trim().split("\n").map((l) => l.split(" ")));
    expect(results.push).not.toBe("0");
    expect(results.alias).not.toBe("0");
    expect(results.url).not.toBe("0");
    expect(results.api).toBe("401");
    expect(authorized).toEqual([]);
    for (const b of ["worker-push", "alias-push", "url-push"]) expect(originHas(f, b)).toBe(false);
    expect(originHas(f, `orch/${id}-r1`)).toBe(true);
    expect(readPrs(f.gh.prs)).toHaveLength(1);
  } finally { api.stop(true); }
});

// Plans one execute job as an engine would, in the fixture environment;
// `launch` also spawns it, then this "engine" exits before anything else.
async function plannedJob(f: F, id: string, launch: boolean): Promise<string> {
  const src = resolve(import.meta.dir, "../../../src");
  const code = `
import { TaskStore, tasksDir } from ${JSON.stringify(join(src, "core/tasks.ts"))};
import { ensureWorktree, launchJob } from ${JSON.stringify(join(src, "serve/engine.ts"))};
const root = process.env.ORCH_STATE, store = new TaskStore(tasksDir(root));
const { wt, branch } = ensureWorktree(root, store.read().tasks[${JSON.stringify(id)}]);
await store.setWorktree(${JSON.stringify(id)}, wt, branch);
const job = await store.plan(${JSON.stringify(id)}, "execute");
if (${launch}) launchJob(root, job, { budgetUsd: 1, timeoutMs: 60000 });
console.log(job.id);`;
  const r = await runCommand(f.env, [process.execPath, "--no-env-file", "-e", code], { cwd: f.repo });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

test("an engine crash between spawn and start does not repeat the worker revision", async () => {
  const f = setup({ extra: "await Bun.sleep(1500);" });
  const id = await newTask(f);
  const job = await plannedJob(f, id, true); // spawned, never recorded as started
  await serveOnce(f);
  const s = state(f);
  expect(workerCalls(f)).toHaveLength(1);
  expect(Object.values(s.jobs).filter((j: any) => j.kind === "execute").map((j: any) => [j.id, j.status])).toEqual([[job, "complete"]]);
  expect(s.tasks[id]).toMatchObject({ state: "ended", deliveredRevision: 1 });
});

test("PAUSE holds a planned job at recovery and at the job's own entry", async () => {
  const f = setup();
  const id = await newTask(f);
  const job = await plannedJob(f, id, false); // planned, the engine died before spawning
  const pause = join(f.env.env.ORCH_STATE, "PAUSE");
  writeFileSync(pause, "");
  await serveOnce(f);
  const direct = await runCommand(f.env, [process.execPath, "--no-env-file", resolve(import.meta.dir, "../../../src/serve/job.ts"), f.env.env.ORCH_STATE, job], { cwd: f.repo });
  expect(direct.status).toBe(0);
  expect(workerCalls(f)).toHaveLength(0);
  expect(state(f).jobs[job].status).toBe("planned");
  rmSync(pause);
  await serveOnce(f);
  expect(workerCalls(f)).toHaveLength(1);
  expect(state(f).tasks[id].state).toBe("ended");
});
