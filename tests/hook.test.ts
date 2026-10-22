import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hooks/hook.ts";

let root: string;
let state: string;
let fakeHome: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-hook-test-"));
  state = join(root, "state");
  fakeHome = join(root, "home");
  mkdirSync(state, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function env(session: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ORCH_LEAD: "1", ORCH_SESSION: session, ORCH_STATE: state, HOME: fakeHome, ...extra };
}

function bash(command: string, name = "Bash") {
  return { tool_name: name, tool_input: { command } };
}

function toolEdit(name: string, file: string, input: Record<string, unknown>) {
  return { tool_name: name, tool_input: { file_path: file, ...input } };
}

function laneRepo(): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=hook-test", "-c", "user.email=hook@test.invalid", "commit", "--allow-empty", "-qm", "base"]);
  return repo;
}

function addLane(repo: string, id: string, session: string) {
  const branch = `lane/${id}`;
  execFileSync("git", ["-C", repo, "branch", branch, "main"]);
  execFileSync("git", ["-C", repo, "switch", "-q", branch]);
  writeFileSync(join(repo, `${id}.txt`), id);
  execFileSync("git", ["-C", repo, "add", `${id}.txt`]);
  execFileSync("git", ["-C", repo, "-c", "user.name=hook-test", "-c", "user.email=hook@test.invalid", "commit", "-qm", id]);
  execFileSync("git", ["-C", repo, "switch", "-q", "main"]);
  const dir = join(state, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    id, to: "claude", repo, base: "", branch, worktree: "", status: "complete", changed: true,
    usage: {}, started: "", ended: "", session,
  }));
}

describe("lead lifecycle hooks", () => {
  test("non-lead sessions get no output", async () => {
    expect(await runHook("pre-bash", "codex", bash('codex exec "q"'), { ORCH_SESSION: "plain" })).toBe("");
  });

  test("pre-bash closes stdin and nudges once per session", async () => {
    const first = JSON.parse(await runHook("pre-bash", "codex", bash('codex exec "q" &'), env("pre-once")));
    expect(first.hookSpecificOutput.updatedInput.command).toBe('{\ncodex exec "q" &\n} < /dev/null');
    expect(first.hookSpecificOutput.additionalContext).toContain("lane ask");
    expect(first.hookSpecificOutput.permissionDecision).toBe("allow"); // Codex applies updatedInput only with allow

    const second = JSON.parse(await runHook("pre-bash", "codex", bash('codex exec "q" &'), env("pre-once")));
    expect(second.hookSpecificOutput.updatedInput.command).toBe('{\ncodex exec "q" &\n} < /dev/null');
    expect(second.hookSpecificOutput).not.toHaveProperty("additionalContext");
  });

  test("pre-bash catches another harness's binary: a Claude lead running codex exec in the background", async () => {
    const out = JSON.parse(await runHook("pre-bash", "claude", bash('codex exec -m gpt-6.1-sol "q" > out.txt &'), env("cross")));
    expect(out.hookSpecificOutput.updatedInput.command).toEndWith("} < /dev/null");
    expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    const global = JSON.parse(await runHook("pre-bash", "codex", bash("codex -m x exec q"), env("cross-global")));
    expect(global.hookSpecificOutput.updatedInput.command).toEndWith("} < /dev/null");
  });

  test("pre-bash leaves inspections and provided stdin untouched", async () => {
    for (const command of [
      "codex --version",
      "codex features list",
      "codex mcp list",
      "codex login status",
      "codex exec - < f.md",
      "printf q | codex exec -",
      "codex exec - <<EOF\nq\nEOF",
    ]) {
      expect(await runHook("pre-bash", "codex", bash(command), env("pre-silent-" + command.length))).toBe("");
    }
  });

  test("post-edit nudges at the threshold once and resets on prompt-submit", async () => {
    const session = "edit-threshold";
    expect(await runHook("post-edit", "claude", toolEdit("Write", "a.ts", { content: "a\n" }), env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "b.ts", { content: "b\n" }), env(session))).toBe("");
    const crossed = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "c.ts", { content: "c\n" }), env(session)));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("3 files, 3 lines");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "d.ts", { content: "d\n" }), env(session))).toBe("");
    expect(await runHook("prompt-submit", "claude", {}, env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "e.ts", { content: "e\n" }), env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "f.ts", { content: "f\n" }), env(session))).toBe("");
    const afterReset = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "g.ts", { content: "g\n" }), env(session)));
    expect(afterReset.hookSpecificOutput.additionalContext).toContain("3 files, 3 lines");
  });

  test("post-edit counts Codex patch files and changed lines", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+created\n*** End Patch";
    expect(await runHook("post-edit", "codex", { tool_name: "apply_patch", tool_input: { patch } }, env("codex-patch"))).toBe("");
    const patch2 = "*** Begin Patch\n*** Add File: c.ts\n+one\n+two\n*** End Patch";
    const crossed = JSON.parse(await runHook("post-edit", "codex", { tool_name: "apply_patch", tool_input: { patch: patch2 } }, env("codex-patch")));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("3 files, 5 lines");
  });

  test("post-edit also nudges after more than 60 lines in one file", async () => {
    const content = Array.from({ length: 61 }, () => "line").join("\n");
    const crossed = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "large.ts", { content }), env("edit-lines")));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("1 files, 61 lines");
  });

  test("stop blocks once for this session's unintegrated lanes", async () => {
    const repo = laneRepo();
    addLane(repo, "mine", "stop-session");
    addLane(repo, "theirs", "other-session");
    const input = { session_id: "stop-session", stop_hook_active: false };
    const first = JSON.parse(await runHook("stop", "claude", input, env("stop-session")));
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("Lane mine is complete");
    expect(first.reason).not.toContain("theirs");
    expect(await runHook("stop", "claude", input, env("stop-session"))).toBe("");
    expect(await runHook("stop", "claude", { ...input, stop_hook_active: true }, env("stop-active"))).toBe("");
  });

  test("stop blocks once per lane: a new lane blocks for itself, an already reported one never again", async () => {
    const repo = laneRepo();
    addLane(repo, "a", "per-lane");
    addLane(repo, "b", "per-lane");
    const input = { session_id: "per-lane" };
    const blocked = JSON.parse(await runHook("stop", "claude", input, env("per-lane")));
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("lane integrate b");
    rmSync(join(state, "lanes", "a"), { recursive: true, force: true }); // a integrated, b still pending
    expect(await runHook("stop", "claude", input, env("per-lane"))).toBe("");
    addLane(repo, "c", "per-lane");
    expect(JSON.parse(await runHook("stop", "claude", input, env("per-lane"))).reason).toContain("Lane c");
  });

  test("Grok camelCase input receives the PreToolUse reply shape", async () => {
    const output = JSON.parse(await runHook("pre-bash", "grok", {
      sessionId: "grok-shape",
      toolName: "run_terminal_command",
      toolInput: { command: "grok -p 'q'" },
    }, env("grok-shape")));
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      updatedInput: { command: "{\ngrok -p 'q'\n} < /dev/null" },
    });
    expect(output.hookSpecificOutput.additionalContext).toContain("lane ask");
  });
});
