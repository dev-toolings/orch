import { describe, expect, test } from "bun:test";
import { benchBrainYaml, diffUsage, hindsightCost, hindsightRetainOverride, renderReport, summarize, usageFromBuckets, type Turn } from "../src/checks/conso.ts";

const bucket = (time: string, total: number, input: number, output: number, cached = 0) => ({ time, total, tokens: { input, output, cached } });
const turn = (config: Turn["config"], index: number, cost: number, extra: Partial<Turn> = {}): Turn => ({
  config, session: "s", rep: 0, index, prompt: "p", exit: 0, duration_ms: 1000, num_turns: 1, cost_usd: cost,
  input_tokens: 10, cache_write: 100, cache_read: 1000, output_tokens: 50, ...extra,
});

describe("conso bench", () => {
  test("Hindsight usage is the stats delta, priced with cached tokens as part of input", () => {
    const before = usageFromBuckets([bucket("2026-10-28T00:00:00+00:00", 10, 100_000, 20_000)], [bucket("2026-10-28T00:00:00+00:00", 5, 1_000, 0)]);
    const after = usageFromBuckets(
      [bucket("2026-10-28T00:00:00+00:00", 10, 100_000, 20_000), bucket("2026-10-29T00:00:00+00:00", 4, 1_000_000, 200_000, 400_000)],
      [bucket("2026-10-28T00:00:00+00:00", 5, 1_000, 0), bucket("2026-10-29T00:00:00+00:00", 8, 500_000, 0)],
    );
    const d = diffUsage(after, before);
    expect(d).toEqual({ llm_calls: 4, llm_input: 1_000_000, llm_cached: 400_000, llm_output: 200_000, embed_calls: 8, embed_tokens: 500_000 });
    // 600k fresh x 0.10 + 400k cached x 0.01 + 200k out x 0.50 + 500k embed x 0.02, per million
    expect(hindsightCost(d)).toBeCloseTo(0.06 + 0.004 + 0.1 + 0.01, 6);
  });

  test("the report labels partial costs and leaves failed prompts out of successful totals", () => {
    const turns = [turn("A", 0, 0.1), turn("A", 1, 0.2), turn("C", 0, 0.1), turn("C", 1, 0.3), turn("C", 2, 9, { error: "boom" })];
    const hindsight = { C: { llm_calls: 2, llm_input: 1_000_000, llm_cached: 0, llm_output: 0, embed_calls: 0, embed_tokens: 0 } };
    const rows = summarize(turns, hindsight);
    expect(rows.map((r) => [r.config, r.prompts, Number(r.total_usd.toFixed(3))])).toEqual([["A", 2, 0.3], ["C", 2, 0.5]]);
    const report = renderReport(turns, hindsight, {});
    expect(report).toContain("known subtotal$");
    expect(report).toContain("n/a");
    expect(report).not.toContain("+2011 %");
    expect(report).toContain("9.50");
    expect(report).toContain("0.400");
    expect(report).toContain("1 prompt(s) exclus (C/s#3)");
  });

  test("a stats counter moving backwards marks its usage window incomplete", () => {
    const before = { llm_calls: 3, llm_input: 100, llm_cached: 0, llm_output: 0, embed_calls: 0, embed_tokens: 0 };
    const after = { ...before, llm_calls: 2 };
    expect(() => diffUsage(after, before)).toThrow("cost window is incomplete");
  });

  test("Hindsight overrides cannot change the bank or endpoint", () => {
    const catalog = "mem: brain\nhindsight:\n  url: http://127.0.0.1:8899\n  bank: kiba\n  retain: true\n";
    const result = benchBrainYaml(catalog, "bench-run-C", "retain=false,recall_max_tokens=600");
    expect(result).toContain("bank: bench-run-C");
    expect(result).toContain("recall_max_tokens: 600");
    expect(() => benchBrainYaml(catalog, "bench-run-C", "bank=kiba")).toThrow("runner-owned");
    expect(() => benchBrainYaml(catalog, "bench-run-C", "url=http://example.test")).toThrow("runner-owned");
    expect(hindsightRetainOverride("recall_budget=low", false)).toBe("recall_budget=low,retain=false");
    expect(() => hindsightRetainOverride("retain=true", false)).toThrow("retain must be false");
  });
});
