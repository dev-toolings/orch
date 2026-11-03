import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, type Dirent, type Stats, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir } from "../core/paths.ts";
import { estimateUsageUsd } from "../core/paid.ts";
import { readSpend } from "../core/policy.ts";
import { codexAuthLabel, detectCodexAuthMode, type CodexAuthMode } from "../core/provider-auth.ts";
import type { DashLead, DashQuota, DashTokens, DashRuntime } from "./types.ts";
import { claudeQuota, codexQuota as codexLimits, grokQuota, mergeSamples, parseCodexWindow, parseGrokBillingLine, pushSample, type QuotaSample } from "./quota.ts";

export interface CodexQuota {
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  primaryResetAt?: string;
  secondaryResetAt?: string;
  primaryWindowMinutes?: number;
  secondaryWindowMinutes?: number;
}

export interface ProviderLiveUsage {
  tokens: DashTokens;
  costUsd: number;
  status: "actif" | "en ligne" | "inactif" | "erreur de lecture";
  billing: "usd" | "quota";
  authType?: "clé API" | "login" | "inconnu";
  quota?: CodexQuota;
  limits?: DashQuota;
}

export interface ProviderLiveSnapshot {
  byHarness: Record<"claude" | "codex" | "grok", ProviderLiveUsage>;
  hostDetail: string;
  hostCostExtraUsd: number;
}

const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
const FS_SKIP = new Set(["EACCES", "ENOENT", "ELOOP", "EPERM", "ENOTDIR"]);
const GROK_MAX_DEPTH = 4;
const GROK_MAX_FILES = 600;

function dayParis(when: Date): string {
  return PARIS_DAY.format(when);
}

function dayOfIsoParis(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return dayParis(new Date(t));
}

function fsSkippable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && FS_SKIP.has(code);
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if (fsSkippable(error)) return [];
    throw error;
  }
}

function safeReadDirents(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (fsSkippable(error)) return [];
    throw error;
  }
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if (fsSkippable(error)) return null;
    throw error;
  }
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (fsSkippable(error)) return null;
    throw error;
  }
}

function emptyTokens(): DashTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyUsage(): ProviderLiveUsage {
  return { tokens: emptyTokens(), costUsd: 0, status: "inactif", billing: "usd" };
}

function addTokens(into: DashTokens, more: Partial<DashTokens>): void {
  into.input += more.input ?? 0;
  into.output += more.output ?? 0;
  into.cacheRead += more.cacheRead ?? 0;
  into.cacheWrite += more.cacheWrite ?? 0;
}

function deltaTokens(next: DashTokens, prev: DashTokens): DashTokens {
  return {
    input: Math.max(0, next.input - prev.input),
    output: Math.max(0, next.output - prev.output),
    cacheRead: Math.max(0, next.cacheRead - prev.cacheRead),
    cacheWrite: Math.max(0, next.cacheWrite - prev.cacheWrite),
  };
}

type Cursor = { offset: number; tail: string };
const cursors = new Map<string, Cursor>();
const CACHE_FILE = "dash-usage-cache.json";
const CACHE_VERSION = 1;
const REPORT_WINDOW_DAYS = 30;
let loadedScope: string | null = null;

interface CursorFileState {
  offset: number;
  tail: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

interface ClaudeCacheFile {
  slug: string;
  mtimeMs: number;
  byDay: Record<string, { tokens: DashTokens; costUsd: number }>;
}

interface GrokCacheFile {
  byDay: Record<string, { tokens: DashTokens; costUsd: number }>;
  quota?: QuotaSample[];
}

interface ProviderCacheV1 {
  version: number;
  updatedAt: string;
  scope: { home: string; state: string };
  cursors: Record<string, CursorFileState>;
  claude: Record<string, ClaudeCacheFile>;
  codex: Record<string, CodexFile>;
  grok: Record<string, GrokCacheFile>;
}

/** I/O counters for tests: opened files and bytes read by the ingest readers. */
const ioStats = { opens: 0, bytesRead: 0 };
/** Set when an ingest pass read new bytes: the cache file is rewritten only then. */
let cacheDirty = false;

export function providerIoStatsForTests(): { opens: number; bytesRead: number } {
  return { ...ioStats };
}

function cursorUnchanged(prev: CursorFileState | undefined, stat: Stats): boolean {
  return Boolean(prev)
    && prev!.offset === stat.size
    && prev!.size === stat.size
    && prev!.mtimeMs === stat.mtimeMs
    && prev!.ino === Number(stat.ino);
}

function readJsonlDelta(path: string, known?: Stats): { lines: string[]; reset: boolean } {
  const stat = known ?? safeStat(path);
  if (!stat) return { lines: [], reset: false };
  const prevFull = cursors.get(path) as CursorFileState | undefined;
  // Same size, mtime and inode as the stored cursor: nothing new, no open.
  if (cursorUnchanged(prevFull, stat)) return { lines: [], reset: false };
  const prev = prevFull ?? { offset: 0, tail: "" };
  const inodeChanged = Number.isFinite(prevFull?.ino) && prevFull!.ino !== Number(stat.ino);
  const truncated = Number.isFinite(prevFull?.size) && stat.size < prevFull!.size;
  const reset = inodeChanged || truncated;
  let offset = prev.offset;
  if (stat.size < offset || reset) offset = 0;
  cacheDirty = true;
  const fd = openSync(path, "r");
  ioStats.opens++;
  try {
    const out: string[] = [];
    let carry = (!reset && offset === prev.offset) ? prev.tail : "";
    let pos = offset;
    while (pos < stat.size) {
      const left = stat.size - pos;
      const size = Math.min(64 * 1024, left);
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, pos);
      if (n <= 0) break;
      ioStats.bytesRead += n;
      pos += n;
      carry += buf.subarray(0, n).toString("utf8");
      const rows = carry.split("\n");
      carry = rows.pop() ?? "";
      for (const row of rows) if (row.trim()) out.push(row);
    }
    cursors.set(path, { offset: stat.size, tail: carry, size: stat.size, mtimeMs: stat.mtimeMs, ino: Number(stat.ino) } as CursorFileState);
    return { lines: out, reset };
  } finally {
    try { closeSync(fd); } catch { /* ignored */ }
  }
}

