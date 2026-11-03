import { describe, expect, test } from "bun:test";
import { costsOf } from "../src/dash/costs.ts";

const tokens = { input: 2, output: 538, cacheRead: 44624, cacheWrite: 1243 };

describe("dashboard costs", () => {
  test("one total per Paris day, split by spender, legacy Kiba duplicates counted once", () => {
    const costs = costsOf([
      { at: "2026-11-02T08:51:16.857Z", usd: 0.5, source: "lead:claude:stop", session: "s1", model: "claude-opus-5-5", project: "lab", tokens },
      { at: "2026-11-02T08:51:16.862Z", usd: 0.5, source: "lead:claude:stop", session: "s1", model: "claude-opus-5-5", project: "lab", tokens },
      { at: "2026-11-02T09:06:00.000Z", usd: 1.5, source: "lane:20261102-a", model: "opus", project: "errortrack" },
      { at: "2026-11-02T10:00:00.000Z", usd: 0.25, source: "consult:REVIEW:1", model: "gpt-6-luna", project: "errortrack" },
      // 23:30 UTC on 1 Nov is already 2 Nov in Paris.
      { at: "2026-11-01T23:30:00.000Z", usd: 1, source: "lane:20261101-b", model: "sonnet", project: "orch" },
      { at: "2026-10-01T10:00:00.000Z", usd: 9, source: "lane:old", model: "sonnet", project: "orch" },
    ], new Date("2026-11-02T12:00:00Z"));
    expect(costs.days).toHaveLength(14);
    expect(costs.days.at(-1)).toMatchObject({ day: "2026-11-02", lead: 0.5, lane: 2.5, consult: 0.25, runs: 2 });
    expect(costs.today).toBe(3.25);
    expect(costs.week).toBe(3.25);
    expect(costs.perLaneRun).toBe(1.25);
    expect(costs.byProject[0]).toEqual({ name: "errortrack", usd: 1.75 });
  });
});
