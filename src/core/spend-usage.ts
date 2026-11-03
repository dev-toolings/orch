import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";
import { estimateUsageUsd } from "./paid.ts";
import { recordSpend, type SpendEntry } from "./policy.ts";
import { detectCodexAuthMode } from "./provider-auth.ts";

export interface SpendUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface UsageCursor {
  offset: number;
  tail?: string;
  codexLast?: SpendUsageTokens;
  /** Last Claude message ids recorded: one message spans several transcript lines. */
  claudeIds?: string[];
}

/** Enough ids to cover a message split across two hook reads. */
const CLAUDE_IDS_KEPT = 256;

interface UsageCursorState {
  files: Record<string, UsageCursor>;
}

export interface UsageSpendEntry extends SpendEntry {
  provider: "claude" | "codex" | "grok";
  model: string;
  session?: string;
  project: string;
  tokens: SpendUsageTokens;
  /** Claude message id: the dashboard dedupes on it. */
  message?: string;
}

const usageCursorPath = (state = stateDir()) => join(state, "spend-usage-cursors.json");

function readCursorState(state = stateDir()): UsageCursorState {
  const path = usageCursorPath(state);
  if (!existsSync(path)) return { files: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as UsageCursorState;
    return raw && raw.files && typeof raw.files === "object" ? raw : { files: {} };
  } catch {
    return { files: {} };
  }
}

function writeCursorState(state: string, cursors: UsageCursorState): void {
  const path = usageCursorPath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
}

function readJsonlDelta(path: string, cursor: UsageCursor): { lines: string[]; next: UsageCursor } {
  if (!existsSync(path)) return { lines: [], next: cursor };
  const stat = statSync(path);
  let offset = cursor.offset;
  if (stat.size < offset) offset = 0;
  const fd = openSync(path, "r");
  try {
    const lines: string[] = [];
    let carry = offset === cursor.offset ? (cursor.tail ?? "") : "";
    let pos = offset;
    while (pos < stat.size) {
      const left = stat.size - pos;
      const size = Math.min(64 * 1024, left);
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, pos);
      if (n <= 0) break;
      pos += n;
      carry += buf.subarray(0, n).toString("utf8");
      const rows = carry.split("\n");
      carry = rows.pop() ?? "";
      for (const row of rows) if (row.trim()) lines.push(row);
    }
    return { lines, next: { ...cursor, offset: stat.size, tail: carry } };
  } finally {
    try { closeSync(fd); } catch { /* no-op */ }
  }
}

function appendUsage(entry: UsageSpendEntry, state: string): void {
  const usd = entry.usd >= 0 ? entry.usd : 0;
  const row: UsageSpendEntry = { ...entry, usd };
  recordSpend(row, state);
}

function tokenCount(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function parseClaudeUsageLine(line: string): null | {
  id: string | null;
  at: string;
  model: string;
  tokens: SpendUsageTokens;
} {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const message = row?.message ?? row;
  const usage = message?.usage;
  const at = row?.timestamp ?? row?.at;
  if (!usage || typeof at !== "string") return null;
  const tokens = {
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens),
  };
  if (!tokens.input && !tokens.output && !tokens.cacheRead && !tokens.cacheWrite) return null;
  // Claude Code writes one line per content block, each repeating the message usage.
  const id = message?.id ?? row?.requestId;
  return {
    id: typeof id === "string" && id ? id : null,
    at,
    model: String(message?.model ?? "claude"),
    tokens,
  };
}

function parseCodexTokenCountLine(line: string): null | {
  at: string;
  model: string;
  tokens: SpendUsageTokens;
} {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const payload = row?.payload ?? row;
  if (payload?.type !== "token_count") return null;
  const info = payload?.info ?? {};
  const total = info.total_token_usage ?? payload.last_token_usage ?? info.last_token_usage;
  if (!total) return null;
  return {
    at: String(row?.timestamp ?? payload?.timestamp ?? new Date().toISOString()),
    model: String(info.model ?? row?.model ?? "codex"),
    tokens: {
      input: tokenCount(total.input_tokens),
      output: tokenCount(total.output_tokens) + tokenCount(total.reasoning_output_tokens),
      cacheRead: tokenCount(total.cached_input_tokens),
      cacheWrite: 0,
    },
  };
}

function parseGrokUsageLine(line: string): null | {
  at: string;
  model: string;
  tokens: SpendUsageTokens;
} {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const usage = row?.usage ?? row?.message?.usage ?? row?.token_usage ?? row?.metrics?.usage;
  if (!usage) return null;
  const tokens = {
    input: tokenCount(usage.input_tokens ?? usage.input),
    output: tokenCount(usage.output_tokens ?? usage.output),
    cacheRead: tokenCount(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens ?? usage.cache_write),
  };
  if (!tokens.input && !tokens.output && !tokens.cacheRead && !tokens.cacheWrite) return null;
  return {
    at: String(row?.timestamp ?? row?.at ?? row?.created_at ?? new Date().toISOString()),
    model: String(row?.model ?? row?.message?.model ?? "grok"),
    tokens,
  };
}

