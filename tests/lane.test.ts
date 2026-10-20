import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bound, laneGc, laneRun } from "../src/lane.ts";
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
