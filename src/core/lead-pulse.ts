// Live lead registry under <state dir>/leads/, single writer per file:
//   launch-<pid>.json  written by the lead launcher (src/lead.ts) before it
//                      starts Claude: code revision, model, effort, cwd.
//                      Records of older launchers also name a Codex or Grok
//                      harness, the conductor or presence. `orch install` and
//                      `orch doctor` compare it with the checkout to say
//                      which running lead needs a restart.
//   pulse-<pid>.json   written by the lead's own hooks (busy on a prompt,
//                      idle on Stop), keyed by the launcher pid
//                      (ORCH_LEAD_PID): the atelier's busy/idle signal,
//                      plus the session's live permission mode, which the
//                      integration gate reads (unattendedLeadMode).
// A record whose process is gone is ignored, never trusted: status comes
// from the living process first.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";

export interface LaunchRecord {
  pid: number;
  harness: string;
  conductor: string;
  execution?: "native" | "conductor";
  rev: string | null;
  model: string | null;
  effort: string | null;
  cwd: string;
  started: string;
  presence: boolean;
}

export interface Pulse { state: "busy" | "idle"; at: string; mode?: string }

export const leadsDir = (state = stateDir()) => join(state, "leads");

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function codeRevision(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function recordLaunch(rec: LaunchRecord, state = stateDir()): void {
  writeJson(join(leadsDir(state), `launch-${rec.pid}.json`), rec);
}

export function writePulse(leadPid: number, value: Pulse["state"], state = stateDir(), now = new Date(), mode?: string): void {
  if (!Number.isInteger(leadPid) || leadPid <= 0) return;
  writeJson(join(leadsDir(state), `pulse-${leadPid}.json`), { state: value, at: now.toISOString(), ...(mode ? { mode } : {}) } satisfies Pulse);
}

export function readPulse(leadPid: number, state = stateDir()): Pulse | null {
  return readJson<Pulse>(join(leadsDir(state), `pulse-${leadPid}.json`));
}

// Claude permission modes in which the operator lets the lead act without
// asking (operator's call, 2026-11-02): only there may a lane land on the
// default branch. Fail-closed: a dead lead, no pulse or no mode is null.
const UNATTENDED_MODES = new Set(["bypassPermissions", "auto"]);
export function unattendedLeadMode(leadPid: number, state = stateDir(), alive = pidAlive): string | null {
  if (!Number.isInteger(leadPid) || !alive(leadPid)) return null;
  const mode = readPulse(leadPid, state)?.mode;
  return mode && UNATTENDED_MODES.has(mode) ? mode : null;
}

// Launch records of living leads; records of dead ones are removed with
// their pulse (the lead is gone, so is its status).
export function liveLaunches(state = stateDir(), alive = pidAlive): LaunchRecord[] {
  const dir = leadsDir(state);
  if (!existsSync(dir)) return [];
  const out: LaunchRecord[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^launch-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const rec = readJson<LaunchRecord>(join(dir, name));
    if (rec && alive(rec.pid)) { out.push(rec); continue; }
    rmSync(join(dir, name), { force: true });
    rmSync(join(dir, `pulse-${m[1]}.json`), { force: true });
  }
  return out;
}

// Why a running lead runs older code or settings than the checkout now
// holds, or null when it is current.
export function staleReason(rec: LaunchRecord, current: { rev: string | null; model?: string | null; effort?: string | null }): string | null {
  const why: string[] = [];
  if (current.rev && rec.rev !== current.rev) why.push(`code ${rec.rev ? rec.rev.slice(0, 7) : "unknown"} -> ${current.rev.slice(0, 7)}`);
  if (current.model && rec.model !== current.model) why.push(`model ${rec.model ?? "?"} -> ${current.model}`);
  if (current.effort && rec.effort !== current.effort) why.push(`effort ${rec.effort ?? "?"} -> ${current.effort}`);
  return why.length ? why.join(", ") : null;
}
