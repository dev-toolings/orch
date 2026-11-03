// Structured mission log: STATE, DECISIONS, exact ERRORS, PATHS, NEXT,
// EVIDENCE. Written continuously so a fresh lead session can start from
// the log instead of a compacted transcript. Fail-open: a bad write never
// throws to a hook.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../core/git.ts";
import { stateDir } from "../core/paths.ts";
import { loadPolicy, pauseReason, spentToday } from "../core/policy.ts";
import { loadProfile } from "../core/profile.ts";
import { appendLog, oneLine, readLog, type LogEntry, type LogKind } from "./log.ts";

export { LOG_KINDS, LOG_CAP_BYTES, isLogKind, journalDir, journalPath, parseLog, readLog, appendLog, recordTool, oneLine } from "./log.ts";
export type { LogKind, LogEntry } from "./log.ts";

export const LOG_INJECT_CAP = 3500;
export const DEFAULT_FRESH_PERCENT = 60;
// Claude Code status-line docs: context_window_size is 200000 by default
// (1000000 only when the payload says so for an extended-context model).
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function snapshotState(opts: {
  cwd: string;
  project: string;
  env?: NodeJS.ProcessEnv;
  session?: string | null;
}): string {
  const env = opts.env ?? process.env;
  const state = env.ORCH_STATE || stateDir();
  const branch = git(opts.cwd, "branch", "--show-current").out || "(detached)";
  const porcelain = git(opts.cwd, "status", "--porcelain");
  const dirty = porcelain.ok ? porcelain.out.split("\n").filter(Boolean).length : -1;
  const head = git(opts.cwd, "rev-parse", "--short", "HEAD").out || "(no HEAD)";
  const lanes = laneSummary(state);
  const spent = spentToday(state);
  loadPolicy();
  const pause = pauseReason(env, state) ?? "none";
  const text = [
    `branch ${branch} @ ${head}`,
    `dirty ${dirty < 0 ? "?" : dirty}`,
    `lanes ${lanes}`,
    `estimated cost (today) $${spent.toFixed(2)}`,
    `pause ${pause}`,
  ].join("; ");
  appendLog({ kind: "state", text, project: opts.project, session: opts.session, env });
  return text;
}

function laneSummary(state: string): string {
  const root = join(state, "lanes");
  if (!existsSync(root)) return "none";
  try {
    const rows = readdirSync(root).flatMap((id) => {
      try {
        const saved = JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")) as { id?: string; status?: string };
        return typeof saved.id === "string" && typeof saved.status === "string"
          ? [`${saved.id}:${saved.status}`] : [];
      } catch { return []; }
    });
    return rows.length ? rows.slice(0, 12).join(", ") : "none";
  } catch {
    return "unknown";
  }
}

export function formatLog(entries: LogEntry[], cap = LOG_INJECT_CAP): string {
  if (!entries.length) return "";
  const latestState = [...entries].reverse().find((e) => e.kind === "state");
  const groups: Record<Exclude<LogKind, "state">, string[]> = {
    decision: [], error: [], path: [], next: [], evidence: [],
  };
  const seenPath = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "state") continue;
    const stamp = entry.at.length >= 16 ? entry.at.slice(11, 16) : entry.at;
    const line = `- ${stamp} ${entry.text}`;
    if (entry.kind === "path") {
      if (seenPath.has(entry.text)) continue;
      seenPath.add(entry.text);
    }
    groups[entry.kind].push(line);
  }
  const sections = [
    latestState ? `STATE: ${latestState.text}` : "",
    groups.decision.length ? `DECISIONS:\n${groups.decision.slice(-12).join("\n")}` : "",
    groups.error.length ? `ERRORS:\n${groups.error.slice(-8).join("\n")}` : "",
    groups.path.length ? `PATHS:\n${groups.path.slice(-16).join("\n")}` : "",
    groups.next.length ? `NEXT:\n${groups.next.slice(-8).join("\n")}` : "",
    groups.evidence.length ? `EVIDENCE:\n${groups.evidence.slice(-8).join("\n")}` : "",
  ].filter(Boolean);
  if (!sections.length) return "";
  const body = `MISSION LOG\n${sections.join("\n")}`;
  if (body.length <= cap) return body;
  return `${body.slice(0, cap)}\n[tronqué: ${body.length - cap} caractères de trop]`;
}

