import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/core/events.ts";
import {
  clearPause, killCli, killSwitch, killWorkers, pauseFile, resumeSwitch,
  terminateGroup, writePause,
} from "../src/core/kill.ts";
import { pauseReason } from "../src/core/policy.ts";
import { processGroupAlive } from "../src/harness/proc.ts";
import type { LaneState } from "../src/lane.ts";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-kill-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lane = (over: Partial<LaneState> = {}): LaneState => ({
  id: "20261101T101010-claude-1-abcd",
  to: "claude",
  repo: "/tmp/orch",
  base: "abc",
  branch: "lane/x",
  worktree: "/tmp/wt",
  status: "running",
  changed: true,
  usage: {},
  started: "2026-11-01T10:00:00Z",
  ended: "",
  workerPgid: 4242,
  ...over,
});

describe("orch kill / resume", () => {
  test("writePause and clearPause flip the PAUSE file", () => {
    const state = mkdtempSync(join(root, "pause-"));
    expect(pauseReason({}, state)).toBeNull();
    expect(writePause(state)).toBe(pauseFile(state));
    expect(existsSync(pauseFile(state))).toBe(true);
    expect(pauseReason({}, state)).toContain("PAUSE file");
    expect(clearPause(state)).toBe(true);
    expect(pauseReason({}, state)).toBeNull();
    expect(clearPause(state)).toBe(false);
  });

  test("terminateGroup SIGTERMs then SIGKILLs a fake process group", async () => {
    const signals: [number, NodeJS.Signals][] = [];
    let alive = true;
    const dead = await terminateGroup(4242, {
      kill: (pgid, signal) => {
        signals.push([pgid, signal]);
        if (signal === "SIGKILL") alive = false;
      },
      alive: () => alive,
      sleep: async () => {},
      graceMs: 0,
    });
    expect(dead).toBe(true);
    expect(signals).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });

  test("terminateGroup stops after SIGTERM when the group dies", async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const dead = await terminateGroup(7, {
      kill: (_pgid, signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") alive = false;
      },
      alive: () => alive,
      sleep: async () => {},
      graceMs: 50,
    });
    expect(dead).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("killWorkers targets one lane or all, using injected kill/alive", async () => {
    const a = lane({ id: "lane-a", workerPgid: 11 });
    const b = lane({ id: "lane-b", workerPgid: 22 });
    const idle = lane({ id: "lane-c", status: "complete", workerPgid: undefined });
    const seen: number[] = [];
    const deps = {
      list: () => [a, b, idle],
      kill: (pgid: number) => { seen.push(pgid); },
      alive: () => false,
      sleep: async () => {},
      graceMs: 0,
    };
    expect(await killWorkers("lane-b", root, deps)).toEqual({ killed: ["lane-b"], missed: [] });
    expect(seen).toEqual([22]);
    seen.length = 0;
    expect(await killWorkers("all", root, deps)).toEqual({ killed: ["lane-a", "lane-b"], missed: [] });
    expect(seen).toEqual([11, 22]);
  });

  test("killSwitch writes PAUSE and records an event", async () => {
    const state = mkdtempSync(join(root, "switch-"));
    const out = await killSwitch("all", state, {
      list: () => [lane({ id: "lane-a", workerPgid: 99 })],
      kill: () => {},
      alive: () => false,
      sleep: async () => {},
      graceMs: 0,
    });
    expect(out).toContain("KILL all");
    expect(out).toContain("workers  lane-a");
    expect(out).not.toContain("presence");
    expect(existsSync(pauseFile(state))).toBe(true);
    expect(readEvents(state).map((e) => e.text)).toEqual(["kill all"]);
    expect(resumeSwitch(state)).toContain("RESUME  cleared");
    expect(existsSync(pauseFile(state))).toBe(false);
    expect(resumeSwitch(state)).toBe("RESUME  not paused\n");
  });

  test("orch kill / resume CLI writes and clears PAUSE", async () => {
    const state = mkdtempSync(join(root, "cli-"));
    const out = await killCli(["--all"], state, {
      list: () => [],
    });
    expect(out).toContain("KILL all");
    expect(existsSync(pauseFile(state))).toBe(true);
    const resume = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "resume"], {
      encoding: "utf8",
      env: { ...process.env, ORCH_STATE: state },
    });
    expect(resume.status).toBe(0);
    expect(resume.stdout).toContain("RESUME  cleared");
    expect(existsSync(pauseFile(state))).toBe(false);
  });

  test("terminateGroup reaps a real detached sleep process", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = child.pid;
    expect(pgid).toBeGreaterThan(1);
    child.unref();
    expect(processGroupAlive(pgid)).toBe(true);
    expect(await terminateGroup(pgid!, { graceMs: 800 })).toBe(true);
    expect(processGroupAlive(pgid)).toBe(false);
  });
});
