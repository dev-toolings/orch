import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isOrchHooksPath, neutralizeWorktreeHooks, protectedTouched, runBaseCommitVerify, runFreshSetup, testFilesChanged,
} from "../src/lanes/protect.ts";

import { checkLane } from "../src/lanes/check.ts";
import type { LaneState } from "../src/lane.ts";

function sh(cwd: string, cmd: string) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

function repoWithApp(): { root: string; repo: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "orch-protect-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src/app.txt"), "hello\n");
  writeFileSync(join(repo, "tests/check.sh"), "grep -q hello src/app.txt\n");
  expect(sh(repo, "git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm base").status).toBe(0);
  return { root, repo, base: sh(repo, "git rev-parse HEAD").stdout.trim() };
}

describe("protect", () => {
  test("setup and both auxiliary VERIFY paths share the worker environment boundary", () => {
    const { root, repo, base } = repoWithApp();
    const saved = process.env.ORCH_TEST_PRIVATE_TOKEN;
    process.env.ORCH_TEST_PRIVATE_TOKEN = "synthetic-private-value";
    const verify = 'test -z "$ORCH_TEST_PRIVATE_TOKEN" && test "$ORCH_LANE" = 1 && test -d "$LANE_WORKTREE" && test -d "$LANE_REPO"';
    try {
      expect(runFreshSetup(["sh", "-c", verify], repo, repo)).toBeNull();
      expect(checkLane({ repo, worktree: repo, base, branch: "HEAD", verify } as LaneState, { browser: null }).verifyOk).toBe(true);
      expect(runBaseCommitVerify({ repo, base, sha: base, verify, files: ["tests/check.sh"] })).toMatchObject({ ok: true });
    } finally {
      if (saved === undefined) delete process.env.ORCH_TEST_PRIVATE_TOKEN;
      else process.env.ORCH_TEST_PRIVATE_TOKEN = saved;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("protectedTouched and testFilesChanged split a diff", () => {
    expect(protectedTouched(["src/a.ts", "CLAUDE.md", "catalog/lead.md"])).toEqual(["CLAUDE.md", "catalog/lead.md"]);
    expect(testFilesChanged(["src/a.ts", "tests/a.test.ts", "src/b.spec.ts"])).toEqual(["tests/a.test.ts", "src/b.spec.ts"]);
  });

  test("base-commit VERIFY skips when no test file changed", () => {
    const { root, repo, base } = repoWithApp();
    try {
      const out = runBaseCommitVerify({
        repo, base, sha: base, verify: "false", files: ["src/app.txt"],
      });
      expect(out).toEqual({ skipped: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("base-commit VERIFY skips when every changed test is new", () => {
    const { root, repo, base } = repoWithApp();
    try {
      writeFileSync(join(repo, "tests/new.test.ts"), 'import { test, expect } from "bun:test"; test("new", () => expect(true).toBe(true));\n');
      expect(sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -qm new-test").status).toBe(0);
      const sha = sh(repo, "git rev-parse HEAD").stdout.trim();
      expect(runBaseCommitVerify({
        repo, base, sha, verify: "bun test tests/new.test.ts", files: ["tests/new.test.ts"],
      })).toEqual({ skipped: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("base-commit scoped Bun VERIFY accepts a missing new test alongside a base test", () => {
    const { root, repo } = repoWithApp();
    try {
      const passing = 'import { test, expect } from "bun:test"; test("base", () => expect(true).toBe(true));\n';
      writeFileSync(join(repo, "tests/base.test.ts"), passing);
      expect(sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -qm base-test").status).toBe(0);
      const base = sh(repo, "git rev-parse HEAD").stdout.trim();
      writeFileSync(join(repo, "tests/base.test.ts"), 'throw new Error("must restore base test");\n');
      writeFileSync(join(repo, "tests/new.test.ts"), 'throw new Error("must remove new test");\n');
      expect(sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -qm mixed-tests").status).toBe(0);
      const sha = sh(repo, "git rev-parse HEAD").stdout.trim();
      const out = runBaseCommitVerify({
        repo, base, sha, verify: "bun test tests/base.test.ts tests/new.test.ts",
        files: ["tests/base.test.ts", "tests/new.test.ts"],
      });
      expect("skipped" in out).toBe(false);
      if ("skipped" in out) return;
      expect(out.ok).toBe(true);
      expect(out.out).toContain("1 pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("base-commit VERIFY restores the base tests so a weakened suite fails", () => {
    const { root, repo, base } = repoWithApp();
    try {
      writeFileSync(join(repo, "src/app.txt"), "bye\n");
      writeFileSync(join(repo, "tests/check.sh"), "grep -q bye src/app.txt\n");
      expect(sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -qm weaken").status).toBe(0);
      const sha = sh(repo, "git rev-parse HEAD").stdout.trim();
      expect(spawnSync("sh", ["-c", "sh tests/check.sh"], { cwd: repo, encoding: "utf8" }).status).toBe(0);
      const out = runBaseCommitVerify({
        repo, base, sha, verify: "sh tests/check.sh", files: ["src/app.txt", "tests/check.sh"],
      });
      expect("skipped" in out).toBe(false);
      if ("skipped" in out) return;
      expect(out.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("base-commit VERIFY runs setup first and reports a failed setup", () => {
    const { root, repo, base } = repoWithApp();
    try {
      const ok = runBaseCommitVerify({
        repo, base, sha: base, verify: "test -f .setup-ran", files: ["tests/check.sh"],
        setup: ["sh", "-c", "touch .setup-ran"],
      });
      expect("skipped" in ok).toBe(false);
      if ("skipped" in ok) return;
      expect(ok.ok).toBe(true);
      const bad = runBaseCommitVerify({
        repo, base, sha: base, verify: "true", files: ["tests/check.sh"], setup: ["sh", "-c", "exit 3"],
      });
      if ("skipped" in bad) return;
      expect(bad.ok).toBe(false);
      expect(bad.out).toContain("base setup failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("base-commit worktree has core.hooksPath pointed at an empty dir", () => {
    const { root, repo, base } = repoWithApp();
    try {
      const out = runBaseCommitVerify({
        repo, base, sha: base, verify: "git config --get core.hooksPath | grep -q no-hooks", files: ["tests/check.sh"],
      });
      expect("skipped" in out).toBe(false);
      if ("skipped" in out) return;
      expect(out.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("base-commit VERIFY does not rewrite the shared core.hooksPath", () => {
    const { root, repo, base } = repoWithApp();
    try {
      const user = join(root, "user-hooks");
      mkdirSync(user, { recursive: true });
      expect(sh(repo, `git config core.hooksPath ${user}`).status).toBe(0);
      const out = runBaseCommitVerify({
        repo, base, sha: base, verify: "git config --get core.hooksPath | grep -q no-hooks", files: ["tests/check.sh"],
      });
      expect("skipped" in out).toBe(false);
      if ("skipped" in out) return;
      expect(out.ok).toBe(true);
      expect(sh(repo, "git config --local --get core.hooksPath").stdout.trim()).toBe(user);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("a leftover orch no-hooks on the shared config is unset", () => {
    const { root, repo, base } = repoWithApp();
    try {
      const stale = join(root, "orch-base-verify-stale", "no-hooks");
      mkdirSync(stale, { recursive: true });
      expect(sh(repo, `git config core.hooksPath ${stale}`).status).toBe(0);
      expect(isOrchHooksPath(stale)).toBe(true);
      neutralizeWorktreeHooks(repo, join(root, "lane-no-hooks"));
      const shared = sh(repo, "git config --local --get core.hooksPath");
      expect(shared.status).not.toBe(0);
      expect(shared.stdout).not.toContain("orch-base-verify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
