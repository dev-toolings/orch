import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SANDBOX, workerArgv } from "../src/harness/harness.ts";
import { guardDecision, outsideWrites, writable } from "../src/lanes/guard.ts";

const root = mkdtempSync("/tmp/orch-guard-");
const wt = join(root, "wt");
const outside = join(homedir(), "orch-guard-never-written.txt");
mkdirSync(join(wt, "src"), { recursive: true });
symlinkSync(homedir(), join(wt, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("lane write guard", () => {
  test("only the worktree is writable, not even /tmp; .. and symlinks resolved", () => {
    expect(writable(join(wt, "src/a.ts"), wt)).toBe(true);
    expect(writable("src/new/b.ts", wt)).toBe(true);
    expect(writable("/tmp/scratch.txt", wt)).toBe(false);
    expect(writable(join(root, "main-checkout/file.ts"), wt)).toBe(false);
    expect(writable(outside, wt)).toBe(false);
    expect(writable(join(wt, "../../../etc/passwd"), wt)).toBe(false);
    expect(writable(join(wt, "escape/x.txt"), wt)).toBe(false);
  });

  test("blocking: the hook denies a file tool aimed outside, lets the rest through", () => {
    const deny = guardDecision({ tool_name: "Write", tool_input: { file_path: outside } }, wt);
    expect(JSON.parse(deny!).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(guardDecision({ tool_name: "Edit", tool_input: { file_path: join(wt, "escape/.bashrc") } }, wt)).not.toBeNull();
    expect(guardDecision({ tool_name: "Edit", tool_input: { file_path: join(wt, "src/a.ts") } }, wt)).toBeNull();
    expect(guardDecision({ tool_name: "Read", tool_input: { file_path: outside } }, wt)).toBeNull();
  });

  test("the Claude write worker carries the guard hook, and the hook script denies for real", () => {
    const argv = workerArgv("claude", {}, { cwd: wt, promptPath: "/p", readOnly: false, lastMessagePath: "/l" }).argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
    expect(settings.sandbox).toEqual(CLAUDE_SANDBOX.sandbox);
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
    const run = (input: object) => spawnSync("sh", ["-c", command], { input: JSON.stringify(input), encoding: "utf8" });
    const denied = run({ tool_name: "Write", tool_input: { file_path: outside } });
    expect(denied.status).toBe(0);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    expect(run({ tool_name: "Write", tool_input: { file_path: join(wt, "ok.txt") } }).stdout).toBe("");
  });

  test("detection: a write that succeeded outside counts, a denied one is only reported", () => {
    const line = (o: object) => JSON.stringify(o);
    const claude = [
      line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: outside } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/etc/hosts" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "denied" }] } }),
      line({ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: join(wt, "src/a.ts") } }] } }),
    ].join("\n");
    expect(outsideWrites("claude", claude, wt)).toEqual({ written: [outside], denied: ["/etc/hosts"] });
    const codex = line({ type: "item.completed", item: { id: "i1", type: "file_change", status: "completed", changes: [{ path: outside, kind: "add" }, { path: join(wt, "a"), kind: "add" }] } });
    expect(outsideWrites("codex", codex, wt)).toEqual({ written: [outside], denied: [] });
  });
});
