import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { laneAsk, laneContest, laneFollow, laneGc, laneReview, laneRun, leadHarness, listLanes, listOrphans, resolveReviewer, setupCommand } from "../src/lane.ts";
import { bound } from "../src/core/output.ts";
import { laneReport } from "../src/lanes/report.ts";
import { SNAPSHOT_LIMITS, statusPaths } from "../src/lanes/worktree.ts";
import { loadProfile, type Profile } from "../src/core/profile.ts";
import { releaseSlot, reserveSlot } from "../src/lanes/slots.ts";
import { laneBudget } from "../src/lanes/budget.ts";
import { readLedger } from "../src/lanes/ledger.ts";

let root: string;
let repo: string;
let bin: string;
const savedPath = process.env.PATH;
const savedHome = process.env.HOME;
const savedState = process.env.ORCH_STATE;
const savedOrchHome = process.env.ORCH_HOME;
const savedOrcaEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("ORCA_")));
// Hermetic: these tests may run inside a lane VERIFY, where ORCH_LANE=1 is
// inherited and would trip the depth guard of every laneRun below.
const savedLane = process.env.ORCH_LANE;
const loadedProfile = loadProfile("max20");
const profile: Profile = { ...loadedProfile, limits: { ...loadedProfile.limits, max_concurrent_ceiling: 5, report_max_bytes: 4096, timeout_seconds: 30 } };

const SPEC = (verify: string) => `OBJECTIVE: create out.txt
FILES: out.txt
INTERFACES: none
CONSTRAINTS: touch nothing else
VERIFY: ${verify}
ACCEPT: out.txt exists
`;

