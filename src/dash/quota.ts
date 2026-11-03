// Provider rate-limit windows for the dash: Claude (statusLine snapshot),
// Codex (rollout rate_limits) and Grok (unified.jsonl billing log). Pure
// helpers plus the small atomic snapshot file the Claude statusLine writes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashQuota, DashQuotaWindow } from "./types.ts";

export const QUOTA_STALE_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_QUOTA_FILE = "quota-claude.json";
const HISTORY_MAX = 120;
const HISTORY_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const SAMPLE_MIN_GAP_MS = 5 * 60 * 1000;
const RESET_TOLERANCE_MS = 10 * 60 * 1000;
const MIN_RATE_SPAN_MS = 10 * 60 * 1000;

/** One observation of a window: percent used at `at`, window reset time if known. */
export interface QuotaSample {
  at: string;
  p: number;
  r?: string;
  w?: number;
}

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Epoch seconds, epoch milliseconds or an ISO string to ISO; null otherwise. */
export function toIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim() && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const n = finite(value);
  if (n == null || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes == null) return fallback;
  if (minutes === 300) return "Fenêtre 5 h";
  if (minutes >= 10_000 && minutes <= 10_200) return "Hebdo";
  if (minutes % 1440 === 0) return `Fenêtre ${minutes / 1440} j`;
  if (minutes % 60 === 0) return `Fenêtre ${minutes / 60} h`;
  return `Fenêtre ${minutes} min`;
}

function sameWindow(a: QuotaSample, b: QuotaSample): boolean {
  if (!a.r || !b.r) return true;
  return Math.abs(Date.parse(a.r) - Date.parse(b.r)) <= RESET_TOLERANCE_MS;
}

/** Appends a sample, keeping one per 5 min unless the percent moved. */
export function pushSample(history: QuotaSample[], sample: QuotaSample, now = new Date()): QuotaSample[] {
  const cutoff = now.getTime() - HISTORY_MAX_AGE_MS;
  const out = history.filter((s) => Number.isFinite(Date.parse(s.at)) && Date.parse(s.at) >= cutoff && Number.isFinite(s.p));
  const last = out.at(-1);
  if (last && Date.parse(sample.at) < Date.parse(last.at)) {
    out.push(sample);
    out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  } else if (last && last.p === sample.p && sameWindow(last, sample) && Date.parse(sample.at) - Date.parse(last.at) < SAMPLE_MIN_GAP_MS) {
    out[out.length - 1] = { ...last, r: sample.r ?? last.r, w: sample.w ?? last.w };
  } else {
    out.push(sample);
  }
  return out.slice(-HISTORY_MAX);
}

/**
 * Burn rate (%/h) over the recent run of samples in the current window, and
 * the projected time to 100 %. Null when fewer than two samples span 10 min.
 */
export function burnRate(samples: QuotaSample[], now = new Date(), lookbackMs = 3 * 60 * 60 * 1000): { ratePerHour: number | null; projectedFullAt: string | null } {
  const sorted = samples
    .filter((s) => Number.isFinite(Date.parse(s.at)) && Date.parse(s.at) <= now.getTime() + 60_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = sorted.at(-1);
  if (!last) return { ratePerHour: null, projectedFullAt: null };
  const from = Date.parse(last.at) - lookbackMs;
  let first = last;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const s = sorted[i]!;
    if (Date.parse(s.at) < from || !sameWindow(s, last) || s.p > first.p) break;
    first = s;
  }
  const span = Date.parse(last.at) - Date.parse(first.at);
  if (first === last || span < MIN_RATE_SPAN_MS) return { ratePerHour: null, projectedFullAt: null };
  const rate = Math.max(0, (last.p - first.p) / (span / 3_600_000));
  const ratePerHour = Math.round(rate * 100) / 100;
  if (rate <= 0.01 || last.p >= 100) return { ratePerHour, projectedFullAt: last.p >= 100 ? last.at : null };
  const full = Date.parse(last.at) + ((100 - last.p) / rate) * 3_600_000;
  return { ratePerHour, projectedFullAt: new Date(full).toISOString() };
}

