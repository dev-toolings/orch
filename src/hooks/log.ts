// Light mission log store imported by the per-tool hook to avoid heavy imports.
// Never add policy, profile, git or yaml here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { inspectSecrets } from "../memory/privacy.ts";

export const LOG_KINDS = ["state", "decision", "error", "path", "next", "evidence"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogEntry {
  at: string;
  kind: LogKind;
  text: string;
  session?: string;
}

export const LOG_CAP_BYTES = 64_000;

export function isLogKind(value: string): value is LogKind {
  return (LOG_KINDS as readonly string[]).includes(value);
}

export function journalDir(project: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = project.replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  return join(env.ORCH_STATE || stateDir(), "missions", safe);
}

export function journalPath(project: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(journalDir(project, env), "log.jsonl");
}

export function oneLine(value: string, cap = 400): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, cap);
}

export function parseLog(raw: string): LogEntry[] {
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as Partial<LogEntry>;
      if (!row || typeof row.text !== "string" || typeof row.kind !== "string" || !isLogKind(row.kind)) return [];
      return [{
        at: typeof row.at === "string" ? row.at : "",
        kind: row.kind,
        text: row.text,
        ...(typeof row.session === "string" ? { session: row.session } : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function readLog(project: string, env: NodeJS.ProcessEnv = process.env): LogEntry[] {
  const path = journalPath(project, env);
  if (!existsSync(path)) return [];
  try {
    return parseLog(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function trimLog(entries: LogEntry[]): LogEntry[] {
  let kept = entries.slice(-200);
  let raw = kept.map((e) => JSON.stringify(e)).join("\n");
  while (kept.length > 8 && Buffer.byteLength(raw) > LOG_CAP_BYTES) {
    kept = kept.slice(1);
    raw = kept.map((e) => JSON.stringify(e)).join("\n");
  }
  return kept;
}

export function appendLog(opts: {
  kind: LogKind;
  text: string;
  project: string;
  session?: string | null;
  env?: NodeJS.ProcessEnv;
  at?: string;
}): { ok: true; entry: LogEntry } | { ok: false; reason: string } {
  const text = oneLine(opts.text);
  if (!text) return { ok: false, reason: "empty text" };
  const scan = inspectSecrets(text);
  if (!scan.ok) return { ok: false, reason: `secret: rejected (${scan.kinds.join(",")})` };
  const entry: LogEntry = {
    at: opts.at ?? new Date().toISOString(),
    kind: opts.kind,
    text: scan.text,
    ...(opts.session ? { session: opts.session } : {}),
  };
  const env = opts.env ?? process.env;
  try {
    const path = journalPath(opts.project, env);
    mkdirSync(dirname(path), { recursive: true });
    const next = trimLog([...readLog(opts.project, env), entry]);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${next.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true, entry };
  } catch (error) {
    try {
      appendFileSync(journalPath(opts.project, env), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return { ok: true, entry };
    } catch {
      return { ok: false, reason: error instanceof Error ? error.message : "write failed" };
    }
  }
}

export function recordTool(opts: {
  project: string;
  session?: string | null;
  tool: string;
  summary: string;
  file?: string;
  failed: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    if (opts.failed) {
      appendLog({
        kind: "error",
        text: `${opts.tool} ${opts.summary}`.trim(),
        project: opts.project,
        session: opts.session,
        env: opts.env,
      });
    }
    if (opts.file && /^(Edit|Write|MultiEdit|apply_patch)$/i.test(opts.tool)) {
      appendLog({
        kind: "path",
        text: opts.file,
        project: opts.project,
        session: opts.session,
        env: opts.env,
      });
    }
  } catch { /* fail-open */ }
}