function sh(cwd: string, cmd: string) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const stdoutPath = join(root, `cli-${Math.random().toString(36).slice(2)}.out`);
  const stderrPath = `${stdoutPath}.err`;
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  const result = spawnSync(process.execPath, args, {
    cwd: join(import.meta.dir, ".."), env, stdio: ["ignore", stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return { ...result, stdout: readFileSync(stdoutPath, "utf8"), stderr: readFileSync(stderrPath, "utf8") };
}

// Fake harness binary: its behavior is baked into the script.
function fake(name: string, body: string) {
  fakeAt(bin, name, body);
}

function fakeAt(targetBin: string, name: string, body: string) {
  const p = join(targetBin, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
  chmodSync(p, 0o755);
}

function fakeOrca(callsPath: string) {
  fake("orca", `printf '%s\\n' "$*" >> "$ORCA_CALLS"
case "$1 $2" in
  "repo show") printf '{"ok":true,"result":{"repo":{"externalWorktreeVisibility":"hide"}}}\\n' ;;
  "worktree show")
    for arg in "$@"; do case "$arg" in
      id:*) printf '{"ok":true,"result":{"worktree":{"id":"%s","repoId":"lead-repo","path":"/elsewhere/lead"}}}\\n' "\${arg#id:}"; exit 0 ;;
      path:*) shown=\${arg#path:} ;;
    esac; done
    printf '{"ok":true,"result":{"worktree":{"id":"repo-id::%s","repoId":"repo-id","path":"%s"}}}\\n' "$shown" "$shown"
    ;;
  "terminal create") printf '{"ok":true,"result":{"terminal":{"handle":"term_x"}}}\\n' ;;
  "worktree rm")
    for arg in "$@"; do case "$arg" in path:*) git -C "$TEST_REPO_PATH" worktree remove --force "\${arg#path:}" ;; esac; done
    printf '{"ok":true,"result":{"removed":true}}\\n' ;;
  *) printf '{"ok":true,"result":{}}\\n' ;;
esac`);
  process.env.ORCA_CALLS = callsPath;
  process.env.TEST_REPO_PATH = repo;
}

function spec(verify: string) {
  const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, SPEC(verify));
  return p;
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_")) delete process.env[key];
  delete process.env.ORCH_LANE;
  root = mkdtempSync(join(tmpdir(), "lane-test-"));
  repo = join(root, "repo");
  bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  sh(repo, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  process.env.ORCH_STATE = join(root, "state");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  // Hermetic HOME: Grok lanes need orch's profile, never the operator's files.
  process.env.HOME = join(root, "home");
  delete process.env.ORCH_HOME;
  mkdirSync(join(root, "home", ".grok"), { recursive: true });
  writeFileSync(join(root, "home", ".grok", "sandbox.toml"), readFileSync(join(import.meta.dir, "..", "catalog", "grok-sandbox.toml"), "utf8"));
}, 30_000);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_")) delete process.env[key];
  Object.assign(process.env, savedOrcaEnv);
  process.env.PATH = savedPath;
  if (savedLane !== undefined) process.env.ORCH_LANE = savedLane;
  process.env.HOME = savedHome;
  if (savedState === undefined) delete process.env.ORCH_STATE;
  else process.env.ORCH_STATE = savedState;
  if (savedOrchHome !== undefined) process.env.ORCH_HOME = savedOrchHome;
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("lane run classes", () => {
  test("a worker whose log shows a write outside its worktree fails the lane, and integrate refuses it", async () => {
    const outside = "/home/nobody-orch-test/escaped.txt";
    const events = [
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: outside, content: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "written" }] } },
      { type: "result", result: "LANE: done", session_id: "s-escape", is_error: false },
    ].map((e) => JSON.stringify(e)).join("\n");
    fake("claude", `echo hi > out.txt; cat <<'JSON'\n${events}\nJSON`);
    const { state, report } = await laneRun({ to: "claude", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.status).toBe("failed");
    expect(state?.escapes?.written).toEqual([outside]);
    expect(report).toContain("wrote outside its worktree");
    const { laneIntegrate } = await import("../src/lane.ts");
    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("worker wrote outside its worktree");
  });

  test("auth and quota results become unavailable reports with engine health, even without a LANE line", async () => {
    const { engineHealth } = await import("../src/harness/health.ts");
    const { specFailures } = await import("../src/lanes/route.ts");
    for (const [text, reason] of [["OAuth session expired. Please run /login", "login expiré"], ["usage limit reached (429)", "quota atteint"]]) {
      fake("claude", `printf '%s\\n' '${JSON.stringify({ type: "result", result: text, is_error: true })}'`);
      const result = await laneRun({ to: "claude", specPath: spec("true"), repo, profile });
      expect(result.state?.status).toBe("unavailable");
      expect(result.report).toContain(`REASON: claude: ${reason}`);
      expect(result.report).not.toContain("worker ended without a LANE line");
      expect(engineHealth(process.env.ORCH_STATE).claude?.reason).toBe(reason);
      const rows = readLedger(process.env.ORCH_STATE);
      const row = rows.find((r) => r.kind === "run" && r.id === result.state?.id);
      if (!row || row.kind !== "run") throw new Error("missing run ledger");
      expect(specFailures(row.features, [row])).toBe(0);
    }
  });

  test("Codex JSON events populate lane usage and progress with stdin closed", async () => {
    const events = [
      { type: "turn.started" },
      { type: "item.started", item: { id: "cmd", type: "command_execution", command: "true" } },
      { type: "item.completed", item: { id: "cmd", type: "command_execution", exit_code: 0 } },
      { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10 } },
    ];
    fake("codex", `echo hi > out.txt\nprintf '%s\\n' ${events.map((e) => `'${JSON.stringify(e)}'`).join(" ")}`);
    const result = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(result.state?.status).toBe("complete");
    expect(result.state?.usage).toMatchObject({ input: 100, cacheRead: 20, output: 10, total: 130 });
    expect(result.report).not.toContain("USAGE: not reported");
    const progress = JSON.parse(readFileSync(join(process.env.ORCH_STATE!, "lanes", result.state!.id, "progress.json"), "utf8"));
    expect(progress).toMatchObject({ phase: "done", turns: 1, toolCalls: 1, lastTool: "Bash" });
  });

  test("lane follow also preserves auth outages as unavailable with the engine reason", async () => {
    fake("codex", "echo hi > out.txt");
    const initial = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(initial.state?.status).toBe("complete");
    fake("codex", "echo 'Failed to authenticate'; exit 1");
    const report = await laneFollow(initial.state!.id, "finish the change");
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("REASON: codex: login expiré");
    const { engineHealth } = await import("../src/harness/health.ts");
    expect(engineHealth(process.env.ORCH_STATE).codex?.kind).toBe("auth");
  });

  test("Orca shows a lane as a child with status and a worker log terminal", async () => {
    const callsPath = join(root, "orca-calls-enabled");
    const savedWorktreeId = process.env.ORCA_WORKTREE_ID;
    const savedCalls = process.env.ORCA_CALLS;
    const savedTestRepo = process.env.TEST_REPO_PATH;
    try {
      fakeOrca(callsPath);
      process.env.ORCA_WORKTREE_ID = "lead-repo::/elsewhere/lead";
      fake("codex", "sleep 1; echo hi > out.txt"); // leaves the background attach time to finish
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state?.status).toBe("complete");
      expect(report).toMatch(/^STATUS: complete$/m);
      expect(report).toContain("ORCA: repo set to show non-Orca worktrees");

      const calls = readFileSync(callsPath, "utf8").trim().split("\n");
      expect(calls.some((line) => line.startsWith("worktree set") && line.includes("--parent-worktree id:lead-repo::/elsewhere/lead"))).toBe(true);
      expect(calls.some((line) => line.startsWith("repo set") && line.includes("--external-worktree-visibility show"))).toBe(true);
      const logPath = /^LOG: (.+)$/m.exec(report)?.[1];
      expect(logPath).toBeDefined();
      expect(calls.some((line) => line.startsWith("terminal create") && line.includes(`tail -n +1 -F '${logPath}'`))).toBe(true);
      expect(calls.some((line) => line.startsWith("terminal close") && line.includes("--terminal term_x"))).toBe(true);
      // The checkout lives in Orca's workspace directory and Orca removes it,
      // so Orca forgets the card instead of keeping a ghost.
      const wt = join(process.env.HOME!, "orca", "workspaces", basename(repo), "orch-lanes", state!.id);
      expect(state?.worktree).toBe(wt);
      expect(calls.some((line) => line === `worktree rm --worktree path:${wt} --force --json`)).toBe(true);
      expect(existsSync(wt)).toBe(false);
      expect(calls.join("\n")).not.toMatch(/worktree create|--all/);
    } finally {
      if (savedWorktreeId === undefined) delete process.env.ORCA_WORKTREE_ID;
      else process.env.ORCA_WORKTREE_ID = savedWorktreeId;
      if (savedCalls === undefined) delete process.env.ORCA_CALLS;
      else process.env.ORCA_CALLS = savedCalls;
      if (savedTestRepo === undefined) delete process.env.TEST_REPO_PATH;
      else process.env.TEST_REPO_PATH = savedTestRepo;
    }
  });

  test("lane run never calls Orca without ORCA_WORKTREE_ID", async () => {
    const callsPath = join(root, "orca-calls-disabled");
    const savedWorktreeId = process.env.ORCA_WORKTREE_ID;
    const savedCalls = process.env.ORCA_CALLS;
    const savedTestRepo = process.env.TEST_REPO_PATH;
    try {
      fakeOrca(callsPath);
      delete process.env.ORCA_WORKTREE_ID;
      fake("codex", "echo hi > out.txt");
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state?.status).toBe("complete");
      expect(report).toMatch(/^STATUS: complete$/m);
      expect(report).not.toMatch(/^ORCA:/m);
      expect(existsSync(callsPath)).toBe(false);
    } finally {
      if (savedWorktreeId === undefined) delete process.env.ORCA_WORKTREE_ID;
      else process.env.ORCA_WORKTREE_ID = savedWorktreeId;
      if (savedCalls === undefined) delete process.env.ORCA_CALLS;
      else process.env.ORCA_CALLS = savedCalls;
      if (savedTestRepo === undefined) delete process.env.TEST_REPO_PATH;
      else process.env.TEST_REPO_PATH = savedTestRepo;
    }
  });

  test("complete: change committed on the lane branch, usage parsed", async () => {
    fake("codex", 'sleep 0.2; echo hi > out.txt; echo "tokens used"; echo "1 234"');
    const { report, state } = await laneRun({ to: "codex", specPath: spec("sleep 0.2; test -f out.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain("USAGE: total 1234");
    expect(state?.peakRssMb?.worker).toBeGreaterThan(0);
    expect(state?.peakRssMb?.verify).toBeGreaterThan(0);
    expect(report).toMatch(/^PEAK RSS: worker \d+ MB, verify \d+ MB$/m);
    expect(report).toContain(`INTEGRATE: git merge --squash ${state!.branch}`);
    expect(sh(repo, `git show --stat ${state!.branch}`).stdout).toContain("out.txt");
    // Finished: the worktree is cut at once, the branch carries the result.
    expect(existsSync(state!.worktree)).toBe(false);
    const prompt = readFileSync(join(process.env.ORCH_STATE!, "lanes", state!.id, "prompt.txt"), "utf8");
    expect(prompt).toContain("BRIEF");
    expect(prompt).toContain("OBJECTIVE: create out.txt");
    expect(prompt).toContain("This is a new conversation");
    expect(state!.verify).toMatch(/test -f out.txt/);
  });

  test("follow recreates the worktree from the lane branch after a normal cut", async () => {
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(existsSync(state!.worktree)).toBe(false);
    const before = sh(repo, `git rev-parse ${state!.branch}`).stdout.trim();
    fake("codex", "echo follow >> out.txt");
    const out = await laneFollow(state!.id, "also add a comment");
    expect(out).toMatch(/^STATUS: ok$/m);
    expect(existsSync(state!.worktree)).toBe(true);
    expect(out).toContain("LANE FOLLOW");
    expect(out).toMatch(/^VERIFY:/m);
    const after = sh(repo, `git rev-parse ${state!.branch}`).stdout.trim();
    expect(after).not.toBe(before);
    expect(sh(repo, `git show --stat ${state!.branch}`).stdout).toContain("out.txt");
    const followRow = readLedger().find((r) => r.kind === "run" && r.id === state!.id && r.channel === "follow");
    expect(followRow).toBeDefined();
    if (followRow && followRow.kind === "run") {
      expect(followRow.verifyOk).toBe(true);
      expect(followRow.verifiedSha).toBe(after);
    }
    const live = listLanes().find((l) => l.id === state!.id);
    expect(live?.verifiedSha).toBe(after);
  });

  test("follow reuses the lane model/effort and records only the session cost delta", async () => {
    const argvFile = join(root, "follow-model-argv");
    fake("claude", `echo "$@" > ${argvFile}; echo hi > out.txt; echo '{"result":"LANE: done","session_id":"sess-follow","model":"claude-haiku-4-5","total_cost_usd":0.02,"usage":{"input_tokens":100,"output_tokens":20}}'`);
    const { state } = await laneRun({
      to: "claude", specPath: spec("test -f out.txt"), repo, profile, model: "haiku", effort: "low",
    });
    expect(state?.status).toBe("complete");
    expect(state?.model).toBe("haiku");
    expect(state?.effort).toBe("low");
    expect(state?.usage.costUsd).toBeCloseTo(0.02);
    expect(readFileSync(argvFile, "utf8")).toContain("--model haiku");
    expect(readFileSync(argvFile, "utf8")).toContain("--effort low");

    fake("claude", `echo "$@" > ${argvFile}; echo follow >> out.txt; echo '{"result":"LANE: done","session_id":"sess-follow","model":"claude-haiku-4-5","total_cost_usd":0.025,"usage":{"input_tokens":10,"output_tokens":5}}'`);
    const out = await laneFollow(state!.id, "also add a comment");
    expect(out).toMatch(/^STATUS: ok$/m);
    const followArgv = readFileSync(argvFile, "utf8");
    expect(followArgv).toContain("--model haiku");
    expect(followArgv).toContain("--effort low");
    expect(followArgv).not.toContain("sonnet");
    expect(followArgv).not.toContain("xhigh");
    expect(followArgv).toContain("--resume sess-follow");

    const followRows = readLedger().filter((r) => r.kind === "run" && r.id === state!.id && r.channel === "follow");
    expect(followRows.length).toBe(1);
    const followRow = followRows[0];
    if (followRow.kind === "run") {
      expect(followRow.model).toBe("claude-haiku-4-5");
      expect(followRow.effort).toBe("low");
      expect(followRow.usage.costUsd).toBeCloseTo(0.005);
      expect(followRow.usage.input).toBe(10);
    }
    const live = listLanes().find((l) => l.id === state!.id);
    expect(live?.usage.costUsd).toBeCloseTo(0.025);
    expect(live?.model).toBe("haiku");
    expect(live?.effort).toBe("low");

    fake("claude", `echo "$@" > ${argvFile}; echo more >> out.txt; echo '{"result":"LANE: done","session_id":"sess-follow","model":"claude-opus-4-5","total_cost_usd":0.04,"usage":{"input_tokens":8,"output_tokens":3}}'`);
    const pinned = await laneFollow(state!.id, "switch model", { model: "opus" });
    expect(pinned).toMatch(/^STATUS: ok$/m);
    const pinnedArgv = readFileSync(argvFile, "utf8");
    expect(pinnedArgv).toContain("--model opus");
    expect(pinnedArgv).toContain("--effort low");
    expect(pinnedArgv).not.toContain("haiku");
    const second = readLedger().filter((r) => r.kind === "run" && r.id === state!.id && r.channel === "follow").at(-1);
    if (second && second.kind === "run") {
      expect(second.model).toBe("claude-opus-4-5");
      expect(second.effort).toBe("low");
      expect(second.usage.costUsd).toBeCloseTo(0.015);
    }
    expect(listLanes().find((l) => l.id === state!.id)?.usage.costUsd).toBeCloseTo(0.04);
  });

  test("follow: worker LANE: blocked + VERIFY ok is complete", async () => {
    fake("claude", `echo hi > out.txt; echo '{"result":"LANE: done","session_id":"s-follow-blocked"}'`);
    const { state } = await laneRun({ to: "claude", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    fake("claude", `echo follow >> out.txt; printf '\\n{"type":"result","session_id":"s-follow-blocked","result":"%s"}\\n' 'Bash tool denied, so VERIFY was not run.\\nLANE: blocked: Bash tool denied'`);
    const out = await laneFollow(state!.id, "also add a comment");
    expect(out).toMatch(/^STATUS: ok$/m);
    expect(out).toContain("REASON: worker blocked: Bash tool denied");
    const live = listLanes().find((l) => l.id === state!.id);
    expect(live?.status).toBe("complete");
    expect(live?.verifyOk).toBe(true);
    const followRow = readLedger().filter((r) => r.kind === "run" && r.id === state!.id && r.channel === "follow").at(-1);
    if (followRow && followRow.kind === "run") expect(followRow.status).toBe("complete");
  });

  test("follow: worker LANE: done + VERIFY fail is not complete", async () => {
    fake("claude", `echo hi > out.txt; echo '{"result":"LANE: done","session_id":"s-follow-fail"}'`);
    const { state } = await laneRun({ to: "claude", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    fake("claude", `rm -f out.txt; printf '\\n{"type":"result","session_id":"s-follow-fail","result":"%s"}\\n' 'Created out.txt.\\nLANE: done'`);
    const out = await laneFollow(state!.id, "remove the file");
    expect(out).not.toMatch(/^STATUS: ok$/m);
    expect(out).toMatch(/^STATUS: failed$/m);
    const live = listLanes().find((l) => l.id === state!.id);
    expect(live?.verifyOk).toBe(false);
    expect(live?.status).toBe("failed");
  });

  test("noop: nothing changed and VERIFY passes", async () => {
    fake("codex", "true");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("noop");
  });

  test("refused: nothing changed and VERIFY fails", async () => {
    fake("codex", "echo 'I will not do that'");
    expect((await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile })).state?.status).toBe("refused");
  });

  test("failed: worker exits non-zero after editing", async () => {
    fake("codex", "echo x > out.txt; exit 3");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("failed");
  });

  test("blocked: permission denial without change", async () => {
    fake("codex", "echo 'Permission denied by sandbox' >&2; exit 1");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("blocked");
  });

  test("claude: a run that stops on a progress note is resumed until it says LANE: done", async () => {
    fake("claude", `case " $* " in
  *" --resume s1 "*) echo hi > out.txt; printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'Created out.txt.\\nLANE: done' 5 7 ;;
  *) printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'Next I will create out.txt.' 3 4 ;;
esac`);
    const { report, state } = await laneRun({ to: "claude", specPath: spec("test -f out.txt"), repo, profile: { ...profile, limits: { ...profile.limits, timeout_seconds: 120 } } });
    expect(state?.status).toBe("complete");
    expect(state?.reason).toBeUndefined();
    expect(report).toContain("WORKER SAID: Created out.txt. LANE: done");
    expect(report).toContain("USAGE: input 8, output 11, total 19");
  });

  test("claude: no LANE line after the continuations is never a noop", async () => {
    fake("claude", `printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'I will start with the tests.' 1 1`);
    const { report, state } = await laneRun({ to: "claude", specPath: spec("true"), repo, profile: { ...profile, limits: { ...profile.limits, timeout_seconds: 300 } } });
    expect(state?.status).toBe("failed");
    expect(report).toContain("worker ended without a LANE line after 2 continuation(s)");
  });

  test("claude: LANE: blocked without a change reports blocked", async () => {
    fake("claude", `printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'LANE: blocked: no database fixture' 1 1`);
    const { report, state } = await laneRun({ to: "claude", specPath: spec("true"), repo, profile });
    expect(state?.status).toBe("blocked");
    expect(report).toContain("REASON: worker blocked: no database fixture");
  });

  test("claude: LANE: blocked with VERIFY passing is complete; worker note is kept", async () => {
    fake("claude", `echo half > out.txt; printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'Bash tool denied, so VERIFY was not run.\\nLANE: blocked: Bash tool denied' 1 1`);
    const { report, state } = await laneRun({ to: "claude", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.changed).toBe(true);
    expect(state?.verifyOk).toBe(true);
    expect(state?.status).toBe("complete");
    expect(state?.reason).toContain("worker blocked: Bash tool denied");
    expect(report).toMatch(/^STATUS: complete$/m);
    expect(report).toContain("REASON: worker blocked: Bash tool denied");
  });

  test("claude: LANE: done with VERIFY failing is not complete", async () => {
    fake("claude", `echo hi > out.txt; printf '\n{"type":"result","session_id":"s1","result":"%s","usage":{"input_tokens":%s,"output_tokens":%s}}\n' 'Created out.txt.\\nLANE: done' 1 1`);
    const { report, state } = await laneRun({ to: "claude", specPath: spec("test -f missing.txt"), repo, profile });
    expect(state?.changed).toBe(true);
    expect(state?.verifyOk).toBe(false);
    expect(state?.status).toBe("failed");
    expect(report).toMatch(/^STATUS: failed$/m);
    expect(report).not.toMatch(/^STATUS: complete$/m);
  });

  test("unavailable: harness binary missing", async () => {
    rmSync(join(bin, "claude"), { force: true });
    const { report, state } = await laneRun({ to: "claude", specPath: spec("true"), repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("claude is not installed (installed:");
  });

  test("timeout: the whole process group is stopped", async () => {
    const marker = join(root, "late-write");
    fake("grok", `(sleep 3; touch ${marker}) & sleep 30`);
    const short = { ...profile, limits: { ...profile.limits, timeout_seconds: 1 } };
    const { state } = await laneRun({ to: "grok", specPath: spec("true"), repo, profile: short });
    expect(state?.status).toBe("timeout");
    await Bun.sleep(3500);
    expect(existsSync(marker)).toBe(false);
  });

  test("secrets in the lead's environment never reach the worker", async () => {
    process.env.SECRET_TOKEN = "s3cr3t";
    fake("codex", "env > env.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile });
    delete process.env.SECRET_TOKEN;
    const dumped = sh(repo, `git show ${state!.branch}:env.txt`).stdout;
    expect(dumped).toContain("PATH=");
    expect(dumped).not.toContain("s3cr3t");
  });

  test("dirty caller tree: worker starts from a snapshot, caller state untouched", async () => {
    const dirty = join(root, "dirty");
    mkdirSync(dirty);
    sh(dirty, "git init -q && echo v1 > shared.txt && git add shared.txt && git -c user.email=t@t -c user.name=t commit -q -m init");
    writeFileSync(join(dirty, "shared.txt"), "v2\n");
    writeFileSync(join(dirty, "component.txt"), "new\n");
    // The lane branch is lane run's own output; everything else of the caller must stay byte-identical.
    const probe = () => sh(dirty, "git status --porcelain; git rev-parse HEAD; git branch -a | grep -v ' lane/'; git stash list").stdout;
    const before = probe();
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: dirty, profile });
    expect(probe()).toBe(before);
    expect(state?.status).toBe("complete");
    expect(sh(dirty, `git show ${state!.branch}:shared.txt`).stdout).toBe("v2\n");
    expect(sh(dirty, `git show ${state!.branch}:component.txt`).stdout).toBe("new\n");
    const head = sh(dirty, "git rev-parse --short=12 HEAD").stdout.trim();
    expect(report).toContain(`BASE: ${state!.base} (snapshot of dirty tree over HEAD ${head})`);
    expect(sh(dirty, `git diff --name-only ${state!.base} ${state!.branch}`).stdout.trim()).toBe("out.txt");
    expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
  });

  test("incomplete spec is rejected before any worker starts", async () => {
    const p = join(root, "bad.txt");
    writeFileSync(p, "OBJECTIVE: something\n");
    const { report, state } = await laneRun({ to: "codex", specPath: p, repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("spec missing FILES");
  });

  test("a spec that names a protected path is refused before the worker starts", async () => {
    const p = join(root, "protected.txt");
    writeFileSync(p, `OBJECTIVE: edit the lead prompt
FILES: CLAUDE.md
INTERFACES: none
CONSTRAINTS: none
VERIFY: true
ACCEPT: no
`);
    const { report, state } = await laneRun({ to: "codex", specPath: p, repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("protected path: CLAUDE.md");
    const cli = runCli(["src/lane.ts", "run", "--to", "codex", "--spec", p, "--repo", repo]);
    expect(cli.status).not.toBe(0);
    expect(cli.stdout).toContain("STATUS: refused-by-lane");
    expect(cli.stdout).toContain("protected path: CLAUDE.md");
  });

  test("lane worktree has core.hooksPath pointed at an empty dir", async () => {
    fake("codex", "echo hi > out.txt");
    const { state, report } = await laneRun({
      to: "codex",
      specPath: spec("git config --get core.hooksPath | grep -q no-hooks"),
      repo,
      profile,
    });
    expect(report).toMatch(/^STATUS: complete$/m);
    expect(state?.verifyOk).toBe(true);
  });

  test("lane hooksPath does not rewrite the shared repo config", async () => {
    const user = join(root, "user-hooks");
    mkdirSync(user, { recursive: true });
    expect(sh(repo, `git config core.hooksPath ${user}`).status).toBe(0);
    fake("codex", "echo hi > out.txt");
    const { report } = await laneRun({
      to: "codex",
      specPath: spec("git config --get core.hooksPath | grep -q no-hooks"),
      repo,
      profile,
    });
    expect(report).toMatch(/^STATUS: complete$/m);
    expect(sh(repo, "git config --local --get core.hooksPath").stdout.trim()).toBe(user);
    expect(sh(repo, "git config --local --get core.hooksPath").stdout).not.toContain("no-hooks");
  });

  test("third lane reservation is refused at budget 2 and names the budget", async () => {
    const marker = join(root, "lane-launched");
    fake("codex", `touch ${marker}`);
    const limits = { ...profile.limits, max_concurrent_ceiling: 2, slot_wait_seconds: 0 };
    const budgetProfile = { ...profile, limits };
    const machine = { cores: 4, memAvailableGib: 23 };
    const sd = process.env.ORCH_STATE!;
    const held = [reserveSlot(sd, 2, "held-1"), reserveSlot(sd, 2, "held-2")];
    try {
      expect(held).toEqual([0, 1]);
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile: budgetProfile, machine });
      expect(report).toContain("REASON: lane budget 2 (limited by cpu) already running");
    } finally {
      for (const slot of held) if (slot !== null) releaseSlot(sd, slot);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a lane that finds the budget full waits for a slot, then runs", async () => {
    const marker = join(root, "lane-waited");
    fake("codex", `touch ${marker}`);
    const limits = { ...profile.limits, max_concurrent_ceiling: 2, slot_wait_seconds: 30 };
    const machine = { cores: 4, memAvailableGib: 23 };
    const sd = process.env.ORCH_STATE!;
    const held = [reserveSlot(sd, 2, "held-1"), reserveSlot(sd, 2, "held-2")];
    expect(held).toEqual([0, 1]);
    const freed = setTimeout(() => releaseSlot(sd, held[0]!), 1500);
    try {
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile: { ...profile, limits }, machine });
      expect(report).not.toContain("already running");
      expect(existsSync(marker)).toBe(true);
    } finally {
      clearTimeout(freed);
      releaseSlot(sd, held[1]!);
    }
  });

  test("VERIFY commands from overlapping lanes run one after another", async () => {
    const arrivals = join(root, `verify-arrivals-${Math.random().toString(36).slice(2)}`);
    const times = join(root, `verify-times-${Math.random().toString(36).slice(2)}`);
    fake("codex", `echo $$ >> ${JSON.stringify(arrivals)}; while [ "$(wc -l < ${JSON.stringify(arrivals)})" -lt 2 ]; do sleep 0.02; done; echo x > out.txt`);
    const verify = `printf 'start %s\\n' "$(date +%s%N)" >> ${JSON.stringify(times)}; sleep 0.35; printf 'end %s\\n' "$(date +%s%N)" >> ${JSON.stringify(times)}`;
    const serialProfile = { ...profile, limits: { ...profile.limits, verify_concurrent: 1 } };
    const machine = { cores: 4, memAvailableGib: 23 };
    const results = await Promise.all([
      laneRun({ to: "codex", specPath: spec(verify), repo, profile: serialProfile, machine }),
      laneRun({ to: "codex", specPath: spec(verify), repo, profile: serialProfile, machine }),
    ]);
    expect(results.every(result => result.state?.status === "complete")).toBe(true);
    const events = readFileSync(times, "utf8").trim().split("\n").map(line => {
      const [kind, stamp] = line.split(" ");
      return { kind, stamp: Number(stamp) };
    });
    expect(events.map(event => event.kind)).toEqual(["start", "end", "start", "end"]);
    expect(events[1].stamp).toBeLessThanOrEqual(events[2].stamp);
  });
});

describe("report and slots", () => {
  test("laneReport renders the fixed report fields", () => {
    expect(laneReport({
      to: "codex", model: "m", effort: "low", status: "complete",
      id: "id", base: "base", branch: "lane/id", setupLine: "SETUP: none", stat: "none", verifyOut: "exit 0",
      message: "done", usage: {}, changed: false, logPath: "/tmp/log",
    })).toBe("LANE REPORT\nLANE: codex · m · effort low\nSTATUS: complete\nID: id\nBASE: base (HEAD)\nBRANCH: lane/id\nSETUP: none\nCHANGES:\nnone\nVERIFY: exit 0\nWORKER SAID: done\nUSAGE: not reported\nPROVENANCE: source=lane id=id harness=codex trust=worker\nLOG: /tmp/log\n");
  });

  test("report is bounded in bytes", () => {
    const r = bound("x".repeat(10_000), 4096);
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(4096);
    expect(r).toContain("truncated");
  });

  test("slots are exclusive and capped", () => {
    const sd = join(root, "slots-test");
    const a = reserveSlot(sd, 2, "a");
    const b = reserveSlot(sd, 2, "b");
    expect([a, b].sort()).toEqual([0, 1]);
    expect(reserveSlot(sd, 2, "c")).toBeNull();
    releaseSlot(sd, a!);
    expect(reserveSlot(sd, 2, "d")).toBe(a);
  });

  test("VERIFY slots use an independent pool", () => {
    const sd = join(root, "verify-slots-test");
    const lane = reserveSlot(sd, 1, "lane");
    const verify = reserveSlot(sd, 1, "verify", "verify-slots");
    expect(lane).toBe(0);
    expect(verify).toBe(0);
    releaseSlot(sd, lane!);
    releaseSlot(sd, verify!, "verify-slots");
  });

  test("a slot held by a dead process is reclaimed", () => {
    const sd = join(root, "slots-stale");
    mkdirSync(join(sd, "slots", "0"), { recursive: true });
    writeFileSync(join(sd, "slots", "0", "pid"), "999999999 ghost");
    expect(reserveSlot(sd, 1, "e")).toBe(0);
  });
});

describe("gc", () => {
  test("keeps a clean lane with a dead runner while its recorded worker group is alive", async () => {
    const id = "gc-live-worker";
    const dir = join(process.env.ORCH_STATE!, "lanes", id);
    const wt = join(dir, "wt");
    const branch = `lane/${id}`;
    mkdirSync(dir, { recursive: true });
    expect(sh(repo, `git worktree add -q -b ${branch} ${wt}`).status).toBe(0);
    const worker = spawn("sleep", ["30"], { cwd: wt, detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const dead = spawnSync("true").pid;
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      id, to: "codex", repo, base: "HEAD", branch, worktree: wt, status: "running", changed: false,
      usage: {}, started: "", ended: "", pid: dead, workerPgid: worker.pid,
    }));
    try {
      expect(laneGc()).toContain(`kept ${id} (running)`);
      expect(laneGc(id)).toContain(`kept ${id} (running)`);
      expect(existsSync(wt)).toBe(true);
      worker.kill("SIGTERM");
      await exited;
      expect(laneGc()).toContain(`removed ${id}`);
      expect(existsSync(wt)).toBe(false);
    } finally {
      worker.kill("SIGKILL");
      await exited;
      laneGc(id);
    }
  });

  test("gc forgets a lane pointing at its repo, including a symlink alias, without touching the repo", () => {
    const branch = sh(repo, "git branch --show-current").stdout.trim();
    const id = "unsafe-caller-checkout";
    const dir = join(process.env.ORCH_STATE!, "lanes", id);
    const alias = join(root, "caller-repo-alias");
    symlinkSync(repo, alias);
    try {
      for (const worktree of [repo, alias]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "state.json"), JSON.stringify({
          id, to: "codex", repo, base: "HEAD", branch, worktree, status: "unavailable", changed: false,
          usage: {}, started: "", ended: "",
        }));
        expect(laneGc(id)).toContain(`forgot ${id} (worktree is the caller repo: lane record removed, repo and branch untouched)`);
        expect(existsSync(dir)).toBe(false);
        expect(existsSync(repo)).toBe(true);
        expect(sh(repo, "git branch --show-current").stdout.trim()).toBe(branch);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(alias, { force: true });
    }
  });

  test("keeps unintegrated work, removes it once merged", async () => {
    sh(repo, "rm -rf * && git checkout -q -- . 2>/dev/null; true");
    laneGc(); // clear earlier lanes that produced nothing worth keeping
    fake("codex", "echo keep > keep.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f keep.txt"), repo, profile });
    expect(laneGc().some((l) => l.startsWith(`kept ${state!.id}`))).toBe(true);
    sh(repo, `git -c user.email=t@t -c user.name=t merge -q --no-edit ${state!.branch}`);
    expect(laneGc()).toContain(`removed ${state!.id}`);
    expect(existsSync(state!.worktree)).toBe(false);
  });

  test("removes an applied lane with unrelated working tree changes and keeps an unapplied lane", async () => {
    const r = join(root, "gc-applied");
    mkdirSync(r);
    sh(r, "git init -q && echo base > tracked.txt && git add tracked.txt && git -c user.email=t@t -c user.name=t commit -q -m init");
    writeFileSync(join(r, "tracked.txt"), "dirty base\n");

    fake("codex", "echo integrated > applied.txt");
    const integrated = await laneRun({ to: "codex", specPath: spec("test -f applied.txt"), repo: r, profile });
    expect(integrated.state?.status).toBe("complete");
    const patchCommand = `git diff --binary --no-ext-diff --no-textconv ${integrated.state!.base} ${integrated.state!.branch} | git apply`;
    expect(integrated.report).toContain(`INTEGRATE: ${patchCommand} && lane gc --drop ${integrated.state!.id}`);

    fake("codex", "echo pending > pending.txt");
    const pending = await laneRun({ to: "codex", specPath: spec("test -f pending.txt"), repo: r, profile });
    expect(pending.state?.status).toBe("complete");

    expect(sh(r, patchCommand).status).toBe(0);
    writeFileSync(join(r, "unrelated.txt"), "extra change\n");
    const output = laneGc();

    expect(output).toContain(`removed ${integrated.state!.id} (applied)`);
    expect(output).toContain(`kept ${pending.state!.id} (complete, not integrated)`);
    expect(readFileSync(join(r, "applied.txt"), "utf8")).toBe("integrated\n");
    expect(readFileSync(join(r, "unrelated.txt"), "utf8")).toBe("extra change\n");
  });

  test("lists a lane directory without a record and removes its work only on --drop", () => {
    const r = join(root, "gc-orphan");
    mkdirSync(r);
    sh(r, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
    const lanes = join(process.env.ORCH_STATE!, "lanes");
    const dead = spawnSync("true").pid;
    const id = `20261020144735-codex-${dead}-orph`;
    const dir = join(lanes, id);
    mkdirSync(dir, { recursive: true });
    sh(r, `git worktree add -q -b lane/${id} ${join(dir, "wt")}`);
    writeFileSync(join(dir, "wt", "work.txt"), "worker result\n");
    const logsOnly = join(lanes, `20261020104932-codex-${dead}-logs`);
    mkdirSync(logsOnly);
    const starting = join(lanes, `20261022000000-codex-${process.pid}-live`);
    mkdirSync(starting);
    try {
      const orphan = listOrphans().find((o) => o.id === id);
      expect(orphan).toMatchObject({ worktree: true, repo: sh(r, "pwd -P").stdout.trim(), dirty: 1 });
      expect(listOrphans().some((o) => starting.endsWith(o.id))).toBe(false);

      const output = laneGc();
      expect(output.some((l) => l.startsWith(`kept orphan ${id} (no lane record`))).toBe(true);
      expect(output.some((l) => l.startsWith("removed orphan 20261020104932-codex-") && l.endsWith("(logs only)"))).toBe(true);
      expect(readFileSync(join(dir, "wt", "work.txt"), "utf8")).toBe("worker result\n");
      expect(existsSync(starting)).toBe(true);

      expect(laneGc(id)).toContain(`removed orphan ${id}`);
      expect(existsSync(dir)).toBe(false);
      expect(sh(r, `git branch --list lane/${id}`).stdout.trim()).toBe("");
      expect(sh(r, "git worktree list --porcelain").stdout).not.toContain(id);
    } finally {
      rmSync(starting, { recursive: true, force: true });
    }
  });
});

describe("profiles", () => {
  test("both shipped profiles pin Grok lanes to grok-4.7-build-fast at high effort (operator rule)", () => {
    for (const name of ["max20", "lean"]) {
      expect(loadProfile(name).lanes.grok).toMatchObject({ model: "grok-4.7-build-fast", effort: "high" });
    }
  });

  test("both shipped profiles run the Claude lead with permission_mode bypassPermissions", () => {
    for (const name of ["max20", "lean"]) expect(loadProfile(name).lead.claude.permission_mode).toBe("bypassPermissions");
  });

  test("max20 routes workers Claude-first; Codex stays the reviewer", () => {
    const max20 = loadProfile("max20");
    expect(max20.route?.order).toEqual(["claude", "codex", "grok"]);
    expect(max20.review.claude.to).toBe("codex");
    expect(loadProfile("lean").route?.order).toEqual(["codex", "claude", "grok"]);
  });
});

test("CLAUDE.md core stays under 4 KB (corpus T01)", () => {
  const f = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  if (existsSync(f)) expect(readFileSync(f).length).toBeLessThanOrEqual(4096);
});

describe("lane setup", () => {
  const withSetup = (setup: string) => {
    const p = join(root, `spec-setup-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, `${SPEC("test -f out.txt")}SETUP: ${setup}\n`);
    return p;
  };

  test("SETUP runs in the worktree before the worker, with LANE_REPO and LANE_WORKTREE", async () => {
    fake("codex", 'test -f "$PWD/../setup-ran" && echo hi > out.txt');
    const { report, state } = await laneRun({
      to: "codex", specPath: withSetup('test "$PWD" = "$LANE_WORKTREE" && test -d "$LANE_REPO/.git" && touch ../setup-ran'), repo, profile,
    });
    expect(state?.status).toBe("complete");
    expect(report).toMatch(/SETUP: .* \(spec SETUP, ok in \d+s\)/);
  });

  test("a failing SETUP stops the lane before any worker, and removes its branch", async () => {
    fake("codex", "echo hi > out.txt");
    const branches = () => sh(repo, "git branch --list 'lane/*'").stdout;
    const before = branches();
    const { report, state } = await laneRun({ to: "codex", specPath: withSetup("echo broken toolchain; exit 3"), repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("setup failed, exit 3");
    expect(report).toContain("broken toolchain");
    expect(branches()).toBe(before);
  });

  test("a SETUP that leaves files git sees is refused: they would land in the result", async () => {
    fake("codex", "echo hi > out.txt");
    const { report } = await laneRun({ to: "codex", specPath: withSetup("echo x > generated.txt"), repo, profile });
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("setup left files git tracks");
    expect(report).toContain("generated.txt");
  });

  test("PAUSE after SETUP aborts before the worker", async () => {
    const marker = join(root, "worker-should-not-run");
    fake("codex", `touch ${marker} && echo hi > out.txt`);
    const pause = join(process.env.ORCH_STATE!, "PAUSE");
    try {
      const { report, state: lane } = await laneRun({
        to: "codex",
        specPath: withSetup(`touch "${pause}"`),
        repo,
        profile,
      });
      expect(report).toContain("STATUS: paused");
      expect(report).toContain("PHASE: setup");
      expect(lane?.status).toBe("unavailable");
      expect(existsSync(marker)).toBe(false);
    } finally {
      try { unlinkSync(pause); } catch { /* leftover would pause the rest of the file */ }
    }
  });

  test("SETUP: none skips the auto setup", async () => {
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: withSetup("none"), repo, profile });
    rmSync(join(repo, "bun.lock"));
    expect(state?.status).toBe("complete");
    expect(report).toContain("SETUP: none");
  });
});

describe("lane depth", () => {
  test("a worker (ORCH_LANE=1) cannot start a lane: no worktree, no worker", async () => {
    fake("codex", "echo hi > out.txt");
    const before = sh(repo, "git branch --list 'lane/*'").stdout;
    process.env.ORCH_LANE = "1";
    try {
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state).toBeUndefined();
      expect(report).toContain("STATUS: refused-by-lane");
      expect(report).toContain("cannot start a lane");
    } finally {
      delete process.env.ORCH_LANE;
    }
    expect(sh(repo, "git branch --list 'lane/*'").stdout).toBe(before);
  });

  test("a worker (ORCH_LANE=1) cannot start a review or launch its harness", async () => {
    const marker = join(root, "review-depth-launched");
    fake("codex", `touch ${marker}`);
    process.env.ORCH_LANE = "1";
    try {
      const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile });
      expect(report).toContain("LANE REVIEW\nSTATUS: refused-by-lane");
      expect(report).toContain("REASON: max_depth");
    } finally {
      delete process.env.ORCH_LANE;
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a worker may call lane ask (read-only advisor) and is not depth-refused", async () => {
    process.env.ORCH_LANE = "1";
    try {
      const report = await laneAsk({ from: "claude", question: "What is the FILES gate?", repo, profile });
      expect(report).not.toContain("max_depth");
      expect(report).not.toContain("a lane worker cannot start a lane");
    } finally {
      delete process.env.ORCH_LANE;
    }
  });

  test("max_depth 0 refuses a lane from the lead", async () => {
    fake("codex", "echo hi > out.txt");
    const before = sh(repo, "git branch --list 'lane/*'").stdout;
    const zero = { ...profile, limits: { ...profile.limits, max_depth: 0 } };
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile: zero });
    expect(state).toBeUndefined();
    expect(report).toContain("STATUS: refused-by-lane");
    expect(report).toContain("max_depth 0: lanes are disabled");
    expect(sh(repo, "git branch --list 'lane/*'").stdout).toBe(before);
  });

  test("a tight daily cap does not refuse a lane before a worktree is created", async () => {
    const policy = join(root, "tight-policy.yaml");
    writeFileSync(policy, "spend:\n  daily_usd: 0.0001\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    const saved = process.env.ORCH_POLICY;
    process.env.ORCH_POLICY = policy;
    fake("codex", "echo hi > out.txt");
    const before = sh(repo, "git branch --list 'lane/*'").stdout;
    try {
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state?.status).toBe("complete");
      expect(report).toContain("STATUS: complete");
    } finally {
      if (saved === undefined) delete process.env.ORCH_POLICY;
      else process.env.ORCH_POLICY = saved;
    }
    expect(sh(repo, "git branch --list 'lane/*'").stdout).not.toBe(before);
  });

  test("ORCH_PAUSE refuses a lane before a worktree is created", async () => {
    fake("codex", "echo hi > out.txt");
    const before = sh(repo, "git branch --list 'lane/*'").stdout;
    process.env.ORCH_PAUSE = "1";
    try {
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state).toBeUndefined();
      expect(report).toContain("STATUS: paused");
      expect(report).toContain("ORCH_PAUSE");
    } finally {
      delete process.env.ORCH_PAUSE;
    }
    expect(sh(repo, "git branch --list 'lane/*'").stdout).toBe(before);
  });

  test("lane gc refuses to run inside a worker", () => {
    const result = runCli(["src/lane.ts", "gc"], { ...process.env, ORCH_LANE: "1", ORCH_STATE: join(root, "gc-state") });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe(`LANE GC\nSTATUS: refused-by-lane\nREASON: max_depth ${profile.limits.max_depth}: a lane worker cannot garbage collect lanes\n`);
  });

  test("a review is unavailable while all slots are held", async () => {
    const marker = join(root, "review-slot-launched");
    fake("codex", `touch ${marker}`);
    const held: number[] = [];
    const budget = laneBudget(profile.limits);
    try {
      for (let i = 0; i < budget.budget; i++) held.push(reserveSlot(process.env.ORCH_STATE!, budget.budget, `held-${i}`)!);
      const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile: { ...profile, limits: { ...profile.limits, slot_wait_seconds: 0 } } });
      expect(report).toBe(`LANE REVIEW\nSTATUS: unavailable\nREASON: lane budget ${budget.budget} (limited by ${budget.limitedBy}) already running\n`);
    } finally {
      for (const slot of held) releaseSlot(process.env.ORCH_STATE!, slot);
    }
    expect(existsSync(marker)).toBe(false);
  });
});

test("lane budget CLI prints its integer and breakdown on separate lines", () => {
  const result = spawnSync(process.execPath, ["src/lane.ts", "budget"], {
    cwd: join(import.meta.dir, ".."), encoding: "utf8", env: process.env,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(2);
  expect(result.stdout.trim().split("\n")[0]).toMatch(/^\d+$/);
  expect(result.stdout.trim().split("\n")[1]).toMatch(/^cpu -?\d+ ram -?\d+ ceiling \d+ quota (unlimited|-?\d+) verify \d+$/);
});

test("leadHarness uses the lead's harness and only honors --from outside lead sessions", () => {
  expect(leadHarness("codex", { ORCH_LEAD: "1", ORCH_HARNESS: "claude" })).toBe("claude");
  expect(leadHarness("codex", { ORCH_LEAD: "0", ORCH_HARNESS: "grok" })).toBe("codex");
  expect(leadHarness(undefined, { ORCH_LEAD: "0", ORCH_HARNESS: "grok" })).toBe("grok");
  expect(leadHarness("invalid", {})).toBe("claude");
});

test("lane review chooses a reviewer from ORCH_HARNESS and ignores --from in a lead session", () => {
  fake("claude", "echo review");
  const fromCodex = runCli(["src/lane.ts", "review", "--base", "HEAD", "--goal", "review"],
    { ...process.env, ORCH_LEAD: "0", ORCH_HARNESS: "codex" });
  expect(fromCodex.status).toBe(0);
  expect(fromCodex.stdout).toContain("REVIEWER: claude · opus");

  fake("codex", "echo review");
  const lockedToClaude = runCli(["src/lane.ts", "review", "--base", "HEAD", "--goal", "review", "--from", "codex"],
    { ...process.env, ORCH_LEAD: "1", ORCH_HARNESS: "claude" });
  expect(lockedToClaude.status).toBe(0);
  expect(lockedToClaude.stdout).toContain("REVIEWER: codex · gpt-6-luna");
});

test("review --to takes the model of an entry aimed at that harness, never another harness's id", async () => {
  const argvFile = join(root, "review-to-argv");
  fake("codex", `echo "$@" > ${argvFile}`);
  const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile });
  expect(report).toContain("REVIEWER: codex · gpt-6-luna");
  expect(readFileSync(argvFile, "utf8")).not.toContain("opus");
});

test("a Claude lead reviewing Claude keeps the lead model and effort in both profiles", async () => {
  const argvFile = join(root, "same-family-review-argv");
  fake("claude", `echo "$@" > ${argvFile}; echo '{"result":"reviewed"}'`);
  for (const [name, effort] of [["max20", "high"], ["lean", "medium"]] as const) {
    const selected = loadProfile(name);
    const report = await laneReview({ from: "claude", to: "claude", base: "HEAD", goal: "review", repo, profile: selected });
    expect(report).toContain(`REVIEWER: claude · opus · effort ${effort} · risk normal`);
    const argv = readFileSync(argvFile, "utf8");
    expect(argv).toContain("--model opus");
    expect(argv).toContain(`--effort ${effort}`);
    const resolved = resolveReviewer("claude", selected, { to: "claude", risk: "normal" }, () => true);
    expect("unavailable" in resolved ? resolved : resolved.choice).not.toHaveProperty("permission_mode");
  }
});

test("a codex reviewer with no review entry aimed at it keeps the review role's xhigh, not the worker's medium", () => {
  const max20 = loadProfile("max20");
  expect(max20.lanes.codex.effort).toBe("medium");
  const resolved = resolveReviewer("codex", max20, { to: "codex", risk: "normal" }, () => true);
  expect("unavailable" in resolved ? resolved : resolved.choice).toMatchObject({ model: "gpt-6-luna", effort: "xhigh" });
});

test("an explicit same-family reviewer is reported when another harness is installed", async () => {
  const isolatedBin = join(root, "review-explicit-same-family-bin");
  mkdirSync(isolatedBin);
  fakeAt(isolatedBin, "claude", `echo '{"result":"reviewed"}'`);
  fakeAt(isolatedBin, "codex", "true");
  const previousPath = process.env.PATH;
  process.env.PATH = `${isolatedBin}:/usr/bin:/bin`;
  try {
    const report = await laneReview({ from: "claude", to: "claude", base: "HEAD", goal: "review", repo, profile });
    expect(report).toContain("REVIEWER: claude · opus · effort high · risk normal (same family: explicit --to)");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("review risk picks the reviewer: normal is the base choice, high its override", async () => {
  const argvFile = join(root, "review-argv");
  fake("codex", `echo "$@" > ${argvFile}`);
  const normal = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile });
  expect(normal).toContain("REVIEWER: codex · gpt-6-luna · effort xhigh · risk normal");
  expect(readFileSync(argvFile, "utf8")).toContain("gpt-6-luna");
  const high = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile, risk: "high" });
  expect(high).toContain("REVIEWER: codex · gpt-6.1-sol · effort medium · risk high");
  expect(readFileSync(argvFile, "utf8")).toContain("gpt-6.1-sol");
});

test("review falls back to an installed harness and uses the lead family only when alone", async () => {
  const isolatedBin = join(root, "review-fallback-bin");
  mkdirSync(isolatedBin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${isolatedBin}:/usr/bin:/bin`;
  try {
    fakeAt(isolatedBin, "grok", `echo '{"result":"reviewed"}'`);
    const fallback = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile });
    expect(fallback).toContain("REVIEWER: grok · grok-4.7-build-fast");
    expect(fallback).toContain("(fallback: codex not installed)");

    rmSync(join(isolatedBin, "grok"));
    fakeAt(isolatedBin, "claude", `echo '{"result":"same-family review"}'`);
    const sameFamily = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile });
    expect(sameFamily).toContain("REVIEWER: claude · opus");
    expect(sameFamily).toContain("(same family: no other harness installed)");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a fallback reviewer with no review entry runs on its lane model", () => {
  const resolved = resolveReviewer("claude", profile, { risk: "high" }, (binName) => binName === "grok");
  expect(resolved).toEqual({
    to: "grok",
    choice: profile.lanes.grok,
    note: "fallback: codex not installed",
  });
});

test("lane run reports unavailable worker binaries with installed list", async () => {
  const isolatedBin = join(root, "missing-worker-bin");
  mkdirSync(isolatedBin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${isolatedBin}:/usr/bin:/bin`;
  try {
    fakeAt(isolatedBin, "claude", "true");
    const missing = await laneRun({ to: "grok", specPath: spec("true"), repo, profile });
    expect(missing.report).toContain("STATUS: unavailable");
    expect(missing.report).toContain("REASON: grok is not installed (installed: claude)");
    const cli = runCli(["src/lane.ts", "run", "--to", "grok", "--spec", spec("true"), "--repo", repo]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("STATUS: unavailable");
    expect(cli.stdout).toContain("REASON: grok is not installed (installed: claude)");
  } finally {
    process.env.PATH = previousPath;
  }
});

describe("snapshot and setup hardening (review findings)", () => {
  const fresh = (name: string) => {
    const r = join(root, name);
    mkdirSync(r);
    sh(r, "git init -q && echo base > a.txt && printf 'ignored/\\n' > .gitignore && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init");
    return r;
  };

  test("force-added ignored files and untracked files survive status.showUntrackedFiles=no; the caller index is byte-identical", async () => {
    const r = fresh("snap-index");
    mkdirSync(join(r, "ignored"));
    writeFileSync(join(r, "ignored", "fixture.txt"), "forced\n");
    sh(r, "git add -f ignored/fixture.txt && git config status.showUntrackedFiles no");
    writeFileSync(join(r, "new.txt"), "untracked\n");
    const indexBefore = readFileSync(join(r, ".git", "index"));
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(sh(r, `git show ${state!.branch}:ignored/fixture.txt`).stdout).toBe("forced\n");
    expect(sh(r, `git show ${state!.branch}:new.txt`).stdout).toBe("untracked\n");
    expect(readFileSync(join(r, ".git", "index")).equals(indexBefore)).toBe(true);
  });

  test("a dirty submodule is refused instead of silently dropped", async () => {
    const sub = fresh("snap-sub-src");
    const r = fresh("snap-super");
    sh(r, `git -c protocol.file.allow=always submodule add -q ${sub} dep && git -c user.email=t@t -c user.name=t commit -q -m sub`);
    writeFileSync(join(r, "dep", "a.txt"), "edited inside the submodule\n");
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("dirty submodule dep");
  });

  test("an edited assume-unchanged file reaches the snapshot; the caller's bit stays set", async () => {
    const r = fresh("snap-assume");
    sh(r, "git update-index --assume-unchanged a.txt");
    writeFileSync(join(r, "a.txt"), "edited under assume-unchanged\n");
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(sh(r, `git show ${state!.branch}:a.txt`).stdout).toBe("edited under assume-unchanged\n");
    expect(sh(r, "git ls-files -v a.txt").stdout.trim()).toBe("h a.txt");
  });

  test("an edit to a file both assume-unchanged and skip-worktree reaches the snapshot", async () => {
    const r = fresh("snap-both-flags");
    sh(r, "git update-index --assume-unchanged a.txt && git update-index --skip-worktree a.txt");
    expect(sh(r, "git ls-files -v a.txt").stdout.trim()).toBe("s a.txt");
    writeFileSync(join(r, "a.txt"), "edited under both flags\n");
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(sh(r, `git show ${state!.branch}:a.txt`).stdout).toBe("edited under both flags\n");
  });

  test("hidden edits count toward the snapshot budget next to visible ones", async () => {
    const r = fresh("snap-budget-hidden");
    sh(r, "git update-index --assume-unchanged a.txt");
    writeFileSync(join(r, "a.txt"), "hidden edit\n");
    writeFileSync(join(r, "new.txt"), "visible\n");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      expect((await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile })).report).toContain("(2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("gc keeps a worktree with untracked work even under status.showUntrackedFiles=no", async () => {
    const r = fresh("gc-untracked");
    fake("codex", "true");
    const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(state?.status).toBe("noop");
    // The run cut its clean worktree; restore one that holds unsaved work.
    expect(sh(r, `git worktree add -q ${state!.worktree} ${state!.branch}`).status).toBe(0);
    sh(r, "git config status.showUntrackedFiles no");
    writeFileSync(join(state!.worktree, "work.txt"), "unsaved work\n");
    expect(laneGc()).toContain(`kept ${state!.id} (dirty worktree)`);
    expect(existsSync(join(state!.worktree, "work.txt"))).toBe(true);
  });

  test("a rejecting pre-commit hook is ignored: the lane worktree has hooksPath neutralized", async () => {
    const r = fresh("commit-hook");
    const hook = join(r, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho pre-commit rejected >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(report).toMatch(/^STATUS: complete$/m);
    expect(report).not.toContain("pre-commit rejected");
    expect(existsSync(state!.worktree)).toBe(false);
  });

  test("a dirty submodule with a non-ASCII name is refused too", async () => {
    const sub = fresh("snap-sub2-src");
    const r = fresh("snap-super2");
    sh(r, `git -c protocol.file.allow=always submodule add -q ${sub} dép && git -c user.email=t@t -c user.name=t commit -q -m sub`);
    writeFileSync(join(r, "dép", "a.txt"), "edited\n");
    const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(report).toContain("dirty submodule dép");
  });

  test("tracked edits count toward the snapshot budget", async () => {
    const r = fresh("snap-budget-tracked");
    writeFileSync(join(r, "a.txt"), "edited tracked file\n");
    writeFileSync(join(r, "new.txt"), "untracked\n");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      expect((await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile })).report).toContain("(2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("status paths skip the origin entry of a rename", () => {
    expect(statusPaths(["R  new.txt", "old.txt", " M a.txt", "?? b c.txt"])).toEqual(["new.txt", "a.txt", "b c.txt"]);
  });

  test("the snapshot budget refuses an oversized untracked tree", async () => {
    const r = fresh("snap-budget");
    writeFileSync(join(r, "x1.bin"), "1");
    writeFileSync(join(r, "x2.bin"), "2");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
      expect(report).toContain("changes too large to snapshot (2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("a SETUP that commits is refused, and a failed setup is left for lane gc", async () => {
    const r = fresh("setup-commit");
    const p = join(root, "spec-setup-commit.txt");
    writeFileSync(p, `${SPEC("true")}SETUP: echo x > gen.txt && git add gen.txt && git -c user.email=t@t -c user.name=t commit -q -m gen\n`);
    fake("codex", "echo hi > out.txt");
    const { report } = await laneRun({ to: "codex", specPath: p, repo: r, profile });
    expect(report).toContain("setup made a commit in the worktree");
    const id = /lanes\/([^/]+)\/setup\.log/.exec(report)![1];
    expect(laneGc().join("\n")).toContain(`removed ${id}`);
  });

  test("the project setup script runs as argv, never through a shell string", () => {
    const r = join(root, "repo $(touch pwned) `id`");
    const script = join(process.env.HOME!, ".orch", "repo $(touch pwned) `id`", "lane-setup");
    mkdirSync(r);
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "true\n");
    const cmd = setupCommand({ raw: "", fields: {} }, r);
    expect(cmd?.argv).toEqual(["sh", script]);
  });

  test("the snapshot integration patch carries binary changes", async () => {
    const r = fresh("snap-binary");
    writeFileSync(join(r, "dirty.txt"), "dirty\n");
    fake("codex", "printf '\\000\\001\\002' > blob.bin");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f blob.bin"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain("git diff --binary --no-ext-diff --no-textconv");
    const target = fresh("snap-binary-target");
    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    const applied = sh(target, `git -C ${r} diff --binary --no-ext-diff --no-textconv ${state!.base} ${state!.branch} | git apply`);
    expect(applied.status).toBe(0);
    expect(readFileSync(join(target, "blob.bin")).equals(Buffer.from([0, 1, 2]))).toBe(true);
  });
});

describe("grok profile guard", () => {
  test("a Grok lane fails closed without orch's exact orch-lane profile in the user file", async () => {
    const savedHome = process.env.HOME;
    const home = join(root, "grok-home");
    mkdirSync(join(home, ".grok"), { recursive: true });
    fake("grok", "echo hi > out.txt");
    process.env.HOME = home;
    try {
      // missing, then defined by someone else under the same name
      for (const content of [null, '[profiles.orch-lane]\nextends = "devbox"\n']) {
        if (content !== null) writeFileSync(join(home, ".grok", "sandbox.toml"), content);
        const { report, state } = await laneRun({ to: "grok", specPath: spec("test -f out.txt"), repo, profile });
        expect(state).toBeUndefined();
        expect(report).toContain("missing or modified");
      }
      writeFileSync(join(home, ".grok", "sandbox.toml"), readFileSync(join(import.meta.dir, "..", "catalog", "grok-sandbox.toml"), "utf8"));
      const ok = await laneRun({ to: "grok", specPath: spec("test -f out.txt"), repo, profile });
      expect(ok.state?.status).toBe("complete");
      // the worker ran from a read-only pinned copy under the lane state dir, not from PATH
      const real = statSync(join(root, "bin", "grok"));
      const pinned = join(process.env.ORCH_STATE!, "bin", `grok-${real.size}-${Math.trunc(real.mtimeMs)}`);
      expect(existsSync(pinned)).toBe(true);
      expect(statSync(pinned).mode & 0o777).toBe(0o555);
      // an older pinned version is pruned by lane gc, the current one kept
      writeFileSync(join(process.env.ORCH_STATE!, "bin", "grok-old-1-1"), "old");
      expect(laneGc().join("\n")).toContain("removed pinned grok-old-1-1");
      expect(existsSync(pinned)).toBe(true);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});

test("ask sends the question with stdin closed to the risk-chosen reviewer and reports its answer", async () => {
  const argvFile = join(root, "ask-argv");
  const stdinFile = join(root, "ask-stdin");
  // fake() drains stdin first, so write this codex by hand: it must receive the prompt file
  // on stdin and see it end (an open, never-closed stdin is what hangs a real codex exec)
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$@" > ${argvFile}\ncat > ${stdinFile}\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo "chef mode: no" > "$a"; prev="$a"; done\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const report = await laneAsk({ from: "claude", question: "Should the lead lose Bash?", repo, profile, risk: "high" });
  expect(report).toStartWith("ASK REPORT\nREVIEWER: codex · gpt-6.1-sol");
  expect(report).toContain("chef mode: no");
  expect(readFileSync(stdinFile, "utf8")).toContain("Should the lead lose Bash?");
  expect(readFileSync(argvFile, "utf8")).toContain("read-only");
});

test("lane ask --model wins over explore haiku; REVIEWER names the CLI model", async () => {
  const argvFile = join(root, "ask-model-argv");
  fake("claude", `echo "$@" > ${argvFile}; echo '{"result":"ok","model":"claude-haiku-4-5","total_cost_usd":0.002}'`);
  const report = await laneAsk({ from: "claude", to: "claude", question: "What is FILES?", repo, profile, model: "opus" });
  const argv = readFileSync(argvFile, "utf8");
  expect(argv).toContain("--model opus");
  expect(argv).toContain("--allowedTools");
  expect(argv).not.toContain("--permission-mode");
  expect(report).toContain("REVIEWER: claude · claude-haiku-4-5");
});

test("lane ask without --model stays on haiku and does not use plan mode", async () => {
  const argvFile = join(root, "ask-haiku-argv");
  fake("claude", `echo "$@" > ${argvFile}; echo '{"result":"ok","model":"claude-haiku-4-5"}'`);
  await laneAsk({ from: "claude", to: "claude", question: "What is FILES?", repo, profile });
  const argv = readFileSync(argvFile, "utf8");
  expect(argv).toContain("haiku");
  expect(argv).not.toContain("--permission-mode plan");
  expect(argv).toContain("--disallowedTools");
});

describe("contest", () => {
  const judgeArgv = () => join(root, "judge-argv");
  const judgePrompt = () => join(root, "judge-prompt");
  // codex writes its answer to -o, grok prints JSON, claude answers or judges
  // depending on its prompt; none of the answers names its author
  function contestants(opts: { grokExit?: number; claudeExit?: number; judgeExit?: number } = {}) {
    rmSync(judgeArgv(), { force: true });
    rmSync(judgePrompt(), { force: true });
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ncat >/dev/null\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo "ANSWER: yes, keep the cache" > "$a"; prev="$a"; done\n`);
    chmodSync(join(bin, "codex"), 0o755);
    fake("grok", `echo '{"text":"ANSWER: no, drop the cache"}'; exit ${opts.grokExit ?? 0}`);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
p=$(cat)
case "$p" in
  *"You arbitrate"*) echo "$@" > ${judgeArgv()}; printf '%s' "$p" > ${judgePrompt()}
    printf '%s\\n' '{"result":"CONSENSUS: none\\nCONTRADICTIONS: 1. keep or drop -> UNRESOLVED: cost against freshness\\nDECISION: keep it for a week.\\nFOR THE OPERATOR: the cache budget"}'; exit ${opts.judgeExit ?? 0};;
  *) echo '{"result":"ANSWER: it depends on the hit rate"}'; exit ${opts.claudeExit ?? 0};;
esac
`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  const question = "Should we keep the response cache?\nContext: it saves 30% of calls.";

  test("three answers, anonymized for a judge on another model, who names the contradiction", async () => {
    contestants();
    // as the CLI passes them: an unset --model or --effort keeps the profile's judge
    const { report, decided } = await laneContest({ repo, profile, question, random: () => 0, judge: { model: undefined, effort: undefined } });
    expect(decided).toBe(true);
    expect(report).toStartWith("CONTEST REPORT\nQUESTION: Should we keep the response cache?\nCONTESTANTS:\n");
    for (const who of ["codex · gpt-6-luna", "grok · grok-4.7-build-fast", "claude · opus"]) expect(report).toMatch(new RegExp(`[ABC] = ${who}`));
    expect(report).toContain("JUDGE: claude · fable · effort high (ok)\nSTATUS: judged\nCONSENSUS: none");
    expect(report).toContain("-> UNRESOLVED: cost against freshness");
    // the judge sees the three answers under letters, never who wrote them
    const prompt = readFileSync(judgePrompt(), "utf8");
    for (const a of ["ANSWER A:", "ANSWER B:", "ANSWER C:", "yes, keep the cache", "no, drop the cache", "it depends"]) expect(prompt).toContain(a);
    for (const name of ["codex", "grok", "gpt-6", "opus", "fable"]) expect(prompt.toLowerCase()).not.toContain(name);
    const judge = readFileSync(judgeArgv(), "utf8");
    expect(judge).toContain("--model fable");
    expect(judge).toContain("--effort high");
    expect(judge).toContain("--allowedTools");
    expect(judge).not.toContain("--permission-mode plan");
    // letters, answers and the verdict are kept beside the question
    const dir = /^ANSWERS: (.*)$/m.exec(report)![1];
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8")))).toEqual(["A", "B", "C"]);
    expect(readFileSync(join(dir, "judge.md"), "utf8")).toContain("DECISION: keep it for a week.");
  });

  test("the contest report sums contestant and judge costs in one usage line", async () => {
    contestants();
    fake("grok", `echo '{"text":"ANSWER: drop the cache","total_cost_usd":0.25}'`);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
p=$(cat)
case "$p" in
  *"You arbitrate"*) echo '{"result":"DECISION: GO","total_cost_usd":0.5}';;
  *) echo '{"result":"ANSWER: keep the cache","total_cost_usd":0.125}';;
esac`);
    const { report, decided } = await laneContest({ repo, profile, question });
    expect(decided).toBe(true);
    expect(report.match(/^USAGE:.*$/gm)).toEqual(["USAGE: costUsd 0.875"]);
  });

  test("a contestant that fails is named; the other two are still judged", async () => {
    contestants({ grokExit: 1 });
    const { report, decided } = await laneContest({ repo, profile, question });
    expect(decided).toBe(true);
    expect(report).toContain("no answer: grok (exit 1)");
    expect(report).toContain("STATUS: judged");
    expect(readFileSync(judgePrompt(), "utf8")).not.toContain("ANSWER C:");
  });

  test("a harness that cannot start (exit 127) is named with the likely cause", async () => {
    contestants();
    writeFileSync(join(bin, "codex"), "#!/bin/sh\ncat >/dev/null\nexit 127\n");
    chmodSync(join(bin, "codex"), 0o755);
    const { report } = await laneContest({ repo, profile, question });
    expect(report).toContain("no answer: codex (exit 127: the harness or its interpreter (node for codex) is not on PATH)");
  });

  test("one answer is no contest: no judge is called", async () => {
    contestants({ grokExit: 1, claudeExit: 1 });
    const { report, decided } = await laneContest({ repo, profile, question });
    expect(decided).toBe(false);
    expect(report).toContain("STATUS: unavailable\nREASON: 1 answer(s), a contest needs two: no judge called");
    expect(existsSync(judgeArgv())).toBe(false);
  });

  test("a failing judge leaves the answers on disk and says so", async () => {
    contestants({ judgeExit: 1 });
    const { report, decided } = await laneContest({ repo, profile, question });
    expect(decided).toBe(false);
    expect(report).toContain("STATUS: judge-failed");
    const dir = /^ANSWERS: (.*)$/m.exec(report)![1];
    expect(readdirSync(dir).filter((f) => /^[ABC]\.md$/.test(f)).length).toBe(3);
  });

  test("fewer than two installed harnesses, or a lane worker, cannot start a contest", async () => {
    contestants();
    expect((await laneContest({ repo, profile, question, to: ["codex"] })).report).toContain("a contest needs two installed harnesses");
    process.env.ORCH_LANE = "1";
    try {
      expect((await laneContest({ repo, profile, question })).report).toContain("STATUS: refused-by-lane");
    } finally {
      delete process.env.ORCH_LANE;
    }
  });
});

