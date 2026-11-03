// Control plane: kill switch and spend tracking. Checked before lanes,
// paid routines and memory retain/recall that would spend.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { tryLock } from "../lanes/lock.ts";
import { ROOT } from "./profile.ts";
import { stateDir } from "./paths.ts";

export interface SpendPolicy {
  daily_usd: number | null;
  embed_usd_per_million: number;
  // Daily plan-token quota (Claude/Codex usage). Null is unlimited. Caps
  // concurrency in laneBudget; it is not a second USD cap and does not
  // fail over to another account.
  plan_tokens?: number | null;
}

export interface LogsPolicy {
  retention_days: number;
  prune_at: string;
}


export interface LeadPolicy {
  autocompact_tokens: number | null;
  // Host override of the Claude lead model and effort (profile lead.claude otherwise).
  claude?: { model?: string; effort?: string };
}

export const LEAD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ControlPolicy {
  spend: SpendPolicy;
  logs?: LogsPolicy;
  lead?: LeadPolicy;
  paid_routines: string[];
}

export interface SpendEntry {
  at: string;
  usd: number;
  source: string;
  provider?: string;
  model?: string;
  session?: string;
  project?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SpendHold {
  id: string;
  at: string;
  usd: number;
  source: string;
  pid: number;
}

export const DAILY_USD_DEPRECATED_HINT =
  "policy: spend.daily_usd is deprecated and ignored (tracking is informational only)";

const HOLD_GRACE_MS = 5 * 60_000;

export const DEFAULT_DAILY_USD = 50;

const DEFAULT: ControlPolicy = {
  spend: { daily_usd: null, embed_usd_per_million: 0.02, plan_tokens: null },
  logs: { retention_days: 7, prune_at: "12:00" },
  lead: { autocompact_tokens: 400000 },
  paid_routines: ["brain-embed", "hindsight-seed", "improve", "reflect", "transcript-ingest", "rules-bench"],
};

export const DEFAULT_LOGS_POLICY: LogsPolicy = { retention_days: 7, prune_at: "12:00" };
export const DEFAULT_LEAD_POLICY: LeadPolicy = { autocompact_tokens: 400000 };

function isHm(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function loadPolicy(path = process.env.ORCH_POLICY ?? join(ROOT, "catalog", "policy.yaml")): ControlPolicy {
  if (!existsSync(path)) return structuredClone(DEFAULT);
  const doc = parse(readFileSync(path, "utf8")) as { spend?: Partial<SpendPolicy>; logs?: Partial<LogsPolicy>; lead?: Partial<LeadPolicy>; paid_routines?: string[] } | null;
  const spend: Partial<SpendPolicy> = doc?.spend ?? {};
  const logs: Partial<LogsPolicy> = doc?.logs ?? {};
  const lead: Partial<LeadPolicy> & { conductor?: unknown } = doc?.lead ?? {};
  const daily = spend.daily_usd;
  if (daily !== undefined && daily !== null && (!Number.isFinite(daily) || daily < 0)) {
    throw new Error(`policy: spend.daily_usd must be null or a non-negative number`);
  }
  const embed = spend.embed_usd_per_million ?? DEFAULT.spend.embed_usd_per_million;
  if (!Number.isFinite(embed) || embed < 0) throw new Error("policy: spend.embed_usd_per_million must be non-negative");
  const plan = spend.plan_tokens;
  if (plan !== undefined && plan !== null && (!Number.isFinite(plan) || plan < 0)) {
    throw new Error(`policy: spend.plan_tokens must be null or a non-negative number`);
  }
  const paid = doc?.paid_routines ?? DEFAULT.paid_routines;
  if (!Array.isArray(paid) || paid.some((id) => typeof id !== "string" || !id)) {
    throw new Error("policy: paid_routines must be a list of routine ids");
  }
  const retentionDays = logs.retention_days ?? DEFAULT_LOGS_POLICY.retention_days;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("policy: logs.retention_days must be an integer between 1 and 3650");
  }
  const pruneAt = logs.prune_at ?? DEFAULT_LOGS_POLICY.prune_at;
  if (typeof pruneAt !== "string" || !isHm(pruneAt)) {
    throw new Error("policy: logs.prune_at must match HH:MM (24h)");
  }
  const autocompact = lead.autocompact_tokens === undefined
    ? DEFAULT_LEAD_POLICY.autocompact_tokens
    : lead.autocompact_tokens;
  if (autocompact !== null && (!Number.isInteger(autocompact) || autocompact < 100000 || autocompact > 1000000)) {
    throw new Error("policy: lead.autocompact_tokens must be null or an integer between 100000 and 1000000");
  }
  // Kiba is the only lead: a leftover `conductor: kiba` is harmless, any other
  // value asked for a lead that no longer exists.
  if (lead.conductor !== undefined && lead.conductor !== "kiba") throw new Error("policy: lead.conductor is gone, Kiba is the only lead (drop the key)");
  const claude = lead.claude ?? undefined;
  if (claude !== undefined) {
    if (!claude || typeof claude !== "object" || Array.isArray(claude)) throw new Error("policy: lead.claude must be a map { model, effort }");
    for (const k of Object.keys(claude)) if (!["model", "effort"].includes(k)) throw new Error(`policy: lead.claude.${k} is unknown (model, effort)`);
    if (claude.model !== undefined && (typeof claude.model !== "string" || !/^[A-Za-z0-9._\[\]-]{1,80}$/.test(claude.model))) throw new Error("policy: lead.claude.model must be a model name");
    if (claude.effort !== undefined && !LEAD_EFFORTS.includes(claude.effort)) throw new Error(`policy: lead.claude.effort must be one of ${LEAD_EFFORTS.join(", ")}`);
  }
  // lead.channels pushed results from the retired kiba MCP server: a leftover key is ignored.
  return {
    spend: {
      daily_usd: daily === undefined ? null : daily,
      embed_usd_per_million: embed,
      plan_tokens: plan === undefined ? null : plan,
    },
    logs: {
      retention_days: retentionDays,
      prune_at: pruneAt,
    },
    lead: {
      autocompact_tokens: autocompact,
      ...(claude ? { claude: { ...claude } } : {}),
    },
    paid_routines: paid,
  };
}

export function resolveLogsPolicy(policy: ControlPolicy): LogsPolicy {
  return policy.logs ?? DEFAULT_LOGS_POLICY;
}

export function resolveLeadPolicy(policy: ControlPolicy): LeadPolicy {
  return policy.lead ?? DEFAULT_LEAD_POLICY;
}

export function isPaidRoutine(id: string, policy: ControlPolicy = loadPolicy()): boolean {
  return policy.paid_routines.includes(id);
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

// ORCH_PAUSE=1 or a `<state>/PAUSE` file. Empty file is enough.
export function pauseReason(env: NodeJS.ProcessEnv = process.env, state = stateDir()): string | null {
  if (truthy(env.ORCH_PAUSE)) return "ORCH_PAUSE";
  const file = join(state, "PAUSE");
  if (existsSync(file)) return `PAUSE file ${file}`;
  return null;
}

export function assertNotPaused(env: NodeJS.ProcessEnv = process.env, state = stateDir()): void {
  const reason = pauseReason(env, state);
  if (reason) throw new Error(`paused: ${reason}`);
}

export const spendPath = (state = stateDir()) => join(state, "spend.jsonl");
export const holdsPath = (state = stateDir()) => join(state, "spend-holds.json");

function withSpendLock<T>(state: string, fn: () => T): T {
  mkdirSync(state, { recursive: true });
  const fd = openSync(join(state, "spend.lck"), "a", 0o600);
  const deadline = Date.now() + 5_000;
  try {
    while (!tryLock(fd)) {
      if (Date.now() >= deadline) throw new Error("spend: could not lock spend file");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return fn();
  } finally {
    closeSync(fd);
  }
}

function validHold(row: unknown): row is SpendHold {
  if (!row || typeof row !== "object") return false;
  const h = row as SpendHold;
  return typeof h.id === "string" && typeof h.at === "string" && typeof h.source === "string"
    && typeof h.usd === "number" && Number.isFinite(h.usd) && h.usd >= 0
    && typeof h.pid === "number" && Number.isSafeInteger(h.pid);
}

function holdAlive(h: SpendHold, nowMs = Date.now()): boolean {
  try { process.kill(h.pid, 0); return true; } catch {
    return nowMs - Date.parse(h.at) < HOLD_GRACE_MS;
  }
}

export function readHolds(state = stateDir()): SpendHold[] {
  const path = holdsPath(state);
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { holds?: unknown };
    return Array.isArray(doc.holds) ? doc.holds.filter(validHold) : [];
  } catch { return []; }
}

function writeHolds(state: string, holds: SpendHold[]): void {
  mkdirSync(state, { recursive: true });
  const tmp = join(state, "spend-holds.json.tmp");
  writeFileSync(tmp, `${JSON.stringify({ holds }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, holdsPath(state));
}

export function readSpend(state = stateDir()): SpendEntry[] {
  const path = spendPath(state);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as SpendEntry;
      return row && typeof row.at === "string" && typeof row.usd === "number" && Number.isFinite(row.usd) && typeof row.source === "string"
        ? [row] : [];
    } catch { return []; }
  });
}

export function recordSpend(entry: SpendEntry, state = stateDir()): void {
  if (!Number.isFinite(entry.usd) || entry.usd < 0) throw new Error("spend: usd must be a finite non-negative number");
  mkdirSync(state, { recursive: true });
  appendFileSync(spendPath(state), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function spentToday(state = stateDir(), now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return readSpend(state).filter((row) => row.at.slice(0, 10) === day).reduce((n, row) => n + row.usd, 0);
}

export function heldToday(state = stateDir(), now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();
  return readHolds(state).filter((row) => holdAlive(row, nowMs) && row.at.slice(0, 10) === day)
    .reduce((n, row) => n + row.usd, 0);
}

export function spentAndHeld(state = stateDir(), now = new Date()): number {
  return spentToday(state, now) + heldToday(state, now);
}

export function assertSpendAllowed(opts: {
  state?: string;
  policy?: ControlPolicy;
  extraUsd?: number;
  now?: Date;
  label: string;
  watched?: boolean;
  notify?: SpendNotify;
}): void {
  if (!opts.policy) loadPolicy();
  void opts;
}

export type SpendNotify = (notice: { title: string; text: string; level: "warn" }) => void | Promise<void>;

export function spendAlertPath(state = stateDir()): string {
  return join(state, "spend-alert.json");
}

export function maybeSpendAlert(opts: {
  state?: string;
  policy?: ControlPolicy;
  now?: Date;
  used?: number;
  notify?: SpendNotify;
} = {}): { alerted: boolean; event?: string } {
  void opts;
  return { alerted: false };
}

export function reserveSpend(opts: {
  usd: number;
  source: string;
  label: string;
  state?: string;
  policy?: ControlPolicy;
  now?: Date;
  watched?: boolean;
}): SpendHold {
  if (!Number.isFinite(opts.usd) || opts.usd < 0) throw new Error("spend: usd must be a finite non-negative number");
  const state = opts.state ?? stateDir();
  const now = opts.now ?? new Date();
  return withSpendLock(state, () => {
    assertSpendAllowed({ ...opts, extraUsd: opts.usd, state, now });
    const live = readHolds(state).filter((h) => holdAlive(h, now.getTime()));
    const hold: SpendHold = {
      id: `${now.getTime().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      at: now.toISOString(),
      usd: opts.usd,
      source: opts.source,
      pid: process.pid,
    };
    writeHolds(state, [...live, hold]);
    return hold;
  });
}

export function releaseSpend(id: string, state = stateDir()): void {
  withSpendLock(state, () => {
    writeHolds(state, readHolds(state).filter((h) => h.id !== id));
  });
}

// Record actual spend and shrink (or drop) the matching hold. Actual over the
// reserved amount is still recorded: the next call sees the real total.
export function recordAgainstHold(id: string, entry: SpendEntry, state = stateDir()): void {
  if (!Number.isFinite(entry.usd) || entry.usd < 0) throw new Error("spend: usd must be a finite non-negative number");
  const shouldAppend = entry.usd > 0 || !!entry.tokens;
  withSpendLock(state, () => {
    const holds = readHolds(state);
    const hold = holds.find((h) => h.id === id);
    const next = holds.filter((h) => h.id !== id);
    if (hold) {
      const left = Math.max(0, hold.usd - entry.usd);
      if (left > 0) next.push({ ...hold, usd: left });
    }
    writeHolds(state, next);
    if (shouldAppend) {
      mkdirSync(state, { recursive: true });
      appendFileSync(spendPath(state), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
  });
}
