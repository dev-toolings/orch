import { describe, expect, test } from "bun:test";
import { estimateConsultUsd, estimateEmbedUsd, estimateLaneUsd, estimateUsageUsd, requireAllowPaid } from "../src/core/paid.ts";
import { parseWorkerOutput, sessionCostDelta } from "../src/harness/harness.ts";

describe("paid-call guards", () => {
  test("requireAllowPaid accepts --allow-paid, --dry-run, --live or ORCH_ALLOW_PAID", () => {
    expect(() => requireAllowPaid([], "memoire")).toThrow(/--allow-paid or --dry-run/);
    expect(() => requireAllowPaid(["--allow-paid"], "memoire")).not.toThrow();
    expect(() => requireAllowPaid(["--dry-run"], "conso")).not.toThrow();
    expect(() => requireAllowPaid(["--live"], "conso")).not.toThrow();
    expect(() => requireAllowPaid([], "memoire", { ORCH_ALLOW_PAID: "1" })).not.toThrow();
  });

  test("estimateEmbedUsd is a positive function of text length", () => {
    expect(estimateEmbedUsd(["a"])).toBeGreaterThan(0);
    expect(estimateEmbedUsd(["abcd".repeat(1000)])).toBeGreaterThan(estimateEmbedUsd(["a"]));
  });

  test("pre-call lane and consult estimates grow with effort and risk", () => {
    expect(estimateLaneUsd("low")).toBeGreaterThan(0);
    expect(estimateLaneUsd("max")).toBeGreaterThan(estimateLaneUsd("low"));
    expect(estimateConsultUsd("high")).toBeGreaterThan(estimateConsultUsd("normal"));
  });

  test("CLI total_cost_usd wins over token estimates", () => {
    expect(estimateUsageUsd({ input: 100, output: 200, costUsd: 0.0235 })).toBeCloseTo(0.0235);
    const parsed = parseWorkerOutput("claude", JSON.stringify({
      result: "ok",
      total_cost_usd: 0.0235,
      model: "claude-haiku-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 2_000,
      },
    }), "");
    expect(parsed.model).toBe("claude-haiku-4-5");
    expect(parsed.usage.costUsd).toBeCloseTo(0.0235);
    expect(parsed.usage.cacheRead).toBe(50_000);
    expect(parsed.usage.cacheCreation).toBe(2_000);
    expect(estimateUsageUsd(parsed.usage)).toBeCloseTo(0.0235);
  });

  test("sessionCostDelta subtracts the previously recorded session cost", () => {
    const previous = { input: 100, output: 20, costUsd: 0.02 };
    const parsed = { input: 10, output: 5, costUsd: 0.025 };
    const delta = sessionCostDelta(previous, parsed);
    expect(delta.costUsd).toBeCloseTo(0.005);
    expect(delta.input).toBe(10);
    expect(delta.output).toBe(5);
    expect(sessionCostDelta({}, { costUsd: 0.01 }).costUsd).toBeCloseTo(0.01);
    expect(sessionCostDelta({ costUsd: 0.02 }, { input: 3 }).costUsd).toBeUndefined();
    expect(sessionCostDelta({ costUsd: 0.03 }, { costUsd: 0.02 }).costUsd).toBe(0);
  });

  test("cache read and creation tokens are priced when the CLI omits total_cost_usd", () => {
    // 100 input × $3 + 200 output × $15 + 50k read × $0.30 + 2k write × $3.75
    // = 0.0003 + 0.003 + 0.015 + 0.0075 = 0.0258
    const priced = estimateUsageUsd({
      input: 100, output: 200, cacheRead: 50_000, cacheCreation: 2_000,
    });
    expect(priced).toBeCloseTo(0.0258);
    expect(priced).toBeGreaterThan(estimateUsageUsd({ input: 100, output: 200 }));
  });

  test("Codex/GPT-5 model pricing is not Sonnet pricing", () => {
    const codex = estimateUsageUsd({ input: 1_000_000, output: 0, provider: "codex", model: "gpt-5-codex" });
    const sonnet = estimateUsageUsd({ input: 1_000_000, output: 0, provider: "claude", model: "claude-sonnet-4-5" });
    expect(codex).toBeCloseTo(1.25);
    expect(sonnet).toBeCloseTo(3);
    expect(codex).toBeLessThan(sonnet);
  });

  test("current Opus family uses current pricing and fallback is not legacy-Opus priced", () => {
    const opus = estimateUsageUsd({
      provider: "claude",
      model: "claude-opus-4-6",
      input: 2_266,
      output: 598_531,
      cacheRead: 202_296_473,
      cacheCreation: 2_714_098,
    });
    expect(opus).toBeCloseTo(133.09, 2);
    const unknownClaude = estimateUsageUsd({ provider: "claude", model: "claude-next-6", input: 1_000_000, output: 0 });
    expect(unknownClaude).toBeCloseTo(3);
  });
});