test("a lane worker writes its own TMPDIR, removed when the lane ends", async () => {
  fake("codex", 'echo hi > out.txt; printf %s "$TMPDIR" > tmpdir.txt; touch "$TMPDIR/probe"');
  const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
  expect(state?.status).toBe("complete");
  const seen = sh(repo, `git show ${state!.branch}:tmpdir.txt`).stdout;
  expect(seen).toBe(state!.tmpDir!);
  expect(seen).toMatch(/\/orch-lane-[^/]+$/);
  expect(existsSync(seen)).toBe(false);
});

test("SETUP: none is recorded, so a fresh checkout later runs no setup either", async () => {
  fake("codex", "echo hi > out.txt");
  const p = join(root, "spec-setup-none.txt");
  writeFileSync(p, SPEC("test -f out.txt").replace("VERIFY:", "SETUP: none\nVERIFY:"));
  const { state } = await laneRun({ to: "codex", specPath: p, repo, profile });
  expect(state?.status).toBe("complete");
  expect(state?.setupArgv).toEqual([]);
});

test("the reaper removes a temp dir a killed follow left behind", async () => {
  const { reapDeadLanes } = await import("../src/lane.ts");
  const state = join(root, "follow-tmp-state");
  const dir = join(state, "lanes", "follow-killed");
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "orch-lane-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    id: "follow-killed", to: "claude", repo, base: "HEAD", branch: "lane/follow-killed", worktree: join(dir, "wt"),
    status: "complete", changed: false, usage: {}, started: "t", ended: "t", pid: spawnSync("true").pid, cleaned: true, tmpDir: tmp,
  }));
  reapDeadLanes(state);
  expect(existsSync(tmp)).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).tmpDir).toBeUndefined();
});

