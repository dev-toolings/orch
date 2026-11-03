import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneState } from "../../../src/lane.ts";
import { fakeCodex, fakeGh, runLane, runOrch, tempEnv, tempRepo, type TempEnv } from "./harness.ts";

const fixtures: TempEnv[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

function nativeWork(file = "allowed.txt", committed = true) {
  const env = tempEnv();
  fixtures.push(env);
  const repo = tempRepo(env, { develop: true, files: { "allowed.txt": "base\n" } });
  // Delivery uses git commit-tree with the caller's local identity.
  repo.git("config", "user.name", "agent-local");
  repo.git("config", "user.email", "agent-local@localhost");
  const wt = join(repo.repo, ".claude/worktrees/native");
  repo.git("worktree", "add", "-q", "-b", "native/change", wt, "develop");
  writeFileSync(join(wt, file), "native change\n");
  if (committed) {
    repo.git("-C", wt, "add", "-A");
    repo.git("-C", wt, "commit", "-q", "-m", "native work");
  }
  const gh = fakeGh(env);
  const message = join(env.root, "message.txt");
  writeFileSync(message, "feat: native work\n\nAdopted and verified locally.\n");
  return { env, ...repo, wt, gh, message };
}

async function adopt(f: ReturnType<typeof nativeWork>, extra: string[] = []) {
  const result = await runOrch(f.env, ["task", "adopt", "--worktree", f.wt,
    "--files", "allowed.txt", "--verify", "test -f allowed.txt", "--goal", "Deliver native work", ...extra], { cwd: f.repo });
  const id = /^ID: (.+)$/m.exec(result.stdout)?.[1];
  expect(id, result.stderr || result.stdout).toBeDefined();
  const state = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "lanes", id!, "state.json"), "utf8")) as LaneState;
  return { ...result, id: id!, state };
}

const deliver = (f: ReturnType<typeof nativeWork>, id: string) => runLane(f.env,
  ["integrate", id, "--branch", "feat/x", "--message-file", f.message], { cwd: f.repo });

