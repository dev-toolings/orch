// After a worker says done: look at the real diff and re-run VERIFY. Never
// trust the worker's report. A headless browser check is optional for front files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../core/git.ts";
import type { LaneState } from "../lane.ts";
import { runFreshSetup, VERIFY_TIMEOUT_MS } from "./protect.ts";
import { verifyReach } from "./reach.ts";
import { workerEnv } from "../harness/proc.ts";

const FRONT = /\.(html?|css|scss|jsx?|tsx?|vue|svelte|astro)$/i;

export function frontFiles(files: string[]): string[] {
  return files.filter((f) => FRONT.test(f) && !/\.(test|spec)\./i.test(f));
}

export function browserBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ORCH_BROWSER) return env.ORCH_BROWSER;
  for (const name of ["chromium", "google-chrome", "chromium-browser", "firefox"]) {
    const which = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  return null;
}

export function laneTip(state: LaneState): string | undefined {
  if (state.verifiedSha) return state.verifiedSha;
  const rev = git(state.repo, "rev-parse", `${state.branch}^{commit}`);
  return rev.ok ? rev.out : undefined;
}

// Verification is evidence for one unchanged commit, never a dirty tree.
export function verifiedCommit(cwd: string, expected: string): string | undefined {
  const tip = git(cwd, "rev-parse", "HEAD");
  return tip.ok && tip.out === expected && git(cwd, "diff", "--quiet", "HEAD").ok ? tip.out : undefined;
}

// `setup`: the lane's SETUP argv, run in a fresh checkout before VERIFY.
export function checkLane(state: LaneState, opts?: { verify?: string; browser?: string | null; setup?: string[] }): {
  diff: string;
  files: string[];
  verifyOk: boolean | null;
  verifyOut: string;
  refused?: string;
  browser?: { skipped: string } | { ok: boolean; out: string };
} {
  const tip = laneTip(state);
  const names = tip ? git(state.repo, "diff", "--name-only", "--no-renames", state.base, tip) : undefined;
  const files = names?.ok ? names.out.split("\n").filter(Boolean) : state.touched ?? [];
  const stat = tip ? git(state.repo, "diff", "--stat", state.base, tip) : undefined;
  const diff = stat?.ok ? stat.out.trim() : "(no diff)";
  const verify = opts?.verify ?? state.verify;
  let verifyOk: boolean | null = null;
  let verifyOut = "not run";
  let refused: string | undefined;
  let tmp: string | undefined;
  let cwd: string | undefined;
  if (existsSync(state.worktree)) cwd = state.worktree;
  else if (tip) {
    tmp = mkdtempSync(join(tmpdir(), "orch-check-"));
    const wt = join(tmp, "wt");
    mkdirSync(tmp, { recursive: true });
    const added = git(state.repo, "worktree", "add", "--detach", "-q", wt, tip);
    if (!added.ok) refused = `cannot check out ${tip}: ${(added.err || added.out).trim() || "worktree add failed"}`;
    else cwd = wt;
  } else {
    refused = "lane worktree gone and no commit to check";
  }
  try {
    // A fresh checkout has no dependencies: provision it like the lane did.
    const setupFailed = tmp && cwd && verify ? runFreshSetup(opts?.setup ?? state.setupArgv, cwd, state.repo) : null;
    if (setupFailed) {
      verifyOk = false;
      verifyOut = setupFailed;
    } else if (verify && cwd) {
      const env = workerEnv({ LANE_REPO: state.repo, LANE_WORKTREE: cwd });
      // A VERIFY that tests another checkout proves nothing (src/lanes/reach.ts).
      const escape = verifyReach(verify, cwd, env);
      if (escape) {
        verifyOk = false;
        verifyOut = escape;
      } else {
        const run = spawnSync("sh", ["-c", verify], { cwd, env, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS });
        verifyOk = run.status === 0;
        verifyOut = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().slice(-800) || `exit ${run.status}`;
      }
    }
  } finally {
    if (tmp) {
      spawnSync("git", ["-C", state.repo, "worktree", "remove", "--force", join(tmp, "wt")], { encoding: "utf8" });
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const front = frontFiles(files);
  let browser: { skipped: string } | { ok: boolean; out: string } | undefined;
  if (front.length) {
    const bin = opts?.browser === undefined ? browserBin() : opts.browser;
    if (!bin) browser = { skipped: `front files ${front.join(", ")}: no headless browser on PATH` };
    else {
      const run = spawnSync(bin, ["--headless", "--disable-gpu", "--dump-dom", "about:blank"], {
        encoding: "utf8", timeout: 20_000,
      });
      browser = { ok: run.status === 0, out: (run.stderr || run.stdout || `exit ${run.status}`).trim().slice(0, 200) };
    }
  }
  return { diff, files, verifyOk, verifyOut, ...(refused ? { refused } : {}), ...(browser ? { browser } : {}) };
}

export function formatCheck(id: string, result: ReturnType<typeof checkLane>): string {
  if (result.refused) {
    return `LANE CHECK\nSTATUS: refused-by-lane\nREASON: ${result.refused}\nID: ${id}\n`;
  }
  const browser = result.browser
    ? "skipped" in result.browser
      ? `BROWSER: skipped (${result.browser.skipped})`
      : `BROWSER: ${result.browser.ok ? "ok" : "fail"} ${result.browser.out}`
    : "BROWSER: not a front change";
  return [
    "LANE CHECK",
    `ID: ${id}`,
    `FILES: ${result.files.join(", ") || "none"}`,
    `DIFF:\n${result.diff || "(empty)"}`,
    `VERIFY: ${result.verifyOk === null ? "not run" : result.verifyOk ? "ok" : "fail"}`,
    result.verifyOut && result.verifyOut !== "not run" ? result.verifyOut : "",
    browser,
    "Do not trust the worker's done: this is the real tree.",
  ].filter(Boolean).join("\n") + "\n";
}