test("gc removes a record whose branch and worktree are both gone", () => {
  const id = "gc-branchless";
  const dir = join(process.env.ORCH_STATE!, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    id, to: "claude", repo, base: "HEAD", branch: `lane/${id}`, worktree: join(dir, "wt"),
    status: "failed", changed: true, usage: {}, started: "t", ended: "t", pid: spawnSync("true").pid, cleaned: true,
  }));
  expect(laneGc()).toContain(`removed ${id} (branch and worktree already gone)`);
  expect(existsSync(dir)).toBe(false);
});

describe("lane end of life", () => {
  const withOrca = async (name: string, fn: (calls: string) => Promise<void>) => {
    const saved = { id: process.env.ORCA_WORKTREE_ID, calls: process.env.ORCA_CALLS, repo: process.env.TEST_REPO_PATH };
    const calls = join(root, `orca-calls-${name}`);
    try {
      fakeOrca(calls);
      await fn(calls);
    } finally {
      for (const [k, v] of [["ORCA_WORKTREE_ID", saved.id], ["ORCA_CALLS", saved.calls], ["TEST_REPO_PATH", saved.repo]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const waitFor = async (what: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(50);
    }
  };

  test("SIGTERM saves the worker's uncommitted file on the branch, cuts the worktree and closes the Orca terminal", async () => {
    await withOrca("sigterm", async (calls) => {
      fake("codex", "echo hi > out.txt; sleep 30");
      const state = join(root, "sigterm-state");
      const child = spawn(process.execPath, ["src/lane.ts", "run", "--to", "codex", "--spec", spec("true"), "--repo", repo], {
        cwd: join(import.meta.dir, ".."), stdio: "ignore",
        env: { ...process.env, ORCH_STATE: state, ORCA_WORKTREE_ID: "lead-repo::/elsewhere/lead", ORCH_ORCA_POLL_MS: "20" },
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      const lanes = join(state, "lanes");
      const rec = () => {
        const id = existsSync(lanes) ? readdirSync(lanes)[0] : undefined;
        if (!id || !existsSync(join(lanes, id, "state.json"))) return null;
        return JSON.parse(readFileSync(join(lanes, id, "state.json"), "utf8"));
      };
      await waitFor(() => Boolean(rec()?.orca?.terminal) && existsSync(join(rec().worktree, "out.txt")));
      child.kill("SIGTERM");
      expect(await exited).toBe(143);
      const s = rec();
      expect(s.status).toBe("failed");
      expect(s.reason).toContain("lane stopped by SIGTERM; 1 uncommitted file(s) saved on");
      expect(existsSync(s.worktree)).toBe(false);
      expect(sh(repo, `git show ${s.branch}:out.txt`).stdout).toBe("hi\n");
      expect(s.orca.retired).toBe(true);
      expect(readFileSync(calls, "utf8")).toContain("terminal close --terminal term_x");
    });
  }, 30_000);

  test("the reaper finalizes a lane killed without a record: work saved, worktree cut, Orca terminal closed", async () => {
    await withOrca("reap", async (calls) => {
      const { reapDeadLanes } = await import("../src/lane.ts");
      const state = join(root, "reap-state");
      const id = "reap-killed";
      const tmpDir = mkdtempSync(join(tmpdir(), "orch-lane-"));
      const dir = join(state, "lanes", id);
      const wt = join(dir, "wt");
      mkdirSync(dir, { recursive: true });
      const base = sh(repo, "git rev-parse HEAD").stdout.trim();
      expect(sh(repo, `git worktree add -q -b lane/${id} ${wt} ${base}`).status).toBe(0);
      writeFileSync(join(wt, "out.txt"), "half\n");
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        id, to: "codex", repo, base, branch: `lane/${id}`, worktree: wt, status: "running", changed: true, usage: {}, started: "t", ended: "",
        pid: spawnSync("true").pid, declared: ["out.txt"], orca: { repo, worktreeId: "repo-id::x", terminal: "term_x" }, tmpDir,
      }));
      expect(reapDeadLanes(state).map((s) => s.id)).toEqual([id]);
      expect(existsSync(tmpDir)).toBe(false);
      const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      expect(s.status).toBe("failed");
      expect(s.reason).toContain("lane process died; saved 1 uncommitted file(s)");
      expect(existsSync(wt)).toBe(false);
      expect(sh(repo, `git show lane/${id}:out.txt`).stdout).toBe("half\n");
      expect(s.orca.retired).toBe(true);
      expect(readFileSync(calls, "utf8")).toContain("terminal close --terminal term_x");
    });
  });

  const deadLane = (name: string, extra: Record<string, unknown> = {}) => {
    const dir = join(process.env.ORCH_STATE!, "lanes", name);
    const wt = join(dir, "wt");
    mkdirSync(dir, { recursive: true });
    const base = sh(repo, "git rev-parse HEAD").stdout.trim();
    expect(sh(repo, `git worktree add -q -b lane/${name} ${wt} ${base}`).status).toBe(0);
    writeFileSync(join(wt, "out.txt"), "left\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      id: name, to: "claude", repo, base, branch: `lane/${name}`, worktree: wt, status: "failed", changed: true, usage: {}, started: "t", ended: "t",
      pid: spawnSync("true").pid, declared: ["out.txt"], ...extra,
    }));
    return { dir, wt };
  };

  test("a cleanup cut short after the terminal record is resumed by the reaper", async () => {
    const { reapDeadLanes } = await import("../src/lane.ts");
    const { dir, wt } = deadLane("resume-cleanup");
    reapDeadLanes(process.env.ORCH_STATE!);
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, "git show lane/resume-cleanup:out.txt").stdout).toBe("left\n");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cleaned).toBe(true);
  });

  test("gc and the reaper never touch a checkout a follow owns", async () => {
    const { reapDeadLanes } = await import("../src/lane.ts");
    const { dir, wt } = deadLane("owned-by-follow");
    const holder = spawn("flock", [join(dir, "owner.lock"), "sleep", "20"], { stdio: "ignore" });
    const gone = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    try {
      await waitFor(() => spawnSync("flock", ["-n", join(dir, "owner.lock"), "true"]).status !== 0);
      reapDeadLanes(process.env.ORCH_STATE!);
      expect(laneGc()).toContain("kept owned-by-follow (busy)");
      expect(readFileSync(join(wt, "out.txt"), "utf8")).toBe("left\n");
    } finally {
      holder.kill("SIGKILL");
      await gone;
    }
  });

  test("gc keeps the record while its Orca observer terminal cannot be closed", async () => {
    await withOrca("gc-unclosed", async () => {
      fake("orca", `case "$1 $2" in "terminal close") printf '{"ok":false,"error":{"code":"runtime_unavailable"}}\\n' ;; *) printf '{"ok":true,"result":{}}\\n' ;; esac`);
      const { dir, wt } = deadLane("gc-unclosed", { cleaned: true, orca: { repo, worktreeId: "w", terminal: "term_y" } });
      expect(sh(repo, `git worktree remove --force ${wt}`).status).toBe(0);
      expect(laneGc()).toContain("kept gc-unclosed (Orca observer terminal not closed yet)");
      expect(existsSync(join(dir, "state.json"))).toBe(true);
    });
  });

  test("gc saves a dead lane's dirty worktree on its branch and cuts the checkout", () => {
    const id = "gc-dirty-failed";
    const dir = join(process.env.ORCH_STATE!, "lanes", id);
    const wt = join(dir, "wt");
    mkdirSync(dir, { recursive: true });
    const base = sh(repo, "git rev-parse HEAD").stdout.trim();
    expect(sh(repo, `git worktree add -q -b lane/${id} ${wt} ${base}`).status).toBe(0);
    writeFileSync(join(wt, "out.txt"), "left\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      id, to: "claude", repo, base, branch: `lane/${id}`, worktree: wt, status: "failed", changed: true, usage: {}, started: "t", ended: "t",
      pid: spawnSync("true").pid, declared: ["out.txt"],
    }));
    const out = laneGc();
    expect(out).toContain(`saved 1 uncommitted file(s) of ${id} on lane/${id}`);
    expect(out).toContain(`kept ${id} (failed, not integrated)`);
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, `git show lane/${id}:out.txt`).stdout).toBe("left\n");
  });
});
