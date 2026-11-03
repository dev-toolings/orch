import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { loadPolicy, type ControlPolicy } from "../core/policy.ts";
import type { Profile } from "../core/profile.ts";
import { claudeProjectsDir, tokensOnDay, tokenUsage, utcDay } from "../ops/usage.ts";

export interface MachineFigures {
  cores: number;
  memAvailableGib: number;
}

export interface QuotaFigures {
  remainingTokens: number | null;
}

export type BudgetLimit = "cpu" | "ram" | "ceiling" | "quota";

export interface LaneBudget {
  budget: number;
  cpu: number;
  ram: number;
  ceiling: number;
  quota: number | null;
  limitedBy: BudgetLimit;
}

// Conservative tokens for one parallel lane (medium effort). Used only to
// turn a remaining plan quota into a slot count; USD spend is separate.
export const TOKENS_PER_LANE = 80_000;

export function readMachine(): MachineFigures {
  let memAvailableGib: number;
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const availableKb = Number(text.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
    memAvailableGib = Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : freemem() / 1024 ** 3;
  } catch {
    memAvailableGib = freemem() / 1024 ** 3;
  }
  return { cores: availableParallelism(), memAvailableGib };
}

export function quotaFromPlan(planTokens: number | null | undefined, used: number): QuotaFigures {
  if (planTokens == null) return { remainingTokens: null };
  return { remainingTokens: Math.max(0, planTokens - used) };
}

// Reads today's Claude transcripts only when spend.plan_tokens is set.
export function liveQuota(opts: {
  policy?: ControlPolicy;
  used?: number;
  claudeProjects?: string;
  now?: Date;
} = {}): QuotaFigures {
  const policy = opts.policy ?? loadPolicy();
  const cap = policy.spend.plan_tokens ?? null;
  if (cap == null) return { remainingTokens: null };
  const now = opts.now ?? new Date();
  const used = opts.used ?? tokensOnDay(
    tokenUsage(opts.claudeProjects ?? claudeProjectsDir(), new Date(`${utcDay(now)}T00:00:00.000Z`)),
    utcDay(now),
  );
  return quotaFromPlan(cap, used);
}

export function laneBudget(
  limits: Profile["limits"],
  m: MachineFigures = readMachine(),
  q: QuotaFigures = { remainingTokens: null },
): LaneBudget {
  const cpu = Math.floor(m.cores / 2);
  const ram = Math.floor((m.memAvailableGib - limits.reserve_gib - limits.verify_concurrent * limits.verify_gib) / limits.worker_gib);
  const ceiling = limits.max_concurrent_ceiling;
  const machineLowest = Math.min(cpu, ram, ceiling);
  const machineBudget = Math.max(1, machineLowest);
  const machineBy: BudgetLimit = cpu === machineLowest ? "cpu" : ram === machineLowest ? "ram" : "ceiling";
  if (q.remainingTokens == null) {
    return { budget: machineBudget, cpu, ram, ceiling, quota: null, limitedBy: machineBy };
  }
  const quota = Math.max(0, Math.floor(q.remainingTokens / TOKENS_PER_LANE));
  const budget = Math.min(machineBudget, quota);
  return {
    budget,
    cpu,
    ram,
    ceiling,
    quota,
    limitedBy: quota <= machineBudget ? "quota" : machineBy,
  };
}

export function liveLaneBudget(
  limits: Profile["limits"],
  m: MachineFigures = readMachine(),
  q: QuotaFigures = liveQuota(),
): LaneBudget {
  return laneBudget(limits, m, q);
}