function tokenDelta(next: SpendUsageTokens, prev?: SpendUsageTokens): SpendUsageTokens {
  if (!prev) return next;
  const delta = {
    input: next.input - prev.input,
    output: next.output - prev.output,
    cacheRead: next.cacheRead - prev.cacheRead,
    cacheWrite: next.cacheWrite - prev.cacheWrite,
  };
  if (delta.input < 0 || delta.output < 0 || delta.cacheRead < 0 || delta.cacheWrite < 0) return next;
  return delta;
}

export function ingestClaudeTranscriptUsage(opts: {
  transcriptPath: string;
  session?: string;
  project: string;
  state?: string;
  source?: string;
}): number {
  const state = opts.state ?? stateDir();
  const cursors = readCursorState(state);
  const key = `claude:${opts.transcriptPath}`;
  const current = cursors.files[key] ?? { offset: 0 };
  const { lines, next } = readJsonlDelta(opts.transcriptPath, current);
  // A truncated or replaced transcript starts over, ids included.
  const seen = new Set(next.offset >= current.offset ? current.claudeIds ?? [] : []);
  let recorded = 0;
  for (const line of lines) {
    const parsed = parseClaudeUsageLine(line);
    if (!parsed) continue;
    if (parsed.id) {
      if (seen.has(parsed.id)) continue;
      seen.add(parsed.id);
    }
    const usd = estimateUsageUsd({ ...parsed.tokens, model: parsed.model, provider: "claude" });
    appendUsage({
      at: parsed.at,
      usd,
      source: opts.source ?? "lead:claude",
      provider: "claude",
      model: parsed.model,
      session: opts.session,
      project: opts.project,
      tokens: parsed.tokens,
      ...(parsed.id ? { message: parsed.id } : {}),
    }, state);
    recorded++;
  }
  cursors.files[key] = { ...next, claudeIds: [...seen].slice(-CLAUDE_IDS_KEPT) };
  writeCursorState(state, cursors);
  return recorded;
}

export function ingestCodexRolloutUsage(opts: {
  rolloutPath: string;
  session?: string;
  project: string;
  state?: string;
  source?: string;
}): number {
  const state = opts.state ?? stateDir();
  const cursors = readCursorState(state);
  const key = `codex:${opts.rolloutPath}`;
  const current = cursors.files[key] ?? { offset: 0 };
  const { lines, next } = readJsonlDelta(opts.rolloutPath, current);
  let latest: { at: string; model: string; tokens: SpendUsageTokens } | null = null;
  for (const line of lines) {
    const parsed = parseCodexTokenCountLine(line);
    if (parsed) latest = parsed;
  }
  let recorded = 0;
  const codexAuth = detectCodexAuthMode();
  const paid = codexAuth === "api-key";
  if (latest) {
    const delta = tokenDelta(latest.tokens, current.codexLast);
    if (delta.input || delta.output || delta.cacheRead || delta.cacheWrite) {
      const usd = paid ? estimateUsageUsd({ ...delta, model: latest.model, provider: "codex" }) : 0;
      appendUsage({
        at: latest.at,
        usd,
        source: opts.source ?? "lead:codex",
        provider: "codex",
        model: latest.model,
        session: opts.session,
        project: opts.project,
        tokens: delta,
      }, state);
      recorded = 1;
    }
    next.codexLast = latest.tokens;
  }
  cursors.files[key] = next;
  writeCursorState(state, cursors);
  return recorded;
}

export function ingestGrokTranscriptUsage(opts: {
  transcriptPath: string;
  session?: string;
  project: string;
  state?: string;
  source?: string;
}): number {
  const state = opts.state ?? stateDir();
  const cursors = readCursorState(state);
  const key = `grok:${opts.transcriptPath}`;
  const current = cursors.files[key] ?? { offset: 0 };
  const { lines, next } = readJsonlDelta(opts.transcriptPath, current);
  let recorded = 0;
  for (const line of lines) {
    const parsed = parseGrokUsageLine(line);
    if (!parsed) continue;
    const usd = estimateUsageUsd({ ...parsed.tokens, model: parsed.model, provider: "grok" });
    appendUsage({
      at: parsed.at,
      usd,
      source: opts.source ?? "lead:grok",
      provider: "grok",
      model: parsed.model,
      session: opts.session,
      project: opts.project,
      tokens: parsed.tokens,
    }, state);
    recorded++;
  }
  cursors.files[key] = next;
  writeCursorState(state, cursors);
  return recorded;
}
