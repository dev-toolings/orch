import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { affectedTests, candidateTests, gateVerify, isBunTest, prePushFiles } from "../src/lanes/affected.ts";
import { emptyTiming, formatTiming } from "../src/lanes/timing.ts";
import { bunCacheDir } from "../src/core/paths.ts";
import { runLogged, workerEnv } from "../src/harness/proc.ts";
import { lanePrePush } from "../src/lane.ts";
import { laneReport } from "../src/lanes/report.ts";

describe("affected tests", () => {
  test("maps src files to sibling tests and keeps touched test files", () => {
    const exists = (p: string) => [
      "src/foo.ts", "tests/foo.test.ts", "src/bar.test.ts", "checks/lock.ts",
    ].includes(p);
    expect(candidateTests("src/foo.ts")).toContain("tests/foo.test.ts");
    expect(affectedTests(["src/foo.ts", "src/bar.test.ts", "readme.md"], exists)).toEqual([
      "src/bar.test.ts", "tests/foo.test.ts",
    ]);
  });

  test("gateVerify rewrites bun test to the affected list unless ORCH_GATE_FULL", () => {
    expect(isBunTest("bun test")).toBe(true);
    expect(isBunTest("make check")).toBe(false);
    const exists = (p: string) => p === "tests/foo.test.ts";
    const scoped = gateVerify("bun test", ["src/foo.ts"], { exists });
    expect(scoped.full).toBe(false);
    expect(scoped.command).toBe("bun test tests/foo.test.ts");
    expect(gateVerify("make check", ["src/foo.ts"], { exists }).full).toBe(true);
    expect(gateVerify("bun test", ["src/foo.ts"], { exists, env: { ORCH_GATE_FULL: "1" } }).command).toBe("bun test");
    expect(gateVerify("bun test", ["docs/a.md"], { exists: () => false }).full).toBe(true);
  });
});

describe("gate timings", () => {
  test("formatTiming splits wait / setup / run", () => {
    expect(formatTiming({ waitMs: 120, setupMs: 3100, runMs: 40 })).toBe(
      "GATE TIME: wait 120ms · setup 3.1s · run 40ms",
    );
    expect(formatTiming(emptyTiming())).toBe("GATE TIME: wait 0ms · setup 0ms · run 0ms");
  });

  test("lane report surfaces GATE TIME and VERIFY SCOPE", () => {
    const text = laneReport({
      to: "codex", model: "m", effort: "low", status: "complete", id: "id",
      base: "base", branch: "lane/id", setupLine: "SETUP: none", stat: "none",
      verifyOut: "exit 0", message: "done", usage: {}, changed: false, logPath: "/tmp/log",
      gate: { waitMs: 10, setupMs: 20, runMs: 30 }, verifyScope: "affected tests/foo.test.ts",
    });
    expect(text).toContain("GATE TIME: wait 10ms · setup 20ms · run 30ms");
    expect(text).toContain("VERIFY SCOPE: affected tests/foo.test.ts");
  });
});

describe("shared bun cache + pre-push", () => {
  let root: string;
  let repo: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "orch-gate-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "tests"), { recursive: true });
    expect(spawnSync("sh", ["-c", "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base"], {
      cwd: repo, encoding: "utf8",
    }).status).toBe(0);
    writeFileSync(join(repo, "tests", "ok.test.ts"), 'import { expect, test } from "bun:test"; test("ok", () => expect(1).toBe(1));\n');
    writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");
    expect(spawnSync("sh", ["-c", "git add -A && git -c user.email=t@t -c user.name=t commit -qm change"], {
      cwd: repo, encoding: "utf8",
    }).status).toBe(0);
  }, 20_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }), 20_000);

  test("workerEnv pins BUN_INSTALL_CACHE_DIR under the state dir", () => {
    const prev = process.env.ORCH_STATE;
    process.env.ORCH_STATE = join(root, "state");
    try {
      expect(workerEnv().BUN_INSTALL_CACHE_DIR).toBe(bunCacheDir(join(root, "state")));
    } finally {
      if (prev === undefined) delete process.env.ORCH_STATE;
      else process.env.ORCH_STATE = prev;
    }
  });

  test("prePushFiles lists the diff; lanePrePush runs affected bun test", () => {
    expect(prePushFiles(repo, "HEAD~1")).toEqual(expect.arrayContaining(["src.ts", "tests/ok.test.ts"]));
    const result = lanePrePush({ repo, base: "HEAD~1", verify: "bun test" });
    expect(result.ok).toBe(true);
    expect(result.report).toContain("LANE PRE-PUSH");
    expect(result.report).toContain("SCOPE: affected tests/ok.test.ts");
    expect(result.report).toContain("GATE TIME:");
    expect(result.report).toContain("STATUS: ok");
  }, 20_000);

  test("VERIFY runMs covers the command wall time, not just spawn", () => {
    const result = lanePrePush({ repo, verify: "sleep 0.3" });
    expect(result.ok).toBe(true);
    const run = /run (\d+)ms/.exec(result.report) ?? /run ([\d.]+)s/.exec(result.report);
    expect(run).toBeTruthy();
    const ms = run![1].includes(".") ? Number(run![1]) * 1000 : Number(run![1]);
    expect(ms).toBeGreaterThanOrEqual(250);
  }, 20_000);
});

describe("runLogged VERIFY clock", () => {
  test("the same clock lane run uses waits for sleep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-verify-clock-"));
    try {
      const log = join(dir, "v.log");
      const t0 = performance.now();
      const v = await runLogged(["sh", "-c", "sleep 0.3"], {
        cwd: dir, logPath: log, timeoutMs: 5_000, env: workerEnv(),
      });
      const runMs = Math.round(performance.now() - t0);
      expect(v.code).toBe(0);
      expect(runMs).toBeGreaterThanOrEqual(250);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
