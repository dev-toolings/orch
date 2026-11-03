import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkExitCode } from "../src/lane.ts";
import { formatBrief } from "../src/lanes/brief.ts";
import { checkLane, formatCheck, frontFiles } from "../src/lanes/check.ts";
import { comparePlans, deletionScore, parsePlanner, plannerOf } from "../src/lanes/plan.ts";
import { formatFindings, scoreFindings } from "../src/lanes/score.ts";
import { parseSpec } from "../src/lanes/spec.ts";
import { loadProfile } from "../src/core/profile.ts";
import type { LaneState } from "../src/lane.ts";

function spec() {
  return parseSpec(`OBJECTIVE: add a header
FILES: src/app.ts
INTERFACES: export function header(): string
CONSTRAINTS: do not touch tests
VERIFY: bun test
ACCEPT: header() returns ok
`);
}

describe("worker brief", () => {
  test("is a clean hand-off with objective, cwd, context, deliverable, done", () => {
    const text = formatBrief({ spec: spec(), cwd: "/tmp/wt", context: "caller is on feat/x" });
    expect(text).toContain("OBJECTIVE: add a header");
    expect(text).toContain("CWD: /tmp/wt");
    expect(text).toContain("caller is on feat/x");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("VERIFY exits 0: bun test");
    expect(text).toContain("This is a new conversation");
    expect(text).not.toContain("parent session");
  });

  test("tells the worker to run plain commands and where its temp dir is", () => {
    const text = formatBrief({ spec: spec(), cwd: "/tmp/wt" });
    expect(text).toContain("VERIFY already runs from the worktree root. Run plain commands");
    expect(text).toContain("TMPDIR is your own");
  });
});

describe("planner", () => {
  test("orch.yaml planner overlays the profile, default is read-only codex", () => {
    expect(parsePlanner({ to: "grok", model: "grok-4.7-build-fast" })).toEqual({ to: "grok", model: "grok-4.7-build-fast" });
    expect(parsePlanner({ to: "nope" })).toBeNull();
    expect(plannerOf(loadProfile("max20")).to).toBe("codex");
  });

  test("the plan that deletes more is preferred", () => {
    const lead = "Keep helpers.ts and utils.ts. Add a thin wrapper.";
    const planner = "DELETE:\n- helpers.ts\n- unused.ts\nKEEP: the wrapper";
    expect(deletionScore(planner)).toBeGreaterThan(deletionScore(lead));
    const cmp = comparePlans(lead, planner);
    expect(cmp.preferred).toBe("planner");
    expect(cmp.diff).toContain("+ - helpers.ts");
    expect(comparePlans(lead, lead).preferred).toBe("tie");
  });

  test("negated delete/remove words do not count as deletions", () => {
    expect(deletionScore("Do not delete files.\nNever remove helpers.ts")).toBe(0);
    expect(deletionScore("REMOVE:\n- helpers.ts\n- utils.ts")).toBe(2);
    expect(deletionScore("DELETE: a.ts, b.ts")).toBe(2);
    expect(deletionScore("- src/old.ts (12 lines)")).toBe(1);
  });
});

describe("scored review", () => {
  test("product >= 5 is fix, below 5 is backlog", () => {
    const text = `
VERDICT: fix-first
FINDING: missing auth on POST | FREQ: 8 | SEV: 7
FINDING: typo in comment | FREQ: 1 | SEV: 2
1. noisy log — freq: 2 sev: 2
`;
    const findings = scoreFindings(text);
    expect(findings).toEqual([
      { text: "missing auth on POST", frequency: 8, severity: 7, product: 56, action: "fix" },
      { text: "typo in comment", frequency: 1, severity: 2, product: 2, action: "backlog" },
      { text: "noisy log", frequency: 2, severity: 2, product: 4, action: "backlog" },
    ]);
    expect(formatFindings(findings)).toContain("FIX  8x7=56");
    expect(formatFindings(findings)).toContain("BACKLOG  1x2=2");
  });
});

describe("lane check", () => {
  let root: string;
  let repo: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "orch-check-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    expect(spawnSync("sh", ["-c", "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base && git checkout -q -b feat/x"], { cwd: repo, encoding: "utf8" }).status).toBe(0);
    writeFileSync(join(repo, "app.txt"), "hello\n");
    writeFileSync(join(repo, "index.html"), "<p>hi</p>\n");
    expect(spawnSync("sh", ["-c", "git add -A && git -c user.email=t@t -c user.name=t commit -qm change"], { cwd: repo, encoding: "utf8" }).status).toBe(0);
  }, 20_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("frontFiles picks html/css/tsx and skips tests", () => {
    expect(frontFiles(["src/App.tsx", "src/App.test.tsx", "readme.md"])).toEqual(["src/App.tsx"]);
  });

  test("checkLane reads the real diff and re-runs VERIFY", () => {
    const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
    const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const state: LaneState = {
      id: "check-1", to: "codex", repo, base, branch: "feat/x", worktree: repo,
      status: "complete", changed: true, usage: {}, started: "", ended: "",
      verifiedSha: sha, verify: "test -f app.txt",
    };
    const out = checkLane(state, { browser: null });
    expect(out.files).toEqual(expect.arrayContaining(["app.txt", "index.html"]));
    expect(out.verifyOk).toBe(true);
    expect(out.browser && "skipped" in out.browser).toBe(true);
    expect(formatCheck("check-1", out)).toContain("Do not trust the worker's done");
  });

  test("checkLane after the worktree is gone verifies the lane commit, not the caller repo", () => {
    const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
    const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(repo, "app.txt"), "caller dirtied this\n");
    const state: LaneState = {
      id: "check-gone", to: "codex", repo, base, branch: "feat/x",
      worktree: join(root, "missing-wt"),
      status: "complete", changed: true, usage: {}, started: "", ended: "",
      verifiedSha: sha, verify: "grep -q hello app.txt",
    };
    const out = checkLane(state, { browser: null });
    expect(out.refused).toBeUndefined();
    expect(out.verifyOk).toBe(true);
    expect(out.files).toEqual(expect.arrayContaining(["app.txt", "index.html"]));
  });

  test("checkLane provisions a fresh checkout with the lane SETUP before VERIFY", () => {
    const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
    const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const state: LaneState = {
      id: "check-setup", to: "codex", repo, base, branch: "feat/x",
      worktree: join(root, "missing-wt-setup"),
      status: "complete", changed: true, usage: {}, started: "", ended: "",
      verifiedSha: sha, verify: "test -f deps.ok", setupArgv: ["sh", "-c", "touch deps.ok"],
    };
    expect(checkLane(state, { browser: null }).verifyOk).toBe(true);
    const failing = checkLane({ ...state, setupArgv: ["sh", "-c", "echo no network >&2; exit 3"] }, { browser: null });
    expect(failing.verifyOk).toBe(false);
    expect(failing.verifyOut).toContain("setup failed (exit 3): no network");
  });

  test("VERIFY fail and a refused check are non-zero exits", () => {
    expect(checkExitCode("LANE CHECK\nVERIFY: fail\n")).toBe(2);
    expect(checkExitCode("LANE CHECK\nSTATUS: refused-by-lane\nREASON: gone\n")).toBe(2);
    expect(checkExitCode("LANE CHECK\nVERIFY: ok\n")).toBe(0);
  });
});
