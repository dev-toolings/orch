// `orch hook statusline --harness claude`: Claude Code's statusLine command.
// Claude pipes the session JSON on stdin; its `rate_limits` (5 h and 7 day
// windows) are saved to <state>/quota-claude.json for the dash, then a short
// line is printed. A statusLine the operator configured in
// ~/.claude/settings.json (or ORCH_STATUSLINE_CHAIN) runs with the same stdin
// and its output comes first, unchanged; orch then adds only the quota
// windows, which that line does not show (model and context would repeat).
// Without a chained line, orch prints model, context and quotas. Never fails:
// a status line must always render something.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir } from "../core/paths.ts";
import { parseClaudeRateLimits, writeClaudeQuotaSnapshot, type ClaudeRateLimits } from "../dash/quota.ts";

const CHAIN_TIMEOUT_MS = 3000;
const CHAINED_ENV = "ORCH_STATUSLINE_CHAINED";
const PARIS_TIME = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

export function isOrchStatusline(command: string): boolean {
  return /\borch["']?\s+(hook\s+)?statusline\b/.test(command);
}

/** The statusLine command to chain: env override, else the user's settings.json one (never orch's own). */
export function chainedStatuslineCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  // Set for the chained command: a wrapper that calls orch again never re-chains.
  if (env[CHAINED_ENV] === "1") return null;
  const override = env.ORCH_STATUSLINE_CHAIN?.trim();
  if (override) return isOrchStatusline(override) ? null : override;
  const home = env.HOME;
  if (!home) return null;
  const settings = join(home, ".claude", "settings.json");
  if (!existsSync(settings)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as { statusLine?: { type?: string; command?: string } };
    const line = parsed?.statusLine;
    if (line?.type !== "command" || typeof line.command !== "string" || !line.command.trim()) return null;
    return isOrchStatusline(line.command) ? null : line.command;
  } catch {
    return null;
  }
}

function resetLabel(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? ` ↺${PARIS_TIME.format(new Date(t))}` : "";
}

function quotaParts(limits: ClaudeRateLimits | null): string[] {
  const parts: string[] = [];
  if (limits?.five_hour) parts.push(`5h ${Math.round(limits.five_hour.used_percentage)}%${resetLabel(limits.five_hour.resets_at)}`);
  if (limits?.seven_day) parts.push(`7j ${Math.round(limits.seven_day.used_percentage)}%${resetLabel(limits.seven_day.resets_at)}`);
  return parts;
}

export function statuslineText(input: Record<string, unknown> | null, limits: ClaudeRateLimits | null): string {
  const parts: string[] = [];
  const model = input?.model as { display_name?: unknown } | undefined;
  if (typeof model?.display_name === "string" && model.display_name) parts.push(model.display_name);
  const ctx = input?.context_window as { used_percentage?: unknown } | undefined;
  if (typeof ctx?.used_percentage === "number") parts.push(`ctx ${Math.round(ctx.used_percentage)}%`);
  parts.push(...quotaParts(limits));
  return parts.length ? parts.join(" · ") : "orch";
}

export function runStatusline(raw: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  let input: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { /* render the bare line */ }
  const limits = parseClaudeRateLimits(input);
  if (limits) {
    try { writeClaudeQuotaSnapshot(env.ORCH_STATE || stateDir(), limits, now); } catch { /* best effort */ }
  }
  const chained = chainedStatuslineCommand(env);
  if (chained) {
    try {
      const out = spawnSync("sh", ["-c", chained], { input: raw, encoding: "utf8", env: { ...env, [CHAINED_ENV]: "1" }, timeout: CHAIN_TIMEOUT_MS });
      const text = (out.stdout ?? "").replace(/\s+$/, "");
      if (text) {
        const quota = quotaParts(limits);
        return quota.length ? `${text}\n${quota.join(" · ")}` : text;
      }
    } catch { /* fall back to orch's own line */ }
  }
  return statuslineText(input, limits);
}
