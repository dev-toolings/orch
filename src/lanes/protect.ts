// Worker-protected paths and base-commit VERIFY: a lane cannot land a change
// that edits guardrail files, and it cannot weaken the tests that were on
// the base commit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "../core/git.ts";
import { isTestPath, protectedPath } from "../core/sensitive.ts";
import { workerEnv } from "../harness/proc.ts";

export { isTestPath, protectedPath };

// A previous buggy write of `git config core.hooksPath` (no --worktree) left
// the shared repo config pointing at a deleted /tmp/orch-base-verify-…/no-hooks
// or a lane state dir. Those are ours; a user path is not.
export function isOrchHooksPath(value: string): boolean {
  const n = value.replace(/\\/g, "/");
  return /\/orch-base-verify-[^/]+\/no-hooks\/?$/.test(n)
    || /\/lanes\/[^/]+\/no-hooks\/?$/.test(n);
}

// Neutralize hooks for this worktree only. Never write shared core.hooksPath.
// Enables extensions.worktreeConfig (safe, repo-wide) then `git config --worktree`.
// If a leftover orch no-hooks path is still on the shared config, unset it.
export function neutralizeWorktreeHooks(wt: string, noHooksDir: string): void {
  mkdirSync(noHooksDir, { recursive: true });
  git(wt, "config", "extensions.worktreeConfig", "true");
  const shared = git(wt, "config", "--local", "--get", "core.hooksPath");
  if (shared.ok && isOrchHooksPath(shared.out)) {
    git(wt, "config", "--unset", "--local", "core.hooksPath");
  }
  git(wt, "config", "--worktree", "core.hooksPath", noHooksDir);
}

export function protectedTouched(files: string[]): string[] {
  return files.filter((f) => protectedPath(f));
}

export function testFilesChanged(files: string[]): string[] {
  return files.filter((f) => isTestPath(f));
}

// Provisions a fresh worktree like the lane's SETUP did (a new checkout has
// no dependencies). Null when it ran fine or there is none; else the reason.
export function runFreshSetup(setup: string[] | undefined, wt: string, repo: string): string | null {
  if (!setup?.length) return null;
  const [cmd, ...args] = setup;
  const st = spawnSync(cmd!, args, { cwd: wt, env: workerEnv({ LANE_REPO: repo, LANE_WORKTREE: wt }), encoding: "utf8", timeout: VERIFY_TIMEOUT_MS });
  if (st.status === 0) return null;
  const o = `${st.stdout ?? ""}${st.stderr ?? ""}${st.error ? String(st.error) : ""}`.trim();
  return `setup failed (exit ${st.status ?? "none"}): ${o.slice(-600)}`;
}

// One budget for every VERIFY run: the lane's, `lane check`'s and the base
// commit's. A shorter one here refused lanes whose VERIFY the lane passed
// (core: phpstan alone takes 90 s in its container).
export const VERIFY_TIMEOUT_MS = 600_000;

export function runBaseCommitVerify(opts: {
  repo: string;
  base: string;
  sha: string;
  verify: string;
  files: string[];
  // The lane's SETUP argv, run in the base worktree before VERIFY.
  setup?: string[];
}): { skipped: true } | { ok: boolean; out: string } {
  const tests = testFilesChanged(opts.files);
  if (!tests.length) return { skipped: true };
  // New tests have no base version to protect. Avoid running a scoped VERIFY
  // after removing every test it names.
  const hasBaseTest = tests.some((file) =>
    git(opts.repo, "cat-file", "-e", `${opts.base}:${file}`).ok);
  if (!hasBaseTest) return { skipped: true };
  const dir = mkdtempSync(join(tmpdir(), "orch-base-verify-"));
  const wt = join(dir, "wt");
  try {
    const added = git(opts.repo, "worktree", "add", "--detach", "-q", wt, opts.sha);
    if (!added.ok) return { ok: false, out: added.err || "worktree add failed" };
    neutralizeWorktreeHooks(wt, join(dir, "no-hooks"));
    for (const file of tests) {
      const show = spawnSync("git", ["-C", opts.repo, "show", `${opts.base}:${file}`], { encoding: "utf8" });
      if (show.status === 0) writeFileSync(join(wt, file), show.stdout);
      else spawnSync("git", ["-C", wt, "rm", "-f", "--quiet", "--ignore-unmatch", file], { encoding: "utf8" });
    }
    const setupFailed = runFreshSetup(opts.setup, wt, opts.repo);
    if (setupFailed) return { ok: false, out: `base ${setupFailed}` };
    const run = spawnSync("sh", ["-c", opts.verify], { cwd: wt, env: workerEnv({ LANE_REPO: opts.repo, LANE_WORKTREE: wt }), encoding: "utf8", timeout: VERIFY_TIMEOUT_MS });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    return { ok: run.status === 0, out: out.slice(-800) };
  } finally {
    spawnSync("git", ["-C", opts.repo, "worktree", "remove", "--force", wt], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
  }
}
