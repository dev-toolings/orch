#!/usr/bin/env -S bun --no-env-file
// Write guard of a lane worker: its file tools write only its worktree. Not
// the temp dirs either: a repository there (a /tmp checkout) is someone's
// work. Bash keeps its sandbox's own rules: for Claude, the worktree, Claude
// Code's own temp dir and the lane's temp dir (its TMPDIR, src/harness/
// harness.ts claudeSandbox); /tmp itself is read-only.
//   blocking   a Claude write worker runs this file as its PreToolUse hook on
//              Edit, Write, MultiEdit and NotebookEdit (`guard.ts <worktree>`,
//              settings from claudeWorkerSettings): a path outside is denied
//              before the tool runs, symlinks and `..` resolved. Bash stays in
//              Claude Code's OS sandbox; Codex and Grok in their own.
//   detection  after the run, lane reads the worker log (outsideWrites): a
//              write that succeeded outside fails the lane, which the
//              integrate gate then refuses. Denied attempts are reported only.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const GUARDED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// Real path of p even when it does not exist yet: the nearest existing
// ancestor is resolved (symlinks), the rest appended.
export function realPath(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    rest.unshift(basename(dir));
    dir = parent;
  }
  let real = dir;
  try { real = realpathSync(dir); } catch {}
  return rest.length ? join(real, ...rest) : real;
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export function writable(path: string, worktree: string, base = worktree): boolean {
  return under(realPath(isAbsolute(path) ? path : join(base, path)), realPath(worktree));
}

// PreToolUse decision for one hook input, or null to let the tool run.
export function guardDecision(input: unknown, worktree: string): string | null {
  const rec = (input && typeof input === "object" ? input : {}) as { tool_name?: unknown; tool_input?: Record<string, unknown> };
  const name = typeof rec.tool_name === "string" ? rec.tool_name : "";
  if (!GUARDED_TOOLS.includes(name)) return null;
  const ti = rec.tool_input ?? {};
  const path = [ti.file_path, ti.notebook_path, ti.path].find((v): v is string => typeof v === "string" && v.length > 0);
  if (!path) return JSON.stringify(deny(`${name} without a file path`));
  if (writable(path, worktree)) return null;
  return JSON.stringify(deny(`lane worker: ${path} is outside the worktree ${worktree}; write only inside it`));
}

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

// Settings of a Claude write worker: the OS sandbox plus this guard.
export function claudeWorkerSettings(worktree: string, sandbox: object, bun = process.execPath): object {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const command = `${q(bun)} --no-env-file ${q(join(import.meta.dir, "guard.ts"))} ${q(worktree)}`;
  return { ...sandbox, hooks: { PreToolUse: [{ matcher: GUARDED_TOOLS.join("|"), hooks: [{ type: "command", command, timeout: 10 }] }] } };
}

export interface Escapes { written: string[]; denied: string[] }

// Writes a worker log shows outside the worktree: `written` succeeded,
// `denied` were refused (by the guard, the permission rules or a sandbox).
export function outsideWrites(harness: string, log: string, worktree: string): Escapes {
  const written = new Set<string>();
  const denied = new Set<string>();
  const pending = new Map<string, string>();
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (harness === "codex") {
      const item = ev?.item;
      if (ev?.type !== "item.completed" || item?.type !== "file_change") continue;
      const failed = item.status === "failed" || item.status === "declined";
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        if (typeof change?.path === "string" && !writable(change.path, worktree)) (failed ? denied : written).add(change.path);
      }
      continue;
    }
    const content = Array.isArray(ev?.message?.content) ? ev.message.content : [];
    for (const block of content) {
      if (ev.type === "assistant" && block?.type === "tool_use" && GUARDED_TOOLS.includes(block.name)) {
        const ti = block.input ?? {};
        const path = [ti.file_path, ti.notebook_path].find((v: unknown): v is string => typeof v === "string");
        if (path && !writable(path, worktree) && typeof block.id === "string") pending.set(block.id, path);
      } else if (ev.type === "user" && block?.type === "tool_result" && pending.has(block.tool_use_id)) {
        (block.is_error ? denied : written).add(pending.get(block.tool_use_id)!);
        pending.delete(block.tool_use_id);
      }
    }
  }
  // A call with no result (run cut short) may have written: count it.
  for (const path of pending.values()) written.add(path);
  return { written: [...written], denied: [...denied].filter((p) => !written.has(p)) };
}

if (import.meta.main) {
  const worktree = process.argv[2];
  let input: unknown = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  // Fail closed: without a worktree to compare against, nothing is written.
  const out = worktree ? guardDecision(input, worktree) : JSON.stringify(deny("lane guard: no worktree given"));
  if (out) process.stdout.write(`${out}\n`);
}
