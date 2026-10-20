import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bound, laneGc, laneRun, setupCommand, SNAPSHOT_LIMITS } from "../src/lane.ts";
import { loadProfile, type Profile } from "../src/profile.ts";
import { releaseSlot, reserveSlot } from "../src/slots.ts";

let root: string;
let repo: string;
let bin: string;
const savedPath = process.env.PATH;
const profile: Profile = { ...loadProfile("max20"), limits: { max_concurrent: 5, max_depth: 1, report_max_bytes: 4096, timeout_seconds: 30 } };

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

// Fake harness binary: its behavior is baked into the script.
function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
  chmodSync(p, 0o755);
}

function spec(verify: string) {
  const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, SPEC(verify));
  return p;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lane-test-"));
  repo = join(root, "repo");
  bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  sh(repo, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  process.env.ORCH_STATE = join(root, "state");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
});

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("lane run classes", () => {
  test("complete: change committed on the lane branch, usage parsed", async () => {
    fake("codex", 'echo hi > out.txt; echo "tokens used"; echo "1 234"');
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain("USAGE: total 1234");
    expect(report).toContain(`INTEGRATE: git merge --squash ${state!.branch}`);
    expect(sh(repo, `git show --stat ${state!.branch}`).stdout).toContain("out.txt");
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

  test("unavailable: harness binary missing", async () => {
    rmSync(join(bin, "claude"), { force: true });
    const { state } = await laneRun({ to: "claude", specPath: spec("true"), repo, profile });
    expect(state?.status).toBe("unavailable");
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
    expect(readFileSync(join(state!.worktree, "shared.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(state!.worktree, "component.txt"), "utf8")).toBe("new\n");
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
});

describe("report and slots", () => {
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

  test("a slot held by a dead process is reclaimed", () => {
    const sd = join(root, "slots-stale");
    mkdirSync(join(sd, "slots", "0"), { recursive: true });
    writeFileSync(join(sd, "slots", "0", "pid"), "999999999 ghost");
    expect(reserveSlot(sd, 1, "e")).toBe(0);
  });
});

describe("gc", () => {
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
});

describe("profiles", () => {
  test("both shipped profiles load and never pin a Grok lane model", () => {
    for (const name of ["max20", "lean"]) expect(loadProfile(name).lanes.grok.model ?? null).toBeNull();
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
    expect(readFileSync(join(state!.worktree, "ignored", "fixture.txt"), "utf8")).toBe("forced\n");
    expect(readFileSync(join(state!.worktree, "new.txt"), "utf8")).toBe("untracked\n");
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

  test("the snapshot budget refuses an oversized untracked tree", async () => {
    const r = fresh("snap-budget");
    writeFileSync(join(r, "x1.bin"), "1");
    writeFileSync(join(r, "x2.bin"), "2");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
      expect(report).toContain("untracked files too large to snapshot (2 files");
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

  test("the local setup script runs as argv, never through a shell string", () => {
    const r = join(root, "repo $(touch pwned) `id`");
    mkdirSync(join(r, ".orch"), { recursive: true });
    writeFileSync(join(r, ".orch", "lane-setup"), "true\n");
    const cmd = setupCommand({ raw: "", fields: {} }, r);
    expect(cmd?.argv).toEqual(["sh", join(r, ".orch", "lane-setup")]);
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
