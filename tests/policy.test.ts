import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSpendAllowed, heldToday, loadPolicy, maybeSpendAlert, pauseReason, recordAgainstHold, recordSpend, releaseSpend, reserveSpend, resolveLeadPolicy, resolveLogsPolicy, spentAndHeld, spentToday } from "../src/core/policy.ts";
import { runRoutine, type Routine } from "../src/routines/routines.ts";

const savedPause = process.env.ORCH_PAUSE;
afterEach(() => {
  if (savedPause === undefined) delete process.env.ORCH_PAUSE;
  else process.env.ORCH_PAUSE = savedPause;
});

describe("control plane", () => {
  test("ORCH_PAUSE and a PAUSE file both trip the kill switch", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-pause-"));
    try {
      expect(pauseReason({ ORCH_PAUSE: "1" }, state)).toBe("ORCH_PAUSE");
      expect(pauseReason({ ORCH_PAUSE: "0" }, state)).toBeNull();
      writeFileSync(join(state, "PAUSE"), "");
      expect(pauseReason({}, state)).toContain("PAUSE file");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("daily spend settings are informational and never refuse actions", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-spend-"));
    try {
      const policy = { spend: { daily_usd: 0.01, embed_usd_per_million: 0.02 }, paid_routines: ["brain-embed"] };
      assertSpendAllowed({ state, policy, label: "lane run" });
      recordSpend({ at: "2026-10-31T00:00:00Z", usd: 0.02, source: "lane:x" }, state);
      expect(spentToday(state, new Date("2026-10-31T12:00:00Z"))).toBeCloseTo(0.02);
      assertSpendAllowed({ state, policy, now: new Date("2026-10-31T12:00:00Z"), label: "lane run" });
      assertSpendAllowed({ state, policy, now: new Date("2026-11-01T00:00:00Z"), label: "lane run" });
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("the shipped catalog keeps daily_usd optional and lists paid routines", () => {
    const saved = process.env.ORCH_POLICY;
    delete process.env.ORCH_POLICY;
    try {
      const policy = loadPolicy();
      expect(policy.spend.daily_usd).toBeNull();
      expect(policy.spend.plan_tokens).toBeNull();
      expect(resolveLogsPolicy(policy).retention_days).toBe(7);
      expect(resolveLogsPolicy(policy).prune_at).toBe("12:00");
      expect(resolveLeadPolicy(policy).autocompact_tokens).toBe(900000);
      expect(policy.paid_routines).toContain("hindsight-seed");
      expect(policy.paid_routines).toContain("rules-bench");
      expect(policy.paid_routines).not.toContain("hindsight-consolidate");
    } finally {
      if (saved === undefined) delete process.env.ORCH_POLICY;
      else process.env.ORCH_POLICY = saved;
    }
  });

  test("a missing daily_usd defaults to null; an explicit null stays null", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-daily-"));
    try {
      const path = join(dir, "policy.yaml");
      writeFileSync(path, "spend:\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
      expect(loadPolicy(path).spend.daily_usd).toBeNull();
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
      expect(loadPolicy(path).spend.daily_usd).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs policy validates retention and prune_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-logs-policy-"));
    try {
      const path = join(dir, "policy.yaml");
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlogs:\n  retention_days: 14\n  prune_at: \"09:30\"\npaid_routines: []\n");
      const loaded = loadPolicy(path);
      expect(resolveLogsPolicy(loaded).retention_days).toBe(14);
      expect(resolveLogsPolicy(loaded).prune_at).toBe("09:30");
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlogs:\n  retention_days: 0\n  prune_at: \"09:30\"\npaid_routines: []\n");
      expect(() => loadPolicy(path)).toThrow(/retention_days/);
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlogs:\n  retention_days: 7\n  prune_at: \"9:30\"\npaid_routines: []\n");
      expect(() => loadPolicy(path)).toThrow(/prune_at/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lead policy validates autocompact tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-lead-policy-"));
    try {
      const path = join(dir, "policy.yaml");
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlead:\n  autocompact_tokens: 400000\npaid_routines: []\n");
      expect(resolveLeadPolicy(loadPolicy(path)).autocompact_tokens).toBe(400000);
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlead:\n  autocompact_tokens: null\npaid_routines: []\n");
      expect(resolveLeadPolicy(loadPolicy(path)).autocompact_tokens).toBeNull();
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlead:\n  autocompact_tokens: 90000\npaid_routines: []\n");
      expect(() => loadPolicy(path)).toThrow(/autocompact_tokens/);
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\nlead:\n  autocompact_tokens: 1000001\npaid_routines: []\n");
      expect(() => loadPolicy(path)).toThrow(/autocompact_tokens/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spend alerts are disabled", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-spend-alert-"));
    try {
      const policy = { spend: { daily_usd: 5, embed_usd_per_million: 0.02 }, paid_routines: [] };
      const now = new Date("2026-11-01T12:00:00Z");
      const notices: string[] = [];
      const notify = (n: { text: string }) => { notices.push(n.text); };
      expect(maybeSpendAlert({ state, policy, now, used: 3.9, notify }).alerted).toBe(false);
      expect(maybeSpendAlert({ state, policy, now, used: 4.1, notify }).alerted).toBe(false);
      expect(notices).toHaveLength(0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("spend.plan_tokens must be null or a non-negative number", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-plan-"));
    try {
      const path = join(dir, "policy.yaml");
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\n  plan_tokens: -1\npaid_routines: []\n");
      expect(() => loadPolicy(path)).toThrow(/plan_tokens/);
      writeFileSync(path, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\n  plan_tokens: 200000\npaid_routines: []\n");
      expect(loadPolicy(path).spend.plan_tokens).toBe(200000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pre-call estimate is informational and never refuses", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-spend-est-"));
    try {
      const policy = { spend: { daily_usd: 0.01, embed_usd_per_million: 0.02 }, paid_routines: [] };
      assertSpendAllowed({ state, policy, extraUsd: 0.02, label: "lane report" });
      expect(spentToday(state)).toBe(0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a reservation is tracked and released after the call", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-spend-hold-"));
    try {
      const policy = { spend: { daily_usd: 0.05, embed_usd_per_million: 0.02 }, paid_routines: [] };
      const hold = reserveSpend({ usd: 0.04, source: "lane:x", label: "lane report", state, policy });
      expect(heldToday(state)).toBeCloseTo(0.04);
      expect(spentAndHeld(state)).toBeCloseTo(0.04);
      const second = reserveSpend({ usd: 0.02, source: "lane:y", label: "lane report", state, policy });
      expect(second.usd).toBeCloseTo(0.02);
      recordAgainstHold(hold.id, { at: new Date().toISOString(), usd: 0.01, source: "lane:x" }, state);
      expect(spentToday(state)).toBeCloseTo(0.01);
      expect(heldToday(state)).toBeCloseTo(0.05);
      releaseSpend(second.id, state);
      releaseSpend(hold.id, state);
      expect(heldToday(state)).toBe(0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("unsupervised paid work is allowed without a daily cap", () => {
    const policy = { spend: { daily_usd: null, embed_usd_per_million: 0.02 }, paid_routines: ["brain-embed"] };
    assertSpendAllowed({ policy, label: "lane run" });
    assertSpendAllowed({ policy, label: "mission", watched: true });
    assertSpendAllowed({ policy, label: "routine brain-embed", watched: true });
  });

  test("a PAUSE file skips a routine without running its command", async () => {
    const state = mkdtempSync(join(tmpdir(), "orch-routine-pause-"));
    try {
      writeFileSync(join(state, "PAUSE"), "");
      const ran: string[] = [];
      const routine: Routine = { id: "r", description: "", every: "1d", commands: [["true"]], timeout_minutes: 1, enabled: true };
      const entry = await runRoutine(routine, {
        state,
        exec: async (argv) => { ran.push(argv.join(" ")); return { exit: 0, timedOut: false, output: "" }; },
      });
      expect(entry.ok).toBe(true);
      expect(entry.skipped).toMatch(/paused/);
      expect(ran).toEqual([]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
