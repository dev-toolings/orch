import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, summarize, type LedgerRow, type RunRecord } from "../src/lanes/ledger.ts";

function run(id: string, to: string, status: RunRecord["status"], durationS: number, usage: RunRecord["usage"] = {}): RunRecord {
  return {
    kind: "run", id, at: "", repo: "repo", to, model: "model", effort: "high", channel: "headless",
    status, changed: true, verifyOk: true,
    features: { files: [], stacks: [], risk: [], objective: "" },
    diff: { files: [], insertions: 0, deletions: 0 }, outOfScope: [], durationS, usage,
  };
}

const mixedRows: LedgerRow[] = [
  run("c-integrated", "codex", "complete", 10, { total: 101, input: 900, output: 800 }),
  { kind: "outcome", id: "c-integrated", at: "", outcome: "integrated", by: "integrate" },
  run("c-dropped", "codex", "complete", 11, { input: 20, output: 30 }),
  { kind: "outcome", id: "c-dropped", at: "", outcome: "dropped", by: "gc" },
  run("c-failed", "codex", "failed", 12, { total: 10 }),
  run("c-unmetered", "codex", "complete", 13),
  run("cl-failed", "claude", "failed", 5),
  { kind: "gate", id: "c-dropped", at: "", reasons: ["VERIFY failed"] },
  { kind: "gate", id: "other-id", at: "", reasons: ["out of scope"] },
];

describe("lane ledger summaries", () => {
  test("summarizes mixed runs per harness and sorts harnesses", () => {
    expect(summarize(mixedRows)).toEqual([
      { to: "claude", runs: 1, integrated: 0, failed: 1, meanDurationS: 5, gateRefusals: 0 },
      { to: "codex", runs: 4, integrated: 1, failed: 2, meanTokens: 54, meanDurationS: 12, gateRefusals: 1 },
    ]);
  });

  test("has no rows for an empty ledger", () => {
    expect(summarize([])).toEqual([]);
  });

  test("stats prints one line per harness and the empty message", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-ledger-stats-"));
    const home = join(root, "home");
    mkdirSync(home);
    try {
      for (const row of mixedRows) appendLedger(row, root);
      const env = { ...process.env, HOME: home, ORCH_HOME: home, ORCH_STATE: root };
      const populated = spawnSync(process.execPath, ["src/lane.ts", "stats"], { cwd: process.cwd(), encoding: "utf8", env });
      expect(populated.status).toBe(0);
      expect(populated.stdout).toBe([
        "claude  runs 1  integrated 0  failed 1  tokens ~-  duration 5s  gate refusals 0",
        "codex   runs 4  integrated 1  failed 2  tokens ~54  duration 12s  gate refusals 1",
        "",
      ].join("\n"));

      const emptyState = join(root, "empty");
      const empty = spawnSync(process.execPath, ["src/lane.ts", "stats"], {
        cwd: process.cwd(), encoding: "utf8", env: { ...env, ORCH_STATE: emptyState },
      });
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe("no lane recorded yet\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