const TAIL_CHUNK = 512 * 1024;
/** Bytes read from the end of a log before settling for what was found. */
export const TAIL_SOFT_MAX = 4 * 1024 * 1024;
/** Hard cap when no matching line was found within the soft cap. */
export const TAIL_HARD_MAX = 16 * 1024 * 1024;

/**
 * Reads complete lines backwards from the end of a file in bounded chunks,
 * newest first, until `enough()` says stop or the byte cap is reached. Leaves
 * a cursor at the end of the file so later passes read only appended bytes.
 */
export function readJsonlTail(path: string, stat: Stats, onLine: (line: string) => void, enough: () => boolean, hasMatch: () => boolean): void {
  const fd = openSync(path, "r");
  ioStats.opens++;
  cacheDirty = true;
  try {
    let pos = stat.size;
    let read = 0;
    let carry = Buffer.alloc(0);
    let tail = "";
    let first = true;
    while (pos > 0 && !enough() && (read < TAIL_SOFT_MAX || (!hasMatch() && read < TAIL_HARD_MAX))) {
      const size = Math.min(TAIL_CHUNK, pos);
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, pos - size);
      if (n <= 0) break;
      ioStats.bytesRead += n;
      read += n;
      pos -= size;
      const joined = Buffer.concat([buf.subarray(0, n), carry]);
      // The first (partial) line of the chunk waits for the previous chunk.
      const cut = pos > 0 ? joined.indexOf(0x0a) : -1;
      carry = cut >= 0 ? joined.subarray(0, cut) : Buffer.alloc(0);
      const body = cut >= 0 ? joined.subarray(cut + 1) : joined;
      const rows = body.toString("utf8").split("\n");
      // A last line without its newline is still being written: keep it as the cursor tail.
      if (first) tail = rows.pop() ?? "";
      first = false;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.trim()) onLine(rows[i]!);
    }
    cursors.set(path, { offset: stat.size, tail, size: stat.size, mtimeMs: stat.mtimeMs, ino: Number(stat.ino) } as CursorFileState);
  } finally {
    try { closeSync(fd); } catch { /* ignored */ }
  }
}

interface ClaudeFile {
  slug: string;
  mtimeMs: number;
  seen: Set<string>;
  byDay: Map<string, { tokens: DashTokens; costUsd: number }>;
}

const claudeFiles = new Map<string, ClaudeFile>();

function staleCutoffMs(now: Date): number {
  return now.getTime() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function mapByDayToRecord(byDay: Map<string, { tokens: DashTokens; costUsd: number }>): Record<string, { tokens: DashTokens; costUsd: number }> {
  const out: Record<string, { tokens: DashTokens; costUsd: number }> = {};
  for (const [day, row] of byDay) out[day] = row;
  return out;
}

function recordToByDay(record: Record<string, { tokens: DashTokens; costUsd: number }>): Map<string, { tokens: DashTokens; costUsd: number }> {
  const out = new Map<string, { tokens: DashTokens; costUsd: number }>();
  for (const [day, row] of Object.entries(record)) out.set(day, row);
  return out;
}

function resetProviderLiveMemory(): void {
  cursors.clear();
  claudeFiles.clear();
  codexFiles.clear();
  grokFiles.clear();
}

function providerCachePath(state: string): string {
  return join(state, CACHE_FILE);
}

function loadProviderCache(home: string, state: string, now: Date): void {
  const scope = `${home}|${state}`;
  if (loadedScope === scope) return;
  loadedScope = scope;
  resetProviderLiveMemory();
  const path = providerCachePath(state);
  if (!existsSync(path)) return;
  let parsed: ProviderCacheV1 | null = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderCacheV1;
  } catch {
    return;
  }
  if (!parsed || parsed.version !== CACHE_VERSION) return;
  if (parsed.scope?.home !== home || parsed.scope?.state !== state) return;
  const cutoff = staleCutoffMs(now);
  for (const [file, row] of Object.entries(parsed.cursors ?? {})) {
    cursors.set(file, { offset: Number(row.offset ?? 0), tail: String(row.tail ?? ""), size: Number(row.size ?? 0), mtimeMs: Number(row.mtimeMs ?? 0), ino: Number(row.ino ?? 0) } as CursorFileState);
  }
  for (const [file, row] of Object.entries(parsed.claude ?? {})) {
    if (!file.startsWith(home)) continue;
    const byDay = recordToByDay(row.byDay ?? {});
    for (const day of [...byDay.keys()]) {
      const t = Date.parse(`${day}T00:00:00.000Z`);
      if (Number.isFinite(t) && t < cutoff) byDay.delete(day);
    }
    claudeFiles.set(file, { slug: row.slug ?? "", mtimeMs: Number(row.mtimeMs ?? 0), seen: new Set<string>(), byDay });
  }
  for (const [file, row] of Object.entries(parsed.codex ?? {})) {
    if (!file.startsWith(home)) continue;
    codexFiles.set(file, row);
  }
  for (const [file, row] of Object.entries(parsed.grok ?? {})) {
    if (!file.startsWith(home)) continue;
    grokFiles.set(file, { byDay: recordToByDay(row.byDay ?? {}), quota: Array.isArray(row.quota) ? row.quota : undefined });
  }
}