export function recheckBlock(opts: {
  cwd: string;
  project: string;
  env?: NodeJS.ProcessEnv;
  source?: string;
}): string {
  const env = opts.env ?? process.env;
  let state: string;
  try {
    state = snapshotState(opts);
  } catch {
    state = "(snapshot failed)";
  }
  const log = formatLog(readLog(opts.project, env));
  const why = opts.source === "compact" || opts.source === "clear"
    ? "Compaction is not the source of truth. Prefer a fresh `kiba` next time context grows."
    : "Re-check real state first. Do not trust a compacted summary or your memory of the tree.";
  return [
    "RECHECK",
    why,
    `STATE: ${state}`,
    log || "MISSION LOG: (empty)",
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function firstRecord(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const found = asRecord(value[key]);
    if (found) return found;
  }
  return null;
}

// Claude Code status-line formula: input-only tokens, no output_tokens.
function usageTokens(usage: Record<string, unknown> | null): number | null {
  if (!usage) return null;
  const input = finiteNumber(usage.input_tokens);
  const cacheRead = finiteNumber(usage.cache_read_input_tokens);
  const cacheCreate = finiteNumber(usage.cache_creation_input_tokens);
  if (input == null && cacheRead == null && cacheCreate == null) return null;
  return (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
}

function contextWindowSize(source: Record<string, unknown> | null): number | null {
  if (!source) return null;
  const window = firstRecord(source, "context_window", "contextWindow") ?? source;
  const size = finiteNumber(window.context_window_size ?? window.contextWindowSize);
  return size != null && size > 0 ? size : null;
}

function usedPercentage(source: Record<string, unknown> | null): number | null {
  if (!source) return null;
  const window = firstRecord(source, "context_window", "contextWindow") ?? source;
  const percent = finiteNumber(window.used_percentage ?? window.usedPercentage);
  return percent != null && percent >= 0 ? percent : null;
}

function readTranscriptTail(path: string, maxBytes = 1 << 20): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function lastAssistantRecord(path: string): Record<string, unknown> | null {
  let tail = "";
  try { tail = readTranscriptTail(path); } catch { return null; }
  let latest: Record<string, unknown> | null = null;
  for (const line of tail.split("\n")) {
    if (!line.includes('"usage"') && !line.includes("context_window")) continue;
    let rec: Record<string, unknown>;
    try { rec = asRecord(JSON.parse(line)) ?? {}; } catch { continue; }
    const message = asRecord(rec.message);
    if (message?.model === "<synthetic>") continue;
    const usage = asRecord(rec.usage) ?? asRecord(message?.usage);
    const window = firstRecord(rec, "context_window", "contextWindow")
      ?? firstRecord(message ?? {}, "context_window", "contextWindow");
    if (!usage && !window && usedPercentage(rec) == null) continue;
    latest = rec;
  }
  return latest;
}

export interface ContextUsage {
  known: boolean;
  percent?: number;
  used?: number;
  window?: number;
}

export function contextUsage(input: Record<string, unknown>): ContextUsage {
  const payloadWindow = firstRecord(input, "context_window", "contextWindow");
  const payloadPercent = usedPercentage(input);
  if (payloadPercent != null) {
    return { known: true, percent: payloadPercent, window: contextWindowSize(input) ?? undefined };
  }
  const payloadUsage = firstRecord(input, "usage")
    ?? firstRecord(asRecord(input.message) ?? {}, "usage")
    ?? firstRecord(payloadWindow ?? {}, "current_usage", "currentUsage");
  const payloadTokens = usageTokens(payloadUsage);
  const payloadTotal = finiteNumber(payloadWindow?.total_input_tokens ?? payloadWindow?.totalInputTokens);
  const payloadWindowSize = contextWindowSize(input);
  if (payloadTokens != null || payloadTotal != null) {
    const used = payloadTokens ?? payloadTotal ?? 0;
    const window = payloadWindowSize ?? DEFAULT_CONTEXT_WINDOW;
    return { known: true, used, window, percent: (used / window) * 100 };
  }

  const path = typeof input.transcript_path === "string" ? input.transcript_path
    : typeof input.transcriptPath === "string" ? input.transcriptPath
    : "";
  if (!path) return { known: false };
  const last = lastAssistantRecord(path);
  if (!last) return { known: false };
  const lastPercent = usedPercentage(last) ?? usedPercentage(asRecord(last.message));
  if (lastPercent != null) {
    return { known: true, percent: lastPercent, window: contextWindowSize(last) ?? contextWindowSize(asRecord(last.message)) ?? undefined };
  }
  const message = asRecord(last.message);
  const used = usageTokens(asRecord(last.usage) ?? asRecord(message?.usage));
  const window = contextWindowSize(last) ?? contextWindowSize(message) ?? payloadWindowSize ?? DEFAULT_CONTEXT_WINDOW;
  if (used == null) return { known: false };
  return { known: true, used, window, percent: (used / window) * 100 };
}

export function freshPercent(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.ORCH_FRESH_PERCENT);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 100) return fromEnv;
  try {
    const fromProfile = loadProfile(env.ORCH_PROFILE ?? "max20").limits.fresh_session_percent;
    if (typeof fromProfile === "number" && Number.isFinite(fromProfile) && fromProfile > 0 && fromProfile <= 100) {
      return fromProfile;
    }
  } catch { /* catalog missing in a sandbox: keep the default */ }
  return DEFAULT_FRESH_PERCENT;
}