/** Builds one dash window from its sample history (latest sample is current). */
export function quotaWindow(id: string, label: string, history: QuotaSample[], now = new Date(), lookbackMs?: number): DashQuotaWindow {
  const last = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  if (!last) return { id, label, usedPercent: null, unavailable: "aucun instantané" };
  const resetAt = last.r;
  if (resetAt && Date.parse(resetAt) <= now.getTime()) {
    return { id, label, usedPercent: 0, windowMinutes: last.w, resetAt: undefined, ratePerHour: null, projectedFullAt: null, note: "réinitialisée depuis le dernier instantané" };
  }
  const rate = burnRate(history, now, lookbackMs ?? (last.w != null && last.w > 600 ? 24 * 60 * 60 * 1000 : 3 * 60 * 60 * 1000));
  return {
    id,
    label,
    usedPercent: Math.min(100, Math.max(0, last.p)),
    windowMinutes: last.w,
    resetAt,
    ratePerHour: rate.ratePerHour,
    projectedFullAt: rate.projectedFullAt,
    fullBeforeReset: rate.projectedFullAt && resetAt ? Date.parse(rate.projectedFullAt) < Date.parse(resetAt) : undefined,
  };
}

export function isStale(capturedAt: string | undefined, now = new Date()): boolean {
  if (!capturedAt) return true;
  const t = Date.parse(capturedAt);
  return !Number.isFinite(t) || now.getTime() - t > QUOTA_STALE_MS;
}

// ---------------------------------------------------------------- Claude

export interface ClaudeRateLimits {
  five_hour?: { used_percentage: number; resets_at?: string };
  seven_day?: { used_percentage: number; resets_at?: string };
}

export interface ClaudeQuotaFile {
  version: 1;
  captured_at: string;
  source: "statusline";
  rate_limits: ClaudeRateLimits;
  history: { five_hour?: QuotaSample[]; seven_day?: QuotaSample[] };
}

/** Extracts `rate_limits` from Claude Code's statusLine stdin JSON. */
export function parseClaudeRateLimits(input: unknown): ClaudeRateLimits | null {
  const limits = record(record(input)?.rate_limits);
  if (!limits) return null;
  const out: ClaudeRateLimits = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = record(limits[key]);
    const p = finite(w?.used_percentage ?? w?.usedPercentage);
    if (!w || p == null) continue;
    out[key] = { used_percentage: p, resets_at: toIso(w.resets_at ?? w.resetsAt) ?? undefined };
  }
  return out.five_hour || out.seven_day ? out : null;
}

export function claudeQuotaPath(state: string): string {
  return join(state, CLAUDE_QUOTA_FILE);
}