function saveProviderCache(home: string, state: string): void {
  const path = providerCachePath(state);
  mkdirSync(state, { recursive: true });
  const data: ProviderCacheV1 = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    scope: { home, state },
    cursors: {},
    claude: {},
    codex: {},
    grok: {},
  };
  for (const [file, row] of cursors) {
    if (!file.startsWith(home)) continue;
    const full = row as CursorFileState;
    data.cursors[file] = {
      offset: row.offset,
      tail: row.tail,
      size: Number(full.size ?? row.offset),
      mtimeMs: Number(full.mtimeMs ?? 0),
      ino: Number(full.ino ?? 0),
    };
  }
  for (const [file, row] of claudeFiles) {
    if (!file.startsWith(home)) continue;
    data.claude[file] = { slug: row.slug, mtimeMs: row.mtimeMs, byDay: mapByDayToRecord(row.byDay) };
  }
  for (const [file, row] of codexFiles) {
    if (!file.startsWith(home)) continue;
    data.codex[file] = row;
  }
  for (const [file, row] of grokFiles) {
    if (!file.startsWith(home)) continue;
    data.grok[file] = { byDay: mapByDayToRecord(row.byDay), ...(row.quota?.length ? { quota: row.quota } : {}) };
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, path);
}

function claudeRoots(home: string): string[] {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  return safeReadDirents(root)
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}

function usageCost(model: string, provider: "claude" | "codex", t: { input: number; output: number; cacheRead: number; cacheWrite?: number }): number {
  return estimateUsageUsd({
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheCreation: t.cacheWrite ?? 0,
    model,
    provider,
  });
}

export function parseClaudeLine(line: string): null | { id: string; at: string; model: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } } {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const id = row?.message?.id;
  const usage = row?.message?.usage;
  const at = row?.timestamp;
  const model = row?.message?.model ?? "claude";
  if (!id || !usage || !at) return null;
  return {
    id: String(id),
    at: String(at),
    model: String(model),
    tokens: {
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      cacheRead: Number(usage.cache_read_input_tokens ?? 0),
      cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
    },
  };
}