export function contextTooLarge(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { large: boolean; percent?: number; threshold: number; reason: string } {
  const threshold = freshPercent(env);
  const usage = contextUsage(input);
  if (!usage.known || usage.percent == null) return { large: false, threshold, reason: "" };
  if (usage.percent >= threshold) {
    return { large: true, percent: usage.percent, threshold, reason: `${Math.round(usage.percent)}% context` };
  }
  return { large: false, percent: usage.percent, threshold, reason: "" };
}

export function freshSessionNudge(info: { percent?: number; threshold: number; reason: string }): string {
  const pct = info.percent != null ? `${Math.round(info.percent)}%` : info.reason || "threshold";
  return [
    `CONTEXT ${pct} (threshold ${info.threshold}%). Do not /compact.`,
    "Resume note written to `orch log`.",
    "Supervisor is starting a fresh `kiba` from this log without --continue/--resume.",
  ].join(" ");
}

export function freshRequestPath(state = stateDir()): string {
  return join(state, "FRESH");
}

export function freshSessionRequested(state = stateDir()): boolean {
  return existsSync(freshRequestPath(state));
}

export function requestFreshSession(
  state = stateDir(),
  info: { percent?: number; threshold: number; reason: string } = { threshold: DEFAULT_FRESH_PERCENT, reason: "" },
): void {
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(freshRequestPath(state), `${JSON.stringify({
      at: new Date().toISOString(),
      percent: info.percent,
      threshold: info.threshold,
      reason: info.reason,
    })}\n`, { mode: 0o600 });
  } catch { /* fail-open */ }
}

export function consumeFreshRequest(state = stateDir()): { percent?: number; threshold: number; reason: string } | null {
  const path = freshRequestPath(state);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { percent?: number; threshold?: number; reason?: string };
    unlinkSync(path);
    return {
      percent: raw.percent,
      threshold: typeof raw.threshold === "number" ? raw.threshold : DEFAULT_FRESH_PERCENT,
      reason: raw.reason ?? "",
    };
  } catch {
    try { unlinkSync(path); } catch {}
    return { threshold: DEFAULT_FRESH_PERCENT, reason: "" };
  }
}

function cronLine(value: unknown): string {
  if (typeof value === "string" && value.trim()) return oneLine(value, 80);
  const row = asRecord(value);
  if (!row) return "";
  const when = [row.at, row.time, row.when, row.cron, row.schedule].find((item) => typeof item === "string" && item.trim());
  const what = [row.prompt, row.command, row.name, row.id, row.text].find((item) => typeof item === "string" && item.trim());
  if (typeof when === "string" && typeof what === "string") return `${oneLine(when, 40)} ${oneLine(what, 60)}`;
  if (typeof when === "string") return oneLine(when, 80);
  if (typeof what === "string") return oneLine(what, 80);
  return "";
}

function ticketIds(text: string): string[] {
  const found = text.match(/\b[A-Z]{2,10}(?:-[A-Z0-9]{1,10})*-\d+\b/g) ?? [];
  return [...new Set(found)].slice(0, 8);
}

export function resumeNoteText(opts: {
  input?: Record<string, unknown>;
  project: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  const env = opts.env ?? process.env;
  const input = opts.input ?? {};
  const log = readLog(opts.project, env);
  const lanes = laneSummary(env.ORCH_STATE || stateDir());
  const next = log.filter((e) => e.kind === "next" && !e.text.startsWith("RESUME ")).map((e) => e.text);
  const crons = input.session_crons ?? input.sessionCrons ?? input.background_tasks ?? input.backgroundTasks;
  const checks = (Array.isArray(crons) ? crons : crons != null ? [crons] : []).map(cronLine).filter(Boolean);
  const last = typeof input.last_assistant_message === "string" ? input.last_assistant_message
    : typeof input.lastAssistantMessage === "string" ? input.lastAssistantMessage
    : "";
  const tickets = ticketIds([last, ...log.map((e) => e.text)].join(" "));
  const open = lanes !== "none" && lanes !== "unknown" ? lanes : "none";
  return [
    "RESUME",
    `open: ${open}`,
    `checks: ${checks.length ? checks.slice(0, 6).join(", ") : "none"}`,
    `tickets: ${tickets.length ? tickets.join(", ") : "none"}`,
    `next: ${next.length ? next.slice(-4).join("; ") : "none"}`,
  ].join(" ");
}

export function writeResumeNote(opts: {
  cwd: string;
  project: string;
  env?: NodeJS.ProcessEnv;
  session?: string | null;
  input?: Record<string, unknown>;
}): void {
  try {
    snapshotState({ cwd: opts.cwd, project: opts.project, env: opts.env, session: opts.session });
    appendLog({
      kind: "next",
      text: resumeNoteText(opts),
      project: opts.project,
      session: opts.session,
      env: opts.env,
    });
  } catch { /* fail-open */ }
}
