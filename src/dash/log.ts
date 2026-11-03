import pino, { type DestinationStream, type Logger } from "pino";

const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?key)/i;
const SECRET_TEXT = /(sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{10,}|api[_-]?key\s*[:=]\s*[^\s,;]+)/gi;

const LEVEL_LABEL: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO ",
  40: "WARN ",
  50: "ERROR",
  60: "FATAL",
};

export interface DashLogEnv {
  LOG_LEVEL?: string;
  LOG_FORMAT?: string;
  NO_COLOR?: string;
}

export interface DashLoggerOptions {
  env?: DashLogEnv;
  isTTY?: boolean;
  destination?: DestinationStream;
}

export function sanitizeForLog(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeForLog(v, k);
  }
  return out;
}

function hhmmss(input?: unknown): string {
  const time = typeof input === "number" ? input : Date.now();
  const d = new Date(time);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function colorize(level: string, enabled: boolean): string {
  if (!enabled) return level;
  if (level.startsWith("DEBUG")) return `\x1b[36m${level}\x1b[0m`;
  if (level.startsWith("INFO")) return `\x1b[32m${level}\x1b[0m`;
  if (level.startsWith("WARN")) return `\x1b[33m${level}\x1b[0m`;
  if (level.startsWith("ERROR") || level.startsWith("FATAL")) return `\x1b[31m${level}\x1b[0m`;
  return level;
}

export function formatPrettyRecord(record: Record<string, unknown>, useColor = false): string {
  const level = LEVEL_LABEL[Number(record.level ?? 30)] ?? "INFO ";
  const name = String(record.name ?? "dash");
  const msg = typeof record.msg === "string" ? record.msg : "";
  const skip = new Set(["level", "time", "pid", "hostname", "name", "msg"]);
  const rest = Object.entries(record)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${JSON.stringify(sanitizeForLog(v, k))}`)
    .join(" ");
  return `${hhmmss(record.time)} ${colorize(level, useColor)} ${name}  ${msg}${rest ? ` ${rest}` : ""}`;
}

function prettyDestination(useColor: boolean): DestinationStream {
  return {
    write(chunk: string): void {
      const line = chunk.trim();
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        process.stdout.write(`${formatPrettyRecord(parsed, useColor)}\n`);
      } catch {
        process.stdout.write(`${line}\n`);
      }
    },
  };
}

export function createDashLogger(component: string, opts: DashLoggerOptions = {}): Logger {
  const env = opts.env ?? process.env;
  const level = (env.LOG_LEVEL ?? "info").trim().toLowerCase() || "info";
  const tty = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const json = (env.LOG_FORMAT ?? "").trim().toLowerCase() === "json" || !tty;
  const useColor = tty && !json && !env.NO_COLOR;
  const destination = opts.destination ?? (json ? pino.destination(1) : prettyDestination(useColor));
  return pino({
    level,
    base: { name: component },
    timestamp: pino.stdTimeFunctions.epochTime,
    hooks: {
      logMethod(args, method) {
        const safe = args.map((arg) => sanitizeForLog(arg));
        method.apply(this, safe as any);
      },
    },
    formatters: {
      level(label) { return { level: pino.levels.values[label] ?? 30 }; },
    },
  }, destination);
}

