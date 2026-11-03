import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/core/profile.ts";
import type { LaneState } from "../src/lane.ts";
import type { RunRecord } from "../src/lanes/ledger.ts";
import { TOKENS_PER_LANE } from "../src/lanes/budget.ts";
import { collectTop, listProjectNames, renderTop, topLanesOf } from "../src/top/top.ts";

const limits = loadProfile("max20").limits;
const machine = { cores: 16, memAvailableGib: 23 };

const lane = (over: Partial<LaneState> = {}): LaneState => ({
  id: "20261031T101010-claude-1-abcd",
  to: "claude",
  repo: "/tmp/orch",
  base: "abc",
  branch: "lane/x",
  worktree: "/tmp/wt",
  status: "complete",
  changed: true,
  usage: { input: 1000, output: 200 },
  started: "2026-10-31T10:00:00Z",
  ended: "2026-10-31T10:01:00Z",
  gate: { waitMs: 120, setupMs: 3100, runMs: 40 },
  ...over,
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  kind: "run",
  id: "20261031T101010-claude-1-abcd",
  at: "2026-10-31T10:01:00Z",
  repo: "/tmp/orch",
  to: "claude",
  model: "claude-haiku-4-5",
  effort: "high",
  channel: "cli",
  status: "complete",
  changed: true,
  verifyOk: true,
  features: { files: ["a.ts"], stacks: [], risk: [], objective: "" },
  diff: { files: ["a.ts"], insertions: 1, deletions: 0 },
  outOfScope: [],
  durationS: 12,
  usage: { input: 1000, output: 200 },
  ...over,
});

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-top-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("orch top", () => {
  test("listProjectNames skips hidden folders and bus-keys", () => {
    const home = join(root, "projects");
    mkdirSync(join(home, "orch"), { recursive: true });
    mkdirSync(join(home, "front"), { recursive: true });
    mkdirSync(join(home, "bus-keys"), { recursive: true });
    mkdirSync(join(home, ".cache"), { recursive: true });
    expect(listProjectNames(home)).toEqual(["front", "orch"]);
  });

  test("topLanesOf reads cost, gate and the ledger model", () => {
    const rows = topLanesOf([lane()], [run()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project: "orch",
      harness: "claude",
      model: "claude-haiku-4-5",
      status: "complete",
    });
    expect(rows[0].costUsd).toBeCloseTo(0.006);
    expect(rows[0].gate).toEqual({ waitMs: 120, setupMs: 3100, runMs: 40 });
  });

  test("renderTop shows spend, plan quota, lanes, gate time and bus", () => {
    const snap = collectTop({
      policy: { spend: { daily_usd: 5, embed_usd_per_million: 0.02, plan_tokens: TOKENS_PER_LANE * 4 }, paid_routines: [] },
      machine,
      limits,
      now: new Date("2026-10-31T12:00:00Z"),
      lanes: [lane()],
      ledger: [run()],
      spendUsed: 0.12,
      planUsed: TOKENS_PER_LANE * 2,
      projectsRoot: join(root, "empty-projects"),
      bus: [{ project: "orch", lines: ["abc  request  front->orch  hop 1"] }],
    });
    expect(snap.budget).toMatchObject({ budget: 2, quota: 2, limitedBy: "quota" });
    const text = renderTop(snap);
    expect(text).toContain("orch top  2026-10-31T12:00:00.000Z");
    expect(text).toContain("ESTIMATED COST (TODAY)  $0.1200");
    expect(text).toContain("PLAN   160k / 320k");
    expect(text).toContain("BUDGET 2  limited by quota");
    expect(text).toContain("orch");
    expect(text).toContain("complete");
    expect(text).toContain("claude-haiku");
    expect(text).toContain("$0.0060");
    expect(text).toContain("wait 120ms · setup 3.1s · run 40ms");
    expect(text).toContain("abc  request  front->orch  hop 1");
  });

  test("renderTop surfaces spend alerts from events.jsonl", () => {
    const snap = collectTop({
      policy: { spend: { daily_usd: 5, embed_usd_per_million: 0.02, plan_tokens: null }, paid_routines: [] },
      machine,
      limits,
      now: new Date("2026-11-01T12:00:00Z"),
      lanes: [],
      ledger: [],
      spendUsed: 4.1,
      planUsed: 0,
      projectsRoot: join(root, "empty-projects"),
      bus: [],
      events: [{ at: "2026-11-01T11:55:00Z", kind: "warn", text: "daily spend at 82% of $5 ($4.10)", source: "spend" }],
    });
    expect(renderTop(snap)).toContain("ALERTS:");
    expect(renderTop(snap)).toContain("daily spend at 82% of $5");
    expect(renderTop(snap)).toContain("ESTIMATED COST (TODAY)  $4.1000");
  });

  test("a spent plan quota zeroes the budget", () => {
    const snap = collectTop({
      policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: TOKENS_PER_LANE }, paid_routines: [] },
      machine,
      limits,
      lanes: [],
      spendUsed: 0,
      planUsed: TOKENS_PER_LANE,
      projectsRoot: join(root, "empty-projects"),
      bus: [],
    });
    expect(snap.budget.budget).toBe(0);
    expect(snap.budget.limitedBy).toBe("quota");
    expect(renderTop(snap)).toContain("BUDGET 0  limited by quota");
    expect(renderTop(snap)).toContain("PLAN   80k / 80k");
  });

  test("PLAN counts today's lane ledger tokens, not only Claude transcripts", () => {
    const snap = collectTop({
      policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: 80_000 }, paid_routines: [] },
      machine,
      limits,
      now: new Date("2026-10-31T12:00:00Z"),
      lanes: [],
      ledger: [run({ at: "2026-10-31T10:00:00Z", usage: { input: 10_000, output: 1_400 } })],
      spendUsed: 0,
      claudeProjects: join(root, "empty-claude"),
      projectsRoot: join(root, "empty-projects"),
      bus: [],
    });
    expect(snap.plan.used).toBe(11_400);
    expect(renderTop(snap)).toContain("PLAN   11k / 80k");
  });

  test("collectTop reads lanes from the state dir", () => {
    const state = join(root, "state-lanes");
    const id = "20261031T111111-codex-9-zzzz";
    mkdirSync(join(state, "lanes", id), { recursive: true });
    writeFileSync(join(state, "lanes", id, "state.json"), JSON.stringify(lane({
      id, to: "codex", repo: "/work/front", status: "running", started: "2026-10-31T11:00:00Z",
    })));
    const home = join(root, "projects-live");
    mkdirSync(join(home, "front"), { recursive: true });
    mkdirSync(join(home, "orch"), { recursive: true });
    const snap = collectTop({
      state,
      projectsRoot: home,
      policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: null }, paid_routines: [] },
      machine,
      limits,
      spendUsed: 0,
      planUsed: 0,
      bus: [],
    });
    expect(snap.projects).toEqual([
      { name: "front", lanes: 1 },
      { name: "orch", lanes: 0 },
    ]);
    expect(snap.lanes[0]).toMatchObject({ id, harness: "codex", project: "front", status: "running" });
    expect(snap.budget.limitedBy).toBe("cpu");
    expect(snap.plan.cap).toBeNull();
  });

  test("orch top --once prints the snapshot and exits", () => {
    const home = join(root, "cli-home");
    const state = join(root, "cli-state");
    mkdirSync(join(home, ".orch", "demo"), { recursive: true });
    mkdirSync(state, { recursive: true });
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "top", "--once"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ORCH_HOME: home, ORCH_STATE: state },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("orch top");
    expect(result.stdout).toContain("ESTIMATED COST (TODAY)");
    expect(result.stdout).toContain("PLAN   unlimited");
    expect(result.stdout).toContain("BUDGET");
    expect(result.stdout).toContain("demo");
    expect(result.stdout).toContain("LANES");
    expect(result.stdout).toContain("BUS");
  });
});
