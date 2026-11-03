import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/core/profile.ts";
import { laneBudget, liveQuota, quotaFromPlan, TOKENS_PER_LANE, type MachineFigures } from "../src/lanes/budget.ts";

const max20 = loadProfile("max20").limits;
const lean = loadProfile("lean").limits;

describe("lane budget", () => {
  test("16 cores and 23 GiB available are limited by CPU and the ceiling", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 23 };
    expect(laneBudget(max20, machine)).toEqual({ budget: 8, cpu: 8, ram: 32, ceiling: 8, quota: null, limitedBy: "cpu" });
  });

  test("16 cores and 6 GiB available are limited by RAM", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 6 };
    expect(laneBudget(max20, machine)).toEqual({ budget: 1, cpu: 8, ram: -2, ceiling: 8, quota: null, limitedBy: "ram" });
  });

  test("a tiny machine keeps the budget at one", () => {
    const machine: MachineFigures = { cores: 1, memAvailableGib: 1 };
    expect(laneBudget(max20, machine)).toMatchObject({ budget: 1, quota: null });
  });

  test("lean caps a roomy machine at two", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 64 };
    expect(laneBudget(lean, machine)).toEqual({ budget: 2, cpu: 8, ram: 117, ceiling: 2, quota: null, limitedBy: "ceiling" });
  });

  test("remaining plan tokens cap concurrency below the machine budget", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 23 };
    expect(laneBudget(max20, machine, { remainingTokens: TOKENS_PER_LANE })).toEqual({
      budget: 1, cpu: 8, ram: 32, ceiling: 8, quota: 1, limitedBy: "quota",
    });
    expect(laneBudget(max20, machine, { remainingTokens: 0 })).toEqual({
      budget: 0, cpu: 8, ram: 32, ceiling: 8, quota: 0, limitedBy: "quota",
    });
    expect(laneBudget(max20, machine, { remainingTokens: TOKENS_PER_LANE * 10 })).toMatchObject({
      budget: 8, quota: 10, limitedBy: "cpu",
    });
  });

  test("a missing plan quota is unlimited and does not scan transcripts", () => {
    expect(quotaFromPlan(null, 99_999)).toEqual({ remainingTokens: null });
    expect(liveQuota({ policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: null }, paid_routines: [] } }))
      .toEqual({ remainingTokens: null });
  });

  test("liveQuota subtracts today's tokens from the plan cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-quota-"));
    try {
      mkdirSync(join(dir, "p"), { recursive: true });
      writeFileSync(join(dir, "p", "a.jsonl"), `${JSON.stringify({
        timestamp: "2026-10-31T08:00:00Z",
        message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 10_000, output_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      })}\n`);
      expect(liveQuota({
        policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: 100_000 }, paid_routines: [] },
        used: 20_000,
      })).toEqual({ remainingTokens: 80_000 });
      expect(liveQuota({
        policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: 100_000 }, paid_routines: [] },
        claudeProjects: dir,
        now: new Date("2026-10-31T12:00:00Z"),
      })).toEqual({ remainingTokens: 85_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
