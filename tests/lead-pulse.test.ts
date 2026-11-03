import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLaunches, recordLaunch, staleReason, writePulse } from "../src/core/lead-pulse.ts";
import { restartNotes } from "../src/install/restart.ts";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "orch-pulse-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const launch = (pid: number, over: Partial<Parameters<typeof recordLaunch>[0]> = {}) => ({
  pid, harness: "claude", conductor: "kiba", rev: "a".repeat(40), model: "opus", effort: "high",
  cwd: "/work/p", started: "2026-11-02T08:00:00.000Z", presence: false, ...over,
});

describe("lead registry", () => {
  test("records of a dead lead are dropped with its pulse", () => {
    const state = temp();
    recordLaunch(launch(10), state);
    recordLaunch(launch(11), state);
    writePulse(11, "busy", state);
    expect(liveLaunches(state, (pid) => pid === 10).map((r) => r.pid)).toEqual([10]);
    expect(existsSync(join(state, "leads", "pulse-11.json"))).toBe(false);
  });

  test("a lead is stale when the code or its model or effort changed since launch", () => {
    expect(staleReason(launch(1), { rev: "a".repeat(40), model: "opus", effort: "high" })).toBeNull();
    expect(staleReason(launch(1, { model: "sonnet", effort: "medium" }), { rev: "a".repeat(40), model: "opus", effort: "high" }))
      .toBe("model sonnet -> opus, effort medium -> high");
    expect(staleReason(launch(1), { rev: "b".repeat(40) })).toBe("code aaaaaaa -> bbbbbbb");
  });

  test("a native Claude launch is compared with the current choice; a retired lead is told to quit", () => {
    const notes = restartNotes({
      rev: "a".repeat(40),
      launches: [
        launch(20, { execution: "native", model: "sonnet", effort: "medium" }),
        launch(21, { execution: "conductor" }), launch(22, { harness: "codex", execution: "conductor" }), launch(23, { presence: true }),
      ],
      proc: { leads: [], parents: new Map() },
      current: () => ({ model: "sonnet", effort: "medium" }),
    });
    expect(notes).toEqual([
      expect.stringMatching(/^RESTART kiba pid 21 in \/work\/p: the dispatch-only conductor is retired \(orch serve replaced it\); quit it/),
      expect.stringMatching(/^RESTART kiba pid 22 in \/work\/p: Kiba runs on Claude only \(codex is a lane worker and reviewer\)/),
      expect.stringMatching(/^RESTART kiba pid 23 in \/work\/p: the presence lead is retired/),
    ]);
  });

  test("install lists what to restart, launched leads and legacy ones by their argv", () => {
    const notes = restartNotes({
      rev: "b".repeat(40),
      launches: [launch(10, { execution: "native" }), launch(11, { execution: "native", rev: "b".repeat(40) })],
      current: () => ({ model: "opus", effort: "high" }),
      proc: {
        parents: new Map([[100, 10], [200, 1]]),
        leads: [
          { id: "a", project: "p", pid: 100, harness: "claude", model: "opus", effort: "high", permissionMode: null, started: null, uptimeSec: null, remoteControl: false, supervised: false, cwd: "/work/p", activity: "idle" },
          { id: "b", project: "lab", pid: 200, harness: "claude", model: "sonnet", effort: "medium", permissionMode: null, started: null, uptimeSec: null, remoteControl: true, supervised: false, cwd: "/lab", activity: "idle" },
        ],
      },
    });
    expect(notes).toEqual([
      expect.stringMatching(/^RESTART kiba pid 10 in \/work\/p: code aaaaaaa -> bbbbbbb; quit it and start kiba again/),
      expect.stringMatching(/^RESTART lead pid 200 in \/lab: started before launch tracking, model sonnet -> opus, effort medium -> high/),
    ]);
  });
});