test("native commit is adopted, pushed and delivered through the existing gate; native checkout survives replay", async () => {
  const f = nativeWork();
  const sha = f.git("-C", f.wt, "rev-parse", "HEAD");
  const adopted = await adopt(f);
  expect(adopted.status).toBe(0);
  expect(adopted.state).toMatchObject({ verifiedSha: sha, verifyOk: true, baseBranch: "develop", status: "complete", declared: ["allowed.txt"] });
  expect(adopted.state.base).toBe(f.git("merge-base", "develop", "native/change"));
  expect(adopted.state.worktree).not.toBe(f.wt);
  expect(adopted.stdout).toContain(`NEXT: lane integrate ${adopted.id} --branch <b> --message-file <f>`);
  const result = await deliver(f, adopted.id);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("DELIVERY: pr");
  expect(f.git("--git-dir", f.origin, "show", "feat/x:allowed.txt")).toBe("native change");
  const prs = readFileSync(f.gh.prs, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(prs).toHaveLength(1);
  expect(prs[0]).toMatchObject({ headRefName: "feat/x", baseRefName: "develop" });
  expect(existsSync(f.wt)).toBe(true);
  expect(f.git("-C", f.wt, "branch", "--show-current")).toBe("native/change");
  expect(f.git("branch", "--show-current")).toBe("develop");
  expect((await deliver(f, adopted.id)).stdout).toContain("REPLAY: completed delivery");
  expect(readFileSync(f.gh.prs, "utf8").trim().split("\n")).toHaveLength(1);
});

test("the unchanged FILES gate refuses native work outside the declaration", async () => {
  const f = nativeWork("outside.txt");
  const adopted = await adopt(f);
  expect(adopted.state.verifyOk).toBe(true);
  const result = await deliver(f, adopted.id);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("outside FILES: outside.txt");
  expect(readFileSync(f.gh.prs, "utf8")).toBe("");
});

test("failed VERIFY records no verified SHA and delivery refuses it", async () => {
  const f = nativeWork();
  const adopted = await adopt(f, ["--verify", "exit 9"]);
  expect(adopted.status).toBe(2);
  expect(adopted.state.verifyOk).toBe(false);
  expect(adopted.state.verifiedSha).toBeUndefined();
  const result = await deliver(f, adopted.id);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("VERIFY did not pass");
});

test("risky adoption requires a successful Codex review of the same commit", async () => {
  const f = nativeWork();
  fakeCodex(f.env, `
    if (flags["--model"] !== "gpt-6-astra" || !argv.includes('model_reasoning_effort="high"')) throw new Error("wrong review role");
    return { result: "VERDICT: ship", model: "gpt-6-astra" };
  `);
  const adopted = await adopt(f, ["--risk", "risky"]);
  expect(adopted.stdout).toContain(`NEXT: lane review --lane ${adopted.id}`);
  const refused = await deliver(f, adopted.id);
  expect(refused.status).not.toBe(0);
  expect(refused.stdout).toContain("no review yet");
  const review = await runLane(f.env, ["review", "--lane", adopted.id, "--from", "claude", "--profile", "kiba"], { cwd: f.repo });
  expect(review.status, review.stdout + review.stderr).toBe(0);
  const rows = readFileSync(join(f.env.env.ORCH_STATE, "lanes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.find((row) => row.kind === "review")).toMatchObject({ model: "gpt-6-astra", effort: "high", reviewedSha: adopted.state.verifiedSha, ok: true, verdict: "ship" });
  expect((await deliver(f, adopted.id)).status).toBe(0);
}, 15_000);

test("uncommitted native work is committed on its branch with the generic identity", async () => {
  const f = nativeWork("allowed.txt", false);
  const adopted = await adopt(f);
  expect(adopted.status).toBe(0);
  expect(f.git("-C", f.wt, "status", "--porcelain")).toBe("");
  expect(f.git("show", "-s", "--format=%an <%ae>", "native/change")).toBe("agent-local <agent-local@localhost>");
  expect(f.git("rev-parse", "native/change")).toBe(adopted.state.verifiedSha!);
});

test("branch-only adoption uses the branch tip without a native checkout", async () => {
  const f = nativeWork();
  f.git("worktree", "remove", f.wt);
  const result = await runOrch(f.env, ["task", "adopt", "--branch", "native/change", "--files", "allowed.txt", "--verify", "true"], { cwd: f.repo });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`SHA: ${f.git("rev-parse", "native/change")}`);
});

test("the recorded starting branch survives a caller checkout switch", async () => {
  const f = nativeWork();
  f.git("checkout", "-q", "main");
  const adopted = await adopt(f);
  expect(adopted.state.baseBranch).toBe("develop");
  expect(adopted.state.base).toBe(f.git("merge-base", "develop", "native/change"));
});

test("adoption inside the native checkout resolves its original branch", async () => {
  const f = nativeWork();
  const result = await runOrch(f.env, ["task", "adopt", "--worktree", f.wt,
    "--files", "allowed.txt", "--verify", "true"], { cwd: f.wt });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const id = /^ID: (.+)$/m.exec(result.stdout)![1];
  const state = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "lanes", id, "state.json"), "utf8"));
  expect(state.baseBranch).toBe("develop");
  expect(existsSync(f.wt)).toBe(true);
});

test("adoption VERIFY receives the lane environment without caller-only variables", async () => {
  const f = nativeWork();
  f.env.env.ADOPT_CALLER_ONLY = "fixture-value";
  const adopted = await adopt(f, ["--verify", 'test -z "$ADOPT_CALLER_ONLY" && test -z "$ORCH_STATE" && test "$PWD" = "$LANE_WORKTREE" && test "$ORCH_LANE" = 1']);
  expect(adopted.status, adopted.stdout + adopted.stderr).toBe(0);
  expect(adopted.state.verifyOk).toBe(true);
});

test("explicit worktree takeover allows the lane delivery to remove it", async () => {
  const f = nativeWork();
  const adopted = await adopt(f, ["--take-worktree"]);
  expect(adopted.state.worktree).toBe(f.wt);
  const result = await deliver(f, adopted.id);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(existsSync(f.wt)).toBe(false);
  expect(f.git("rev-parse", "native/change")).toBe(adopted.state.verifiedSha!);
});

test("VERIFY cannot certify a tracked tree it rewrote", async () => {
  const f = nativeWork();
  const adopted = await adopt(f, ["--verify", "echo rewritten > allowed.txt"]);
  expect(adopted.status).toBe(2);
  expect(adopted.state.verifiedSha).toBeUndefined();
  expect((await deliver(f, adopted.id)).stdout).toContain("no verified commit recorded");
});