function claudeSlugCandidates(cwd: string): string[] {
  const norm = cwd.replace(/\/+$/, "");
  const slug = norm.replace(/\//g, "-").replace(/^-+/, "");
  return [slug, `-${slug}`, norm.split("/").filter(Boolean).join("-")];
}

interface CodexFile {
  latestAt: string | null;
  model: string;
  tokens: DashTokens;
  quota?: CodexQuota;
  /** Recent rate-limit samples per window, for the burn rate. */
  quotaHistory?: { primary?: QuotaSample[]; secondary?: QuotaSample[] };
}

const codexFiles = new Map<string, CodexFile>();

export function parseCodexLine(line: string): null | { at: string; model: string; tokens: DashTokens; quota?: CodexQuota } {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const payload = row?.payload ?? row;
  if (payload?.type !== "token_count") return null;
  const info = payload?.info ?? {};
  const usage = info.total_token_usage ?? payload.last_token_usage ?? info.last_token_usage;
  if (!usage) return null;
  const quotaRaw = payload.rate_limits ?? row.rate_limits ?? info.rate_limits ?? {};
  const at = String(row?.timestamp ?? payload?.timestamp ?? info?.timestamp ?? row?.at ?? new Date().toISOString());
  const primary = parseCodexWindow(quotaRaw?.primary, at);
  const secondary = parseCodexWindow(quotaRaw?.secondary, at);
  const quota: CodexQuota = {
    primaryUsedPercent: primary?.usedPercent ?? Number(quotaRaw?.primary_used_percent ?? NaN),
    secondaryUsedPercent: secondary?.usedPercent ?? Number(quotaRaw?.secondary_used_percent ?? NaN),
    primaryResetAt: primary?.resetAt,
    secondaryResetAt: secondary?.resetAt,
    primaryWindowMinutes: primary?.windowMinutes,
    secondaryWindowMinutes: secondary?.windowMinutes,
  };
  if (!Number.isFinite(quota.primaryUsedPercent ?? NaN)) delete quota.primaryUsedPercent;
  if (!Number.isFinite(quota.secondaryUsedPercent ?? NaN)) delete quota.secondaryUsedPercent;
  for (const key of Object.keys(quota) as (keyof CodexQuota)[]) if (quota[key] === undefined) delete quota[key];
  return {
    at,
    model: String(info.model ?? row?.model ?? "codex"),
    tokens: {
      input: Number(usage.input_tokens ?? 0),
      output: Number((usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0)),
      cacheRead: Number(usage.cached_input_tokens ?? 0),
      cacheWrite: 0,
    },
    quota: Object.keys(quota).length ? quota : undefined,
  };
}

interface GrokFile {
  byDay: Map<string, { tokens: DashTokens; costUsd: number }>;
  quota?: QuotaSample[];
}

function pushCodexQuota(ref: CodexFile, at: string, quota: CodexQuota | undefined): void {
  if (!quota) return;
  const history = ref.quotaHistory ?? {};
  const now = new Date(Date.parse(at) || Date.now());
  if (quota.primaryUsedPercent != null) {
    history.primary = pushSample(history.primary ?? [], { at, p: quota.primaryUsedPercent, r: quota.primaryResetAt, w: quota.primaryWindowMinutes }, now);
  }
  if (quota.secondaryUsedPercent != null) {
    history.secondary = pushSample(history.secondary ?? [], { at, p: quota.secondaryUsedPercent, r: quota.secondaryResetAt, w: quota.secondaryWindowMinutes }, now);
  }
  ref.quotaHistory = history;
}

const grokFiles = new Map<string, GrokFile>();

export function parseGrokLine(line: string): null | { at: string; model: string; tokens: DashTokens } {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const usage = row?.usage ?? row?.message?.usage ?? row?.token_usage ?? row?.metrics?.usage;
  if (!usage) return null;
  const input = Number(usage.input_tokens ?? usage.input ?? 0);
  const output = Number(usage.output_tokens ?? usage.output ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read ?? 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? usage.cache_write ?? 0);
  if (!(input || output || cacheRead || cacheWrite)) return null;
  const at = String(row?.timestamp ?? row?.at ?? row?.created_at ?? new Date().toISOString());
  return { at, model: String(row?.model ?? row?.message?.model ?? "grok"), tokens: { input, output, cacheRead, cacheWrite } };
}

function readJsonlAll(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((row) => row.trim().length > 0);
}

function codexTodayDirs(home: string, now: Date): string[] {
  const d = new Date(now);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const root = join(home, ".codex", "sessions", yyyy, mm, dd);
  return [root];
}

function grokUsageRoots(home: string, extra: string[] = []): string[] {
  const roots = [
    join(home, ".grok", "sessions"),
    join(home, ".grok", "logs"),
    ...extra,
  ];
  return [...new Set(roots)].filter((path) => existsSync(path));
}

function updateClaude(home: string, now: Date): void {
  const cutoff = staleCutoffMs(now);
  for (const dir of claudeRoots(home)) {
    const slug = dir.split("/").at(-1) ?? "";
    for (const file of safeReadDir(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))) {
      try {
        const st = safeStat(file);
        if (!st) continue;
        const prior = claudeFiles.get(file);
        if (!prior && st.mtimeMs < cutoff) continue;
        const ref = prior ?? { slug, mtimeMs: 0, seen: new Set<string>(), byDay: new Map() };
        ref.slug = slug;
        ref.mtimeMs = st.mtimeMs;
        const delta = readJsonlDelta(file, st);
        if (delta.reset) {
          ref.byDay.clear();
          ref.seen.clear();
        }
        for (const line of delta.lines) {
          const row = parseClaudeLine(line);
          if (!row || ref.seen.has(row.id)) continue;
          ref.seen.add(row.id);
          const day = dayOfIsoParis(row.at);
          if (!day) continue;
          const bucket = ref.byDay.get(day) ?? { tokens: emptyTokens(), costUsd: 0 };
          addTokens(bucket.tokens, row.tokens);
          bucket.costUsd += usageCost(row.model, "claude", row.tokens);
          ref.byDay.set(day, bucket);
        }
        claudeFiles.set(file, ref);
      } catch (error) {
        if (fsSkippable(error)) continue;
        throw error;
      }
    }
  }
}

function updateCodex(home: string, now: Date): void {
  for (const dir of codexTodayDirs(home, now)) {
    if (!existsSync(dir)) continue;
    for (const file of safeReadDir(dir).filter((f) => /^rollout-.*\.jsonl$/.test(f)).map((f) => join(dir, f))) {
      try {
        const ref = codexFiles.get(file) ?? { latestAt: null, model: "codex", tokens: emptyTokens() };
        const delta = readJsonlDelta(file);
        if (delta.reset) {
          ref.latestAt = null;
          ref.tokens = emptyTokens();
          ref.quota = undefined;
          ref.quotaHistory = undefined;
        }
        for (const line of delta.lines) {
          const row = parseCodexLine(line);
          if (!row) continue;
          pushCodexQuota(ref, row.at, row.quota);
          if (!ref.latestAt || Date.parse(row.at) >= Date.parse(ref.latestAt)) {
            ref.latestAt = row.at;
            ref.model = row.model;
            ref.tokens = row.tokens;
            ref.quota = row.quota;
          }
        }
        codexFiles.set(file, ref);
      } catch (error) {
        if (fsSkippable(error)) continue;
        throw error;
      }
    }
  }
}

/** Billing samples wanted from a cold tail read of the Grok CLI log. */
const GROK_TAIL_SAMPLES = 24;