export function readClaudeQuotaFile(state: string): ClaudeQuotaFile | null {
  const path = claudeQuotaPath(state);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeQuotaFile;
    return parsed && typeof parsed.captured_at === "string" && record(parsed.rate_limits) ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes the latest snapshot (and a short history) atomically: tmp file then rename. */
export function writeClaudeQuotaSnapshot(state: string, limits: ClaudeRateLimits, now = new Date()): ClaudeQuotaFile {
  const prior = readClaudeQuotaFile(state);
  const at = now.toISOString();
  const history: ClaudeQuotaFile["history"] = { ...(prior?.history ?? {}) };
  if (limits.five_hour) history.five_hour = pushSample(history.five_hour ?? [], { at, p: limits.five_hour.used_percentage, r: limits.five_hour.resets_at, w: 300 }, now);
  if (limits.seven_day) history.seven_day = pushSample(history.seven_day ?? [], { at, p: limits.seven_day.used_percentage, r: limits.seven_day.resets_at, w: 10_080 }, now);
  const data: ClaudeQuotaFile = { version: 1, captured_at: at, source: "statusline", rate_limits: limits, history };
  mkdirSync(state, { recursive: true });
  const path = claudeQuotaPath(state);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return data;
}

export function claudeQuota(state: string, now = new Date()): DashQuota {
  const source = "statusLine Claude Code → quota-claude.json";
  const file = readClaudeQuotaFile(state);
  if (!file) {
    return { source, stale: false, windows: [], unavailable: "aucun instantané : le chef garde la statusLine de l'opérateur ; `orch hook statusline --harness claude` l'écrit là où il sert de statusLine" };
  }
  const windows: DashQuotaWindow[] = [];
  const five = file.history?.five_hour?.length ? file.history.five_hour
    : file.rate_limits.five_hour ? [{ at: file.captured_at, p: file.rate_limits.five_hour.used_percentage, r: file.rate_limits.five_hour.resets_at, w: 300 }] : [];
  const week = file.history?.seven_day?.length ? file.history.seven_day
    : file.rate_limits.seven_day ? [{ at: file.captured_at, p: file.rate_limits.seven_day.used_percentage, r: file.rate_limits.seven_day.resets_at, w: 10_080 }] : [];
  windows.push(five.length ? quotaWindow("five_hour", "Fenêtre 5 h", five, now) : { id: "five_hour", label: "Fenêtre 5 h", usedPercent: null, unavailable: "absente du dernier instantané" });
  windows.push(week.length ? quotaWindow("seven_day", "Hebdo", week, now) : { id: "seven_day", label: "Hebdo", usedPercent: null, unavailable: "absente du dernier instantané" });
  return { source, capturedAt: file.captured_at, stale: isStale(file.captured_at, now), windows };
}

// ---------------------------------------------------------------- Codex

export interface CodexWindowRaw {
  usedPercent: number;
  windowMinutes?: number;
  resetAt?: string;
}

/** Reads one Codex rollout `rate_limits.primary|secondary` object. */
export function parseCodexWindow(raw: unknown, at: string): CodexWindowRaw | null {
  const w = record(raw);
  const p = finite(w?.used_percent);
  if (!w || p == null) return null;
  const minutes = finite(w.window_minutes);
  let resetAt = toIso(w.resets_at);
  const inSec = finite(w.resets_in_seconds);
  if (!resetAt && inSec != null && Number.isFinite(Date.parse(at))) resetAt = new Date(Date.parse(at) + inSec * 1000).toISOString();
  return { usedPercent: p, windowMinutes: minutes ?? undefined, resetAt: resetAt ?? undefined };
}

export function codexQuota(history: { primary?: QuotaSample[]; secondary?: QuotaSample[] }, now = new Date()): DashQuota {
  const source = "rollouts Codex (~/.codex/sessions, rate_limits)";
  const windows: DashQuotaWindow[] = [];
  let capturedAt: string | undefined;
  for (const id of ["primary", "secondary"] as const) {
    const samples = history[id] ?? [];
    const last = samples.at(-1);
    if (!last) continue;
    if (!capturedAt || Date.parse(last.at) > Date.parse(capturedAt)) capturedAt = last.at;
    windows.push(quotaWindow(id, windowLabel(last.w, id === "primary" ? "Quota primaire" : "Quota secondaire"), samples, now));
  }
  if (!windows.length) return { source, stale: false, windows, unavailable: "aucun rate_limits dans les rollouts récents" };
  // Codex reports the 5 h window as primary when it exists: list 5 h first.
  windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
  // Only when every window's length is known: an unlabeled one may be the 5 h.
  if (windows.every((w) => w.windowMinutes != null) && !windows.some((w) => w.windowMinutes === 300)) {
    windows.unshift({ id: "five_hour", label: "Fenêtre 5 h", usedPercent: null, unavailable: "non exposée par Codex pour ce plan (rate_limits sans fenêtre 5 h)" });
  }
  return { source, capturedAt, stale: isStale(capturedAt, now), windows };
}

// ---------------------------------------------------------------- Grok

/**
 * Grok CLI logs `billing: fetched credits config` in ~/.grok/logs/unified.jsonl
 * with the weekly credit usage percent and the period bounds.
 */
export function parseGrokBillingLine(line: string): QuotaSample | null {
  if (!line.includes("billing: fetched credits config")) return null;
  let row: Record<string, unknown> | null;
  try { row = record(JSON.parse(line)); } catch { return null; }
  if (!row || row.msg !== "billing: fetched credits config") return null;
  const config = record(record(row.ctx)?.config);
  const p = finite(config?.creditUsagePercent);
  const at = toIso(row.ts);
  if (!config || p == null || !at) return null;
  const period = record(config.currentPeriod);
  const start = toIso(period?.start ?? config.billingPeriodStart);
  const end = toIso(period?.end ?? config.billingPeriodEnd);
  const type = typeof period?.type === "string" ? period.type : "";
  const minutes = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 60_000)
    : type.includes("WEEKLY") ? 10_080 : undefined;
  return { at, p, r: end ?? undefined, w: minutes };
}

export function grokQuota(history: QuotaSample[], now = new Date()): DashQuota {
  const source = "logs Grok CLI (~/.grok/logs/unified.jsonl, billing credits)";
  const sorted = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = sorted.at(-1);
  const five: DashQuotaWindow = { id: "five_hour", label: "Fenêtre 5 h", usedPercent: null, unavailable: "Grok n'expose qu'un crédit par période (pas de fenêtre 5 h)" };
  if (!last) {
    return { source, stale: false, windows: [], unavailable: "aucune ligne « billing: fetched credits config » dans les logs Grok" };
  }
  return { source, capturedAt: last.at, stale: isStale(last.at, now), windows: [five, quotaWindow("credits", windowLabel(last.w, "Crédits"), sorted, now)] };
}

/** Merges per-file sample lists into one time-ordered history. */
export function mergeSamples(lists: (QuotaSample[] | undefined)[]): QuotaSample[] {
  const seen = new Set<string>();
  const out: QuotaSample[] = [];
  for (const list of lists) for (const s of list ?? []) {
    const key = `${s.at}|${s.p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-HISTORY_MAX);
}
