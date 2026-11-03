import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRule, betterScore, harvestLedger, readRules, scoreOf } from "../src/rules/rules.ts";
import { assertBenchAllowed, benchRules, dryRunner, REFERENCE_MISSIONS } from "../src/rules/bench.ts";
import { ruleCli } from "../src/rules/cli.ts";
import type { LedgerRow } from "../src/lanes/ledger.ts";

let root: string;
let state: string;
let savedState: string | undefined;
let savedPolicy: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-rules-"));
  state = join(root, "state");
  mkdirSync(state, { recursive: true });
  savedState = process.env.ORCH_STATE;
  savedPolicy = process.env.ORCH_POLICY;
  process.env.ORCH_STATE = state;
  const policy = join(root, "policy.yaml");
  writeFileSync(policy, "spend:\n  daily_usd: 5\n  embed_usd_per_million: 0.02\npaid_routines: [rules-bench]\n");
  process.env.ORCH_POLICY = policy;
}, 20_000);

afterAll(() => {
  if (savedState === undefined) delete process.env.ORCH_STATE;
  else process.env.ORCH_STATE = savedState;
  if (savedPolicy === undefined) delete process.env.ORCH_POLICY;
  else process.env.ORCH_POLICY = savedPolicy;
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
}, 20_000);

describe("candidate rules", () => {
  test("harvests gate refusals and fix-first reviews, dedupes the same text", () => {
    const rows: LedgerRow[] = [
      { kind: "gate", id: "l1", at: "t", reasons: ["VERIFY did not pass"] },
      { kind: "review", id: "l1", at: "t", to: "codex", model: "m", effort: "low", verdict: "fix-first" },
      { kind: "review", id: "l2", at: "t", to: "codex", model: "m", effort: "low", verdict: "ship" },
    ];
    const first = harvestLedger(rows, state);
    expect(first.map((r) => r.source).sort()).toEqual(["gate", "review"]);
    expect(harvestLedger(rows, state).map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    expect(readRules(state).filter((r) => r.status === "candidate").length).toBe(2);
  });

  test("a correction is stored with provenance", () => {
    const rule = addRule({ source: "correction", text: "always name FILES", provenance: "operator" }, state);
    expect(rule.source).toBe("correction");
    expect(readRules(state).some((r) => r.id === rule.id)).toBe(true);
  });
});

describe("rules bench", () => {
  test("reference missions are a bug, a feature and a contract pair", () => {
    expect(REFERENCE_MISSIONS.map((m) => m.id)).toEqual(["bug", "feature", "contract"]);
    expect(REFERENCE_MISSIONS.map((m) => m.kind)).toEqual(["bug", "feature", "contract"]);
  });

  test("betterScore prefers pass rate, then fewer escalations, then lower cost", () => {
    const base = { passRate: 0.6, costUsd: 3, escalations: 1, n: 3 };
    expect(betterScore({ passRate: 1, costUsd: 9, escalations: 2, n: 3 }, base)).toBe(true);
    expect(betterScore({ passRate: 0.6, costUsd: 3, escalations: 0, n: 3 }, base)).toBe(true);
    expect(betterScore({ passRate: 0.6, costUsd: 2, escalations: 1, n: 3 }, base)).toBe(true);
    expect(betterScore({ passRate: 0.6, costUsd: 3, escalations: 1, n: 3 }, base)).toBe(false);
  });

  test("a helpful candidate is kept; a harmful one is pruned", () => {
    const help = addRule({ source: "correction", text: "for a bug, reproduce first", provenance: "t" }, state);
    const harm = addRule({ source: "correction", text: "never run VERIFY", provenance: "t" }, state);
    const out = benchRules({
      rules: readRules(state).filter((r) => r.id === help.id || r.id === harm.id),
      runner: dryRunner,
      state,
      env: process.env,
    });
    expect(out.refused).toBeUndefined();
    expect(out.kept).toContain(help.id);
    expect(out.pruned).toContain(harm.id);
    expect(out.score.n).toBe(3);
    expect(scoreOf(out.results).passRate).toBeGreaterThan(0);
  });

  test("refuses when paused only", () => {
    const env = { ...process.env, ORCH_PAUSE: "1" };
    expect(assertBenchAllowed(env, state)).toContain("paused");
    const policy = join(root, "uncapped.yaml");
    writeFileSync(policy, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    const prev = process.env.ORCH_POLICY;
    process.env.ORCH_POLICY = policy;
    try {
      expect(assertBenchAllowed({ ...process.env, ORCH_PAUSE: "0" }, state)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ORCH_POLICY;
      else process.env.ORCH_POLICY = prev;
    }
  });

  test("orch rule bench refuses only when paused", () => {
    const orch = join(import.meta.dir, "../src/orch.ts");
    const paused = spawnSync(process.execPath, [orch, "rule", "bench"], {
      encoding: "utf8",
      env: { ...process.env, ORCH_PAUSE: "1", ORCH_STATE: state, ORCH_POLICY: process.env.ORCH_POLICY },
    });
    expect(paused.status).not.toBe(0);
    expect(paused.stdout).toContain("STATUS: refused");
    expect(paused.stdout).toContain("paused");

    const policy = join(root, "uncapped-cli.yaml");
    writeFileSync(policy, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    const uncapped = spawnSync(process.execPath, [orch, "rule", "bench"], {
      encoding: "utf8",
      env: { ...process.env, ORCH_PAUSE: "0", ORCH_STATE: state, ORCH_POLICY: policy },
    });
    expect(uncapped.status).toBe(0);
    expect(uncapped.stdout).toContain("RULE BENCH");
    expect(uncapped.stdout).not.toContain("STATUS: refused");

    const prev = process.exitCode;
    try {
      process.exitCode = 0;
      const text = ruleCli(["bench"], { ...process.env, ORCH_PAUSE: "1" });
      expect(text).toContain("STATUS: refused");
      expect(process.exitCode).not.toBe(0);
    } finally {
      process.exitCode = prev ?? 0;
    }
  });
});

describe("orch rule CLI", () => {
  test("add / list / bench", () => {
    expect(ruleCli(["add", "--from", "correction", "--text", "for a feature, write ACCEPT first"], process.env))
      .toContain("RULE ADD");
    expect(ruleCli(["list"], process.env)).toContain("candidate");
    const bench = ruleCli(["bench"], process.env);
    expect(bench).toContain("RULE BENCH");
    expect(bench).toMatch(/PASS:/);
    expect(bench).toContain("bug");
  });
});
