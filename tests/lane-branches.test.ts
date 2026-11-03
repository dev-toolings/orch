import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testRepoRefusal } from "../src/lanes/worktree.ts";

test("a test run refuses lane branches in the orch repo, not in a temporary repo", () => {
  const orch = resolve(import.meta.dir, "..");
  const tmp = mkdtempSync(join(tmpdir(), "orch-guard-"));
  try {
    spawnSync("git", ["init", "-q", tmp]);
    expect(testRepoRefusal(orch, { NODE_ENV: "test" })).toContain("refusing to create a lane/* branch");
    expect(testRepoRefusal(orch, { BUN_TEST: "1" })).not.toBeNull();
    expect(testRepoRefusal(tmp, { NODE_ENV: "test" })).toBeNull();
    expect(testRepoRefusal(orch, {})).toBeNull();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
