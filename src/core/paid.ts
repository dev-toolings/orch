// Paid-call guards. Every entry that can hit a provider (CLI, direct
// `bun src/checks/*.ts`, ingestTranscripts) must call this before work.
export function requireAllowPaid(
  args: string[],
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (args.includes("--dry-run") || args.includes("--live")) return;
  if (args.includes("--allow-paid") || env.ORCH_ALLOW_PAID === "1") return;
  throw new Error(`${label}: this entry point can incur model charges; pass --allow-paid or --dry-run`);
}

export const EMBED_USD_PER_MILLION = 0.02;

export type PaidProvider = "claude" | "codex" | "grok" | "other";

export interface UsagePrice {
  inputUsdPerM: number;
  outputUsdPerM: number;
  cacheReadUsdPerM: number;
  cacheWriteUsdPerM: number;
}

const CLAUDE_OPUS_CURRENT: UsagePrice = { inputUsdPerM: 5, outputUsdPerM: 25, cacheReadUsdPerM: 0.5, cacheWriteUsdPerM: 6.25 };
const CLAUDE_SONNET_CURRENT: UsagePrice = { inputUsdPerM: 3, outputUsdPerM: 15, cacheReadUsdPerM: 0.3, cacheWriteUsdPerM: 3.75 };
const CLAUDE_HAIKU_CURRENT: UsagePrice = { inputUsdPerM: 0.8, outputUsdPerM: 4, cacheReadUsdPerM: 0.08, cacheWriteUsdPerM: 1 };
// Legacy safety net for very old Opus families.
const CLAUDE_OPUS_LEGACY: UsagePrice = { inputUsdPerM: 15, outputUsdPerM: 75, cacheReadUsdPerM: 1.5, cacheWriteUsdPerM: 18.75 };
const GPT5_CODEX: UsagePrice = { inputUsdPerM: 1.25, outputUsdPerM: 10, cacheReadUsdPerM: 0.125, cacheWriteUsdPerM: 0.125 };
const GPT5_STD: UsagePrice = { inputUsdPerM: 2.5, outputUsdPerM: 10, cacheReadUsdPerM: 0.25, cacheWriteUsdPerM: 0.25 };

export function usagePriceForModel(model = "", provider: PaidProvider = "other"): UsagePrice {
  const id = model.toLowerCase();
  if (provider === "claude") {
    if (id.includes("opus")) {
      if (id.includes("opus-3")) return CLAUDE_OPUS_LEGACY;
      return CLAUDE_OPUS_CURRENT;
    }
    if (id.includes("haiku")) return CLAUDE_HAIKU_CURRENT;
    if (id.includes("sonnet")) return CLAUDE_SONNET_CURRENT;
    // Sane fallback for newer unknown Claude ids.
    return CLAUDE_SONNET_CURRENT;
  }
  if (provider === "codex") {
    if (id.includes("gpt-5") || id.includes("codex")) return GPT5_CODEX;
    return GPT5_STD;
  }
  if (provider === "grok") return GPT5_STD;
  return CLAUDE_SONNET_CURRENT;
}

export function estimateEmbedUsd(texts: string[], usdPerMillion = EMBED_USD_PER_MILLION): number {
  const tokens = texts.reduce((n, text) => n + Math.max(1, Math.ceil(text.length / 4)), 0);
  return tokens / 1_000_000 * usdPerMillion;
}

export function estimateUsageUsd(usage: {
  input?: number;
  output?: number;
  total?: number;
  cached?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
  provider?: PaidProvider;
  model?: string;
}): number {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) return usage.costUsd;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheCreation = usage.cacheCreation ?? 0;
  if (
    usage.input == null && usage.output == null && !cacheRead && !cacheCreation
    && typeof usage.total === "number"
  ) {
    return usage.total * 5 / 1_000_000;
  }
  const price = usagePriceForModel(usage.model, usage.provider);
  // Combined `cached` (legacy) is priced as cache read — the common leftover.
  const cached = (cacheRead || cacheCreation) ? 0 : (usage.cached ?? 0);
  return (
    input * price.inputUsdPerM
    + output * price.outputUsdPerM
    + cacheRead * price.cacheReadUsdPerM
    + cacheCreation * price.cacheWriteUsdPerM
    + cached * price.cacheReadUsdPerM
  ) / 1_000_000;
}

// Conservative pre-call token budgets. Used to reserve estimated spend before
// a paid harness starts, for tracking and reporting.
const LANE_TOKENS: Record<string, { input: number; output: number }> = {
  low: { input: 40_000, output: 6_000 },
  medium: { input: 80_000, output: 12_000 },
  high: { input: 120_000, output: 20_000 },
  xhigh: { input: 180_000, output: 32_000 },
  max: { input: 260_000, output: 48_000 },
};

export function estimateLaneUsd(effort?: string): number {
  return estimateUsageUsd(LANE_TOKENS[effort ?? "high"] ?? LANE_TOKENS.high);
}

export function estimateConsultUsd(risk: "normal" | "high" = "normal"): number {
  return estimateUsageUsd(risk === "high" ? { input: 60_000, output: 8_000 } : { input: 30_000, output: 4_000 });
}