function ingestGrokFile(path: string, st: Stats, cutoff: number, opts: { tail?: boolean } = {}): void {
  const prior = grokFiles.get(path);
  if (!prior && st.mtimeMs < cutoff) return;
  const ref: GrokFile = prior ?? { byDay: new Map() };
  const onLine = (line: string) => {
    const billing = parseGrokBillingLine(line);
    if (billing) {
      ref.quota = pushSample(ref.quota ?? [], billing, new Date(Date.parse(billing.at)));
      return;
    }
    const row = parseGrokLine(line);
    if (!row) return;
    const day = dayOfIsoParis(row.at);
    if (!day) return;
    const bucket = ref.byDay.get(day) ?? { tokens: emptyTokens(), costUsd: 0 };
    addTokens(bucket.tokens, row.tokens);
    bucket.costUsd += usageCost(row.model, "codex", { ...row.tokens, cacheWrite: 0 });
    ref.byDay.set(day, bucket);
  };
  // The CLI log has no cursor yet: its billing lines are a few per MB, read
  // them from the end instead of scanning the whole history.
  if (opts.tail && !cursors.has(path)) {
    readJsonlTail(path, st, onLine, () => (ref.quota?.length ?? 0) >= GROK_TAIL_SAMPLES, () => Boolean(ref.quota?.length));
    grokFiles.set(path, ref);
    return;
  }
  const delta = readJsonlDelta(path, st);
  if (delta.reset) {
    ref.byDay.clear();
    ref.quota = undefined;
  }
  for (const line of delta.lines) onLine(line);
  grokFiles.set(path, ref);
}

function updateGrok(home: string, now: Date, roots: string[] = []): void {
  let seenFiles = 0;
  const cutoff = staleCutoffMs(now);
  // The CLI log carries the billing credits snapshots: read it first so the
  // session walk's file cap never hides it.
  const unified = join(home, ".grok", "logs", "unified.jsonl");
  const unifiedStat = safeLstat(unified);
  if (unifiedStat?.isFile()) {
    try { ingestGrokFile(unified, unifiedStat, cutoff, { tail: true }); } catch (error) { if (!fsSkippable(error)) throw error; }
  }
  for (const root of grokUsageRoots(home, roots)) {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length && seenFiles < GROK_MAX_FILES) {
      const next = stack.pop()!;
      const dirEntries = safeReadDirents(next.dir);
      for (const entry of dirEntries) {
        if (seenFiles >= GROK_MAX_FILES) break;
        if (entry.name.startsWith("sandbox-blocked")) continue;
        const path = join(next.dir, entry.name);
        if (path === unified) continue;
        const st = safeLstat(path);
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (next.depth < GROK_MAX_DEPTH) stack.push({ dir: path, depth: next.depth + 1 });
          continue;
        }
        if (!st.isFile() || !entry.name.endsWith(".jsonl")) continue;
        seenFiles++;
        try {
          ingestGrokFile(path, st, cutoff);
        } catch (error) {
          if (fsSkippable(error)) continue;
          throw error;
        }
      }
    }
  }
}

function readSpendToday(now: Date, state = stateDir()): {
  byHarness: Record<"claude" | "codex" | "grok", { tokens: DashTokens; costUsd: number }>;
  hostExtraUsd: number;
} {
  const day = dayParis(now);
  const byHarness = {
    claude: { tokens: emptyTokens(), costUsd: 0 },
    codex: { tokens: emptyTokens(), costUsd: 0 },
    grok: { tokens: emptyTokens(), costUsd: 0 },
  };
  let hostExtraUsd = 0;
  for (const row of readSpend(state)) {
    if (dayOfIsoParis(row.at) !== day) continue;
    const provider = typeof row.provider === "string" ? row.provider : "";
    const tokens = row.tokens;
    if ((provider === "claude" || provider === "codex" || provider === "grok") && tokens) {
      addTokens(byHarness[provider].tokens, tokens);
      byHarness[provider].costUsd += row.usd;
      continue;
    }
    hostExtraUsd += row.usd;
  }
  return { byHarness, hostExtraUsd };
}

let gpuCache = { at: 0, text: "GPU inconnu" };

function gpuDetail(now: Date): string {
  if (now.getTime() - gpuCache.at < 30_000) return gpuCache.text;
  const probe = spawnSync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 700,
  });
  if (probe.status === 0 && probe.stdout.trim()) {
    const first = probe.stdout.trim().split("\n")[0]?.split(",").map((x) => x.trim()) ?? [];
    if (first.length >= 4) {
      gpuCache = { at: now.getTime(), text: `${first[0]} ${first[3]}% (${first[1]}/${first[2]} MiB)` };
      return gpuCache.text;
    }
  }
  gpuCache = { at: now.getTime(), text: "sans GPU" };
  return gpuCache.text;
}

export function hostRuntimeDetail(now = new Date()): string {
  const cores = cpus().length;
  const ram = totalmem() / (1024 ** 3);
  const load = loadavg()[0];
  return `${cores} cœurs · ${ram.toFixed(0)} Gio · load ${load.toFixed(2)} · ${gpuDetail(now)}`;
}

export function providerWatchDirs(home = process.env.HOME ?? process.env.ORCH_HOME ?? "", now = new Date(), state = stateDir()): string[] {
  const out = new Set<string>();
  out.add(join(home, ".claude", "projects"));
  for (const dir of claudeRoots(home)) out.add(dir);
  out.add(join(home, ".codex"));
  out.add(join(home, ".codex", "sessions"));
  for (const dir of codexTodayDirs(home, now)) out.add(dir);
  for (const dir of grokUsageRoots(home)) out.add(dir);
  out.add(state);
  return [...out].filter((p) => existsSync(p));
}

type DayUsage = { tokens: DashTokens; costUsd: number };
type ProviderId = "claude" | "codex" | "grok";