test("VERIFY reach rejects a command that tests a different checkout", async () => {
  const f = nativeWork();
  const adopted = await adopt(f, ["--verify", "docker exec existing test -f allowed.txt"]);
  expect(adopted.status).toBe(2);
  expect(adopted.state.verifyOk).toBe(false);
  expect(adopted.state.verifiedSha).toBeUndefined();
  expect(readFileSync(join(f.env.env.ORCH_STATE, "lanes", adopted.id, "verify.log"), "utf8")).toContain("checkout");
});

test("a branch with no recorded origin needs --base-branch instead of a guess", async () => {
  const f = nativeWork();
  // Created from HEAD: git records no named origin for this branch.
  f.git("worktree", "remove", f.wt);
  f.git("checkout", "-q", "--detach", "native/change");
  f.git("branch", "native/from-head");
  f.git("checkout", "-q", "main");
  const guessed = await runOrch(f.env, ["task", "adopt", "--branch", "native/from-head", "--files", "allowed.txt", "--verify", "true"], { cwd: f.repo });
  expect(guessed.status).not.toBe(0);
  expect(guessed.stdout + guessed.stderr).toContain("--base-branch");
  const explicit = await runOrch(f.env, ["task", "adopt", "--branch", "native/from-head", "--base-branch", "develop",
    "--files", "allowed.txt", "--verify", "true"], { cwd: f.repo });
  expect(explicit.status, explicit.stderr).toBe(0);
  const id = /^ID: (.+)$/m.exec(explicit.stdout)![1];
  const state = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "lanes", id, "state.json"), "utf8")) as LaneState;
  expect(state.baseBranch).toBe("develop");
});

test("adopted from inside the native checkout, the lane still delivers after Claude removes it", async () => {
  const f = nativeWork();
  const result = await runOrch(f.env, ["task", "adopt", "--worktree", f.wt, "--files", "allowed.txt", "--verify", "true"], { cwd: f.wt });
  expect(result.status, result.stderr).toBe(0);
  const id = /^ID: (.+)$/m.exec(result.stdout)![1];
  const state = JSON.parse(readFileSync(join(f.env.env.ORCH_STATE, "lanes", id, "state.json"), "utf8")) as LaneState;
  expect(state.repo).toBe(f.git("rev-parse", "--show-toplevel"));
  f.git("worktree", "remove", "--force", f.wt);
  expect(existsSync(f.wt)).toBe(false);
  expect((await deliver(f, id)).status).toBe(0);
});

test("VERIFY runs in a recorded process group that the reaper can kill", async () => {
  const f = nativeWork();
  const marker = join(f.env.root, "verify-started");
  const run = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../../src/orch.ts"), "task", "adopt", "--worktree", f.wt,
    "--files", "allowed.txt", "--verify", `touch ${marker}; sleep 30`], { cwd: f.repo, env: f.env.env, stdout: "ignore", stderr: "ignore" });
  // The child can start VERIFY before the parent saves workerPgid: wait for both.
  const lanes = join(f.env.env.ORCH_STATE, "lanes");
  const recorded = async (): Promise<LaneState | undefined> => {
    if (!existsSync(marker) || !existsSync(lanes)) return undefined;
    const id = (await Array.fromAsync(new Bun.Glob("*-adopt-*").scan({ cwd: lanes, onlyFiles: false })))[0];
    if (!id || !existsSync(join(lanes, id, "state.json"))) return undefined;
    const state = JSON.parse(readFileSync(join(lanes, id, "state.json"), "utf8")) as LaneState;
    return state.workerPgid ? state : undefined;
  };
  const deadline = Date.now() + 10_000;
  let state = await recorded();
  while (!state && Date.now() < deadline) { await Bun.sleep(50); state = await recorded(); }
  expect(state?.workerPgid).toBeGreaterThan(0);
  run.kill("SIGKILL");
  await run.exited;
  const reaped = await runLane(f.env, ["status"], { cwd: f.repo });
  expect(reaped.status).toBe(0);
  let alive = true;
  try { process.kill(-state!.workerPgid!, 0); } catch { alive = false; }
  expect(alive).toBe(false);
}, 30_000);