/**
 * What the dash needs from the ingested logs, small enough to post from the
 * ingest worker every cycle: per-day totals for the recent days, activity
 * marks and the quota sample histories. Statuses are computed by the reader
 * with its own leads and clock.
 */
export interface ProviderUsageSummary {
  at: string;
  home: string;
  claude: { byDay: Record<string, DayUsage>; lastMtimeMs: number };
  codex: {
    files: Array<{ latestAt: string; model: string; tokens: DashTokens }>;
    latest?: { quota: CodexQuota; at: string };
    primary: QuotaSample[];
    secondary: QuotaSample[];
  };
  grok: { byDay: Record<string, DayUsage>; quota: QuotaSample[] };
  errors: Partial<Record<ProviderId, string>>;
  /** Claude transcript tokens on a UTC day, for policy.spend.plan_tokens. */
  planTokens?: { day: string; tokens: number };
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

function recentDays(now: Date): Set<string> {
  return new Set([dayParis(now), dayParis(new Date(now.getTime() - 24 * 60 * 60 * 1000))]);
}

function addDay(into: Record<string, DayUsage>, day: string, row: DayUsage): void {
  const bucket = into[day] ?? { tokens: emptyTokens(), costUsd: 0 };
  addTokens(bucket.tokens, row.tokens);
  bucket.costUsd += row.costUsd;
  into[day] = bucket;
}

/** Folds the in-memory ingest state into a summary (no file access). */
export function summarizeProviderMemory(home: string, now: Date, errors: ProviderUsageSummary["errors"] = {}): ProviderUsageSummary {
  const days = recentDays(now);
  const out: ProviderUsageSummary = {
    at: now.toISOString(),
    home,
    claude: { byDay: {}, lastMtimeMs: 0 },
    codex: { files: [], primary: [], secondary: [] },
    grok: { byDay: {}, quota: [] },
    errors,
  };
  for (const [path, f] of claudeFiles) {
    if (!path.startsWith(home)) continue;
    out.claude.lastMtimeMs = Math.max(out.claude.lastMtimeMs, f.mtimeMs);
    for (const [day, row] of f.byDay) if (days.has(day)) addDay(out.claude.byDay, day, row);
  }
  const primary: QuotaSample[][] = [];
  const secondary: QuotaSample[][] = [];
  let latestAt = -Infinity;
  for (const [path, f] of codexFiles) {
    if (!path.startsWith(home)) continue;
    // Rate limits are account-wide: the latest snapshot wins, whatever its day.
    const at = f.latestAt ? Date.parse(f.latestAt) : NaN;
    if (f.quota && Number.isFinite(at) && at >= latestAt) {
      out.codex.latest = { quota: f.quota, at: new Date(at).toISOString() };
      latestAt = at;
    }
    if (f.quotaHistory?.primary) primary.push(f.quotaHistory.primary);
    if (f.quotaHistory?.secondary) secondary.push(f.quotaHistory.secondary);
    const day = f.latestAt ? dayOfIsoParis(f.latestAt) : null;
    if (f.latestAt && day && days.has(day)) out.codex.files.push({ latestAt: f.latestAt, model: f.model, tokens: f.tokens });
  }
  out.codex.primary = mergeSamples(primary);
  out.codex.secondary = mergeSamples(secondary);
  const grokQuota: QuotaSample[][] = [];
  for (const [path, f] of grokFiles) {
    if (!path.startsWith(home)) continue;
    if (f.quota?.length) grokQuota.push(f.quota);
    for (const [day, row] of f.byDay) if (days.has(day)) addDay(out.grok.byDay, day, row);
  }
  out.grok.quota = mergeSamples(grokQuota);
  return out;
}

/** Runs one synchronous ingest pass (Claude, Codex, Grok), persists the cache when it changed. */
export function ingestProviderLogs(opts: { home: string; state: string; now: Date; grokRoots?: string[] }): ProviderUsageSummary["errors"] {
  loadProviderCache(opts.home, opts.state, opts.now);
  const errors: ProviderUsageSummary["errors"] = {};
  cacheDirty = false;
  try { updateClaude(opts.home, opts.now); } catch (error) { errors.claude = errorText(error); }
  try { updateCodex(opts.home, opts.now); } catch (error) { errors.codex = errorText(error); }
  try { updateGrok(opts.home, opts.now, opts.grokRoots); } catch (error) { errors.grok = errorText(error); }
  if (cacheDirty || !existsSync(providerCachePath(opts.state))) {
    try { saveProviderCache(opts.home, opts.state); } catch { /* cache persistence is best effort */ }
  }
  cacheDirty = false;
  return errors;
}

/** Summary of the persisted cache alone, without reading any provider log. */
export function cachedProviderSummary(opts: { home: string; state: string; now: Date }): ProviderUsageSummary | null {
  if (!existsSync(providerCachePath(opts.state))) return null;
  loadProviderCache(opts.home, opts.state, opts.now);
  return summarizeProviderMemory(opts.home, opts.now);
}

function loadingQuota(source: string): DashQuota {
  return { source, stale: false, windows: [], loading: true };
}

/**
 * Turns a summary (or none yet) into the per-harness usage the dash shows.
 * Cheap: reads spend.jsonl, the Codex auth mode and the Claude quota file.
 */
export function providerLiveFromSummary(summary: ProviderUsageSummary | null, opts: {
  leads: DashLead[];
  installed: string[];
  now?: Date;
  home?: string;
  state?: string;
  syncing?: boolean;
}): ProviderLiveSnapshot {
  const now = opts.now ?? new Date();
  const home = opts.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? "";
  const state = opts.state ?? stateDir();
  const syncing = Boolean(opts.syncing);
  const codexAuthMode = detectCodexAuthMode(home);
  const codexAuth = codexAuthLabel(codexAuthMode);
  const errors = summary?.errors ?? {};
  const spend = readSpendToday(now, state);
  const day = dayParis(now);
  const zero: DayUsage = { tokens: emptyTokens(), costUsd: 0 };

  const out: ProviderLiveSnapshot = {
    byHarness: {
      claude: emptyUsage(),
      codex: emptyUsage(),
      grok: emptyUsage(),
    },
    hostDetail: hostRuntimeDetail(now),
    hostCostExtraUsd: spend.hostExtraUsd,
  };

  const claudeLeads = opts.leads.filter((l) => l.harness === "claude");
  const claudeActive = summary ? now.getTime() - summary.claude.lastMtimeMs <= 60_000 : false;
  const claudeTail = summary?.claude.byDay[day] ?? zero;
  out.byHarness.claude.tokens = { ...spend.byHarness.claude.tokens };
  out.byHarness.claude.costUsd = spend.byHarness.claude.costUsd;
  out.byHarness.claude.billing = "usd";
  addTokens(out.byHarness.claude.tokens, deltaTokens(claudeTail.tokens, spend.byHarness.claude.tokens));
  out.byHarness.claude.costUsd += Math.max(0, claudeTail.costUsd - spend.byHarness.claude.costUsd);
  out.byHarness.claude.status = errors.claude ? "erreur de lecture" : (claudeActive ? "actif" : claudeLeads.length ? "en ligne" : "inactif");

  const codexLeads = opts.leads.filter((l) => l.harness === "codex");
  let codexActive = false;
  const codexTail = emptyUsage();
  for (const f of summary?.codex.files ?? []) {
    if (dayOfIsoParis(f.latestAt) !== day) continue;
    addTokens(codexTail.tokens, f.tokens);
    codexTail.costUsd += usageCost(f.model, "codex", { ...f.tokens, cacheWrite: 0 });
    codexActive ||= now.getTime() - Date.parse(f.latestAt) <= 60_000;
  }
  const codexQuota = summary?.codex.latest?.quota;
  out.byHarness.codex.tokens = { ...spend.byHarness.codex.tokens };
  out.byHarness.codex.costUsd = codexAuthMode === "login" ? 0 : spend.byHarness.codex.costUsd;
  out.byHarness.codex.billing = codexAuthMode === "login" ? "quota" : "usd";
  out.byHarness.codex.authType = codexAuth;
  addTokens(out.byHarness.codex.tokens, deltaTokens(codexTail.tokens, spend.byHarness.codex.tokens));
  if (codexAuthMode !== "login") {
    out.byHarness.codex.costUsd += Math.max(0, codexTail.costUsd - spend.byHarness.codex.costUsd);
  }
  out.byHarness.codex.status = errors.codex ? "erreur de lecture" : (codexActive ? "actif" : codexLeads.length ? "en ligne" : "inactif");
  out.byHarness.codex.quota = codexAuthMode === "api-key" ? undefined : codexQuota;
  out.byHarness.codex.limits = codexAuthMode === "api-key"
    ? { source: "rollouts Codex", stale: false, windows: [], unavailable: "clé API : facturation à l'usage, pas de fenêtre de quota" }
    : codexQuota && !summary?.codex.primary.length && !summary?.codex.secondary.length
      ? codexQuotaFromLatest(codexQuota, new Date(summary!.codex.latest!.at), now)
      : codexLimits({ primary: summary?.codex.primary ?? [], secondary: summary?.codex.secondary ?? [] }, now);
  out.byHarness.claude.limits = claudeQuota(state, now);

  const grokLeads = opts.leads.filter((l) => l.harness === "grok");
  const grokTail = summary?.grok.byDay[day] ?? zero;
  const grokActive = (grokTail.tokens.input + grokTail.tokens.output + grokTail.tokens.cacheRead + grokTail.tokens.cacheWrite) > 0;
  out.byHarness.grok.tokens = { ...spend.byHarness.grok.tokens };
  out.byHarness.grok.costUsd = spend.byHarness.grok.costUsd;
  out.byHarness.grok.billing = "usd";
  addTokens(out.byHarness.grok.tokens, deltaTokens(grokTail.tokens, spend.byHarness.grok.tokens));
  out.byHarness.grok.costUsd += Math.max(0, grokTail.costUsd - spend.byHarness.grok.costUsd);
  out.byHarness.grok.limits = grokQuota(summary?.grok.quota ?? [], now);
  out.byHarness.grok.status = errors.grok ? "erreur de lecture" : (grokActive ? "actif" : grokLeads.length ? "en ligne" : (opts.installed.includes("grok") ? "en ligne" : "inactif"));

  // First ingest still running and nothing known yet: say so instead of "no data".
  if (syncing) {
    for (const id of ["claude", "codex", "grok"] as const) {
      const limits = out.byHarness[id].limits;
      if (limits && !limits.windows.length && !(id === "codex" && codexAuthMode === "api-key")) {
        out.byHarness[id].limits = loadingQuota(limits.source);
      }
    }
  }
  return out;
}

export function collectProviderLive(opts: {
  leads: DashLead[];
  installed: string[];
  now?: Date;
  home?: string;
  state?: string;
  grokRoots?: string[];
  onProviderError?: (provider: ProviderId, error: unknown) => void;
  ingestMode?: "sync" | "cache-only";
}): ProviderLiveSnapshot {
  const now = opts.now ?? new Date();
  const home = opts.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? "";
  const state = opts.state ?? stateDir();
  loadProviderCache(home, state, now);
  let errors: ProviderUsageSummary["errors"] = {};
  if ((opts.ingestMode ?? "sync") === "sync") {
    errors = ingestProviderLogs({ home, state, now, grokRoots: opts.grokRoots });
    for (const id of Object.keys(errors) as ProviderId[]) opts.onProviderError?.(id, new Error(errors[id]));
  }
  return providerLiveFromSummary(summarizeProviderMemory(home, now, errors), { leads: opts.leads, installed: opts.installed, now, home, state });
}

// Cache files written before the quota history existed: one sample per window.
function codexQuotaFromLatest(q: CodexQuota, at: Date, now: Date): DashQuota {
  const iso = at.toISOString();
  return codexLimits({
    primary: q.primaryUsedPercent != null ? [{ at: iso, p: q.primaryUsedPercent, r: q.primaryResetAt, w: q.primaryWindowMinutes }] : [],
    secondary: q.secondaryUsedPercent != null ? [{ at: iso, p: q.secondaryUsedPercent, r: q.secondaryResetAt, w: q.secondaryWindowMinutes }] : [],
  }, now);
}

export function resetProviderLiveStateForTests(): void {
  loadedScope = null;
  resetProviderLiveMemory();
}

export function foldProviderUsageIntoCache(opts: {
  provider: "claude" | "codex" | "grok";
  path: string;
  home?: string;
  state?: string;
  now?: Date;
}): void {
  const home = opts.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? "";
  const state = opts.state ?? stateDir();
  const now = opts.now ?? new Date();
  loadProviderCache(home, state, now);
  const st = safeStat(opts.path);
  if (!st) return;
  if (opts.provider === "claude") {
    const seen = new Set<string>();
    const byDay = new Map<string, { tokens: DashTokens; costUsd: number }>();
    for (const line of readJsonlAll(opts.path)) {
      const row = parseClaudeLine(line);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      const day = dayOfIsoParis(row.at);
      if (!day) continue;
      const bucket = byDay.get(day) ?? { tokens: emptyTokens(), costUsd: 0 };
      addTokens(bucket.tokens, row.tokens);
      bucket.costUsd += usageCost(row.model, "claude", row.tokens);
      byDay.set(day, bucket);
    }
    claudeFiles.set(opts.path, { slug: opts.path.split("/").at(-2) ?? "", mtimeMs: st.mtimeMs, seen: new Set(), byDay });
  } else if (opts.provider === "codex") {
    let latest: CodexFile | null = null;
    const history: CodexFile = { latestAt: null, model: "codex", tokens: emptyTokens() };
    for (const line of readJsonlAll(opts.path)) {
      const row = parseCodexLine(line);
      if (!row) continue;
      pushCodexQuota(history, row.at, row.quota);
      if (!latest || Date.parse(row.at) >= Date.parse(latest.latestAt ?? "")) {
        latest = { latestAt: row.at, model: row.model, tokens: row.tokens, quota: row.quota };
      }
    }
    if (latest && history.quotaHistory) latest.quotaHistory = history.quotaHistory;
    if (latest) codexFiles.set(opts.path, latest);
  } else {
    const byDay = new Map<string, { tokens: DashTokens; costUsd: number }>();
    let quota: QuotaSample[] | undefined;
    for (const line of readJsonlAll(opts.path)) {
      const billing = parseGrokBillingLine(line);
      if (billing) {
        quota = pushSample(quota ?? [], billing, new Date(Date.parse(billing.at)));
        continue;
      }
      const row = parseGrokLine(line);
      if (!row) continue;
      const day = dayOfIsoParis(row.at);
      if (!day) continue;
      const bucket = byDay.get(day) ?? { tokens: emptyTokens(), costUsd: 0 };
      addTokens(bucket.tokens, row.tokens);
      bucket.costUsd += usageCost(row.model, "codex", { ...row.tokens, cacheWrite: 0 });
      byDay.set(day, bucket);
    }
    grokFiles.set(opts.path, { byDay, quota });
  }
  cursors.set(opts.path, { offset: st.size, tail: "", size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) } as CursorFileState);
  saveProviderCache(home, state);
}

export function applyProviderLive(base: DashRuntime[], live: ProviderLiveSnapshot): DashRuntime[] {
  return base.map((rt) => {
    if (rt.kind === "host") {
      return {
        ...rt,
        detail: live.hostDetail,
        costUsd: rt.costUsd + live.hostCostExtraUsd,
      };
    }
    const usage = live.byHarness[rt.id as "claude" | "codex" | "grok"];
    if (!usage) return rt;
    const authSuffix = usage.authType ? ` · ${usage.authType}` : "";
    return {
      ...rt,
      live: usage.status === "actif",
      online: usage.status !== "inactif" || rt.online,
      detail: `${usage.status}${authSuffix}`,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      quota: usage.quota,
      limits: usage.limits,
      billing: usage.billing,
      authType: usage.authType,
      estimate: true,
    } as DashRuntime;
  });
}

