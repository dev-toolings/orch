import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import pino, { type Logger } from "pino";
import { foldProviderUsageIntoCache } from "../dash/providers-live.ts";
import { loadPolicy, resolveLogsPolicy } from "../core/policy.ts";
import { stateDir } from "../core/paths.ts";

export interface PruneSummary {
  provider: "codex" | "grok";
  scanned: number;
  keptOpen: number;
  keptLead: number;
  keptNewest: number;
  deleted: number;
  bytesFreed: number;
}

// orch's own run folders under the state dir: one entry per review, contest
// or ask, kept for the logs retention like the harness logs.
export const STATE_RUN_DIRS = ["contests", "reviews", "asks"] as const;

export interface StateRunSummary { dir: (typeof STATE_RUN_DIRS)[number]; scanned: number; deleted: number; bytesFreed: number }

export interface PruneResult {
  dryRun: boolean;
  days: number;
  totalDeleted: number;
  totalBytesFreed: number;
  providers: PruneSummary[];
  stateRuns: StateRunSummary[];
}

function treeBytes(path: string): number {
  const st = safeStat(path);
  if (!st) return 0;
  if (!st.isDirectory()) return Number(st.size);
  return safeReaddir(path).reduce((n, name) => n + treeBytes(join(path, name)), 0);
}

// Entries of the run folders last touched before the cutoff. An entry's own
// mtime moves when a file is added or removed in it: a run still writing is
// never older than the retention.
function pruneStateRuns(state: string, cutoff: number, dryRun: boolean, log: Logger): StateRunSummary[] {
  return STATE_RUN_DIRS.map((dir) => {
    const root = join(state, dir);
    const sum: StateRunSummary = { dir, scanned: 0, deleted: 0, bytesFreed: 0 };
    for (const name of safeReaddir(root)) {
      const full = join(root, name);
      const st = safeStat(full);
      if (!st) continue;
      sum.scanned++;
      if (st.mtimeMs >= cutoff) continue;
      sum.bytesFreed += treeBytes(full);
      sum.deleted++;
      log.info({ dir, entry: name, dryRun }, dryRun ? "would prune state run" : "pruning state run");
      if (!dryRun) rmSync(full, { recursive: true, force: true });
    }
    return sum;
  });
}

interface Candidate {
  provider: "codex" | "grok";
  file: string;
  mtimeMs: number;
  size: number;
  projectKey: string;
}

interface PruneDeps {
  now?: Date;
  home?: string;
  state?: string;
  procRoot?: string;
  logger?: Logger;
  listOpenFiles?: () => Set<string>;
  listLeadFiles?: () => Set<string>;
}

const SKIP_ERRORS = new Set(["EACCES", "ENOENT", "ELOOP", "EPERM", "ENOTDIR"]);

function canSkipFs(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && SKIP_ERRORS.has(code);
}

function hmToOnCalendar(hm: string): string {
  const [hh, mm] = hm.split(":");
  return `*-*-* ${hh}:${mm}:00 Europe/Paris`;
}

export function logsPruneUnits(pruneAtHm = "12:00"): { name: string; content: string }[] {
  return [
    {
      name: "orch-logs-prune.service",
      content: `[Unit]
Description=orch logs prune

[Service]
Type=oneshot
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/orch logs prune
`,
    },
    {
      name: "orch-logs-prune.timer",
      content: `[Unit]
Description=orch logs prune daily (${pruneAtHm} Europe/Paris)

[Timer]
OnCalendar=${hmToOnCalendar(pruneAtHm)}
Persistent=true
Unit=orch-logs-prune.service

[Install]
WantedBy=timers.target
`,
    },
  ];
}

function mkLogger(): Logger {
  return pino({ name: "logs-prune", level: process.env.LOG_LEVEL ?? "info" }, pino.destination(1));
}

function safeReaddir(path: string): string[] {
  try { return readdirSync(path); } catch (error) {
    if (canSkipFs(error)) return [];
    throw error;
  }
}

function safeReaddirDirs(path: string): string[] {
  return safeReaddir(path).filter((name) => {
    try { return lstatSync(join(path, name)).isDirectory(); } catch (error) {
      if (canSkipFs(error)) return false;
      throw error;
    }
  });
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch (error) {
    if (canSkipFs(error)) return null;
    throw error;
  }
}

function inferProjectFromContent(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes("cwd") && !line.includes("project")) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const payload = row?.payload ?? row;
      const info = payload?.info ?? row?.info ?? {};
      const cwd = row?.cwd ?? payload?.cwd ?? info?.cwd ?? info?.current_working_directory ?? row?.project_path;
      if (typeof cwd === "string" && cwd.trim()) return basename(cwd.replace(/\/+$/, ""));
      const project = row?.project ?? payload?.project ?? info?.project;
      if (typeof project === "string" && project.trim()) return project.trim();
    }
  } catch { /* ignore */ }
  return null;
}

function codexCandidates(home: string, olderThanMs: number): Candidate[] {
  const out: Candidate[] = [];
  const root = join(home, ".codex", "sessions");
  if (!existsSync(root)) return out;
  for (const yyyy of safeReaddirDirs(root)) {
    const yDir = join(root, yyyy);
    for (const mm of safeReaddirDirs(yDir)) {
      const mDir = join(yDir, mm);
      for (const dd of safeReaddirDirs(mDir)) {
        const dDir = join(mDir, dd);
        for (const name of safeReaddir(dDir)) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const file = join(dDir, name);
          const st = safeStat(file);
          if (!st || !st.isFile()) continue;
          if (st.mtimeMs >= olderThanMs) continue;
          out.push({
            provider: "codex",
            file,
            mtimeMs: Number(st.mtimeMs),
            size: Number(st.size),
            projectKey: inferProjectFromContent(file) ?? `${yyyy}-${mm}-${dd}`,
          });
        }
      }
    }
  }
  return out;
}

function walkGrok(root: string, depth: number, out: string[]): void {
  if (depth > 5) return;
  for (const name of safeReaddir(root)) {
    if (name.startsWith("sandbox-blocked")) continue;
    const full = join(root, name);
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(full); } catch (error) {
      if (canSkipFs(error)) continue;
      throw error;
    }
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walkGrok(full, depth + 1, out);
      continue;
    }
    if (st.isFile() && full.endsWith(".jsonl")) out.push(full);
  }
}

function grokCandidates(home: string, olderThanMs: number): Candidate[] {
  const out: Candidate[] = [];
  for (const root of [join(home, ".grok", "sessions"), join(home, ".grok", "logs")]) {
    if (!existsSync(root)) continue;
    const files: string[] = [];
    walkGrok(root, 0, files);
    for (const file of files) {
      const st = safeStat(file);
      if (!st || !st.isFile()) continue;
      if (st.mtimeMs >= olderThanMs) continue;
      out.push({
        provider: "grok",
        file,
            mtimeMs: Number(st.mtimeMs),
            size: Number(st.size),
        projectKey: inferProjectFromContent(file) ?? basename(dirname(file)),
      });
    }
  }
  return out;
}

function listOpenFilesFromProc(procRoot: string): Set<string> {
  const out = new Set<string>();
  for (const pid of safeReaddir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    const fdDir = join(procRoot, pid, "fd");
    for (const fd of safeReaddir(fdDir)) {
      const link = join(fdDir, fd);
      try {
        const target = readlinkSync(link);
        if (target.startsWith("/")) out.add(target);
      } catch (error) {
        if (canSkipFs(error)) continue;
      }
    }
  }
  return out;
}

function listLeadSessionFilesFromProc(procRoot: string, home: string): Set<string> {
  const out = new Set<string>();
  for (const pid of safeReaddir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    const environPath = join(procRoot, pid, "environ");
    const cmdPath = join(procRoot, pid, "cmdline");
    let envRaw = "";
    let cmdRaw = "";
    try { envRaw = readFileSync(environPath, "utf8"); } catch { continue; }
    if (!envRaw.includes("ORCH_LEAD=1")) continue;
    try { cmdRaw = readFileSync(cmdPath, "utf8"); } catch { continue; }
    for (const token of cmdRaw.split("\0")) {
      if (!token.startsWith(home)) continue;
      if (!token.includes("/.codex/sessions/") && !token.includes("/.grok/")) continue;
      out.add(token);
    }
  }
  return out;
}

function keepNewestPerProject(rows: Candidate[]): Set<string> {
  const winner = new Map<string, Candidate>();
  for (const row of rows) {
    const cur = winner.get(`${row.provider}:${row.projectKey}`);
    if (!cur || row.mtimeMs > cur.mtimeMs) winner.set(`${row.provider}:${row.projectKey}`, row);
  }
  return new Set([...winner.values()].map((row) => row.file));
}

function removeEmptyParents(path: string, stopAt: string): void {
  let cur = dirname(path);
  const stopNorm = stopAt.replace(/\/+$/, "");
  while (cur.startsWith(stopNorm) && cur.length >= stopNorm.length) {
    if (cur === stopNorm) break;
    try {
      if (readdirSync(cur).length > 0) break;
      rmSync(cur, { recursive: false, force: false });
      cur = dirname(cur);
    } catch {
      break;
    }
  }
}

export function ensureClaudeCleanupSettings(opts: {
  home?: string;
  days: number;
  dryRun?: boolean;
  now?: Date;
}): { changed: boolean; backupPath?: string; path: string } {
  const home = opts.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? homedir();
  const file = join(home, ".claude", "settings.json");
  const now = opts.now ?? new Date();
  let current: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(file)) {
    existed = true;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  if (current.cleanupPeriodDays === opts.days) return { changed: false, path: file };
  const next = { ...current, cleanupPeriodDays: opts.days };
  if (opts.dryRun) return { changed: true, path: file };
  mkdirSync(dirname(file), { recursive: true });
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${file}.bak-orch-${now.toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(backupPath, readFileSync(file, "utf8"));
  }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed: true, backupPath, path: file };
}

export function pruneHarnessLogs(opts: {
  days?: number;
  dryRun?: boolean;
  deps?: PruneDeps;
} = {}): PruneResult {
  const deps = opts.deps ?? {};
  const now = deps.now ?? new Date();
  const home = deps.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? homedir();
  const state = deps.state ?? stateDir();
  const dryRun = opts.dryRun ?? false;
  const policy = resolveLogsPolicy(loadPolicy());
  const days = opts.days ?? policy.retention_days;
  if (!Number.isInteger(days) || days < 1) throw new Error("logs prune: --days must be a positive integer");
  const log = deps.logger ?? mkLogger();
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const procRoot = deps.procRoot ?? "/proc";
  const open = deps.listOpenFiles?.() ?? listOpenFilesFromProc(procRoot);
  const leadProtected = deps.listLeadFiles?.() ?? listLeadSessionFilesFromProc(procRoot, home);
  const candidates = [...codexCandidates(home, cutoff), ...grokCandidates(home, cutoff)];
  const newest = keepNewestPerProject(candidates);
  const summaries = new Map<"codex" | "grok", PruneSummary>([
    ["codex", { provider: "codex", scanned: 0, keptOpen: 0, keptLead: 0, keptNewest: 0, deleted: 0, bytesFreed: 0 }],
    ["grok", { provider: "grok", scanned: 0, keptOpen: 0, keptLead: 0, keptNewest: 0, deleted: 0, bytesFreed: 0 }],
  ]);
  for (const row of candidates) {
    const s = summaries.get(row.provider)!;
    s.scanned++;
    const full = row.file;
    if (open.has(full)) { s.keptOpen++; continue; }
    if ([...leadProtected].some((p) => full.startsWith(p) || p.startsWith(full))) { s.keptLead++; continue; }
    if (newest.has(full)) { s.keptNewest++; continue; }
    if (!dryRun) foldProviderUsageIntoCache({ provider: row.provider, path: full, home, state, now });
    log.info({ provider: row.provider, file: full, dryRun }, dryRun ? "would prune harness log" : "pruning harness log");
    s.bytesFreed += row.size;
    s.deleted++;
    if (!dryRun) {
      rmSync(full, { force: true });
      const stopAt = row.provider === "codex" ? join(home, ".codex", "sessions") : (full.includes("/.grok/sessions/") ? join(home, ".grok", "sessions") : join(home, ".grok", "logs"));
      removeEmptyParents(full, stopAt);
    }
  }
  const providers = [...summaries.values()];
  const stateRuns = pruneStateRuns(state, cutoff, dryRun, log);
  return {
    dryRun,
    days,
    totalDeleted: providers.reduce((n, p) => n + p.deleted, 0) + stateRuns.reduce((n, r) => n + r.deleted, 0),
    totalBytesFreed: providers.reduce((n, p) => n + p.bytesFreed, 0) + stateRuns.reduce((n, r) => n + r.bytesFreed, 0),
    providers,
    stateRuns,
  };
}

export function formatPruneResult(result: PruneResult): string {
  const lines = [
    `logs prune: ${result.dryRun ? "dry-run" : "done"} (${result.days} days)`,
    ...result.providers.map((p) => `${p.provider}: scanned ${p.scanned}, deleted ${p.deleted}, kept(open ${p.keptOpen}, lead ${p.keptLead}, newest ${p.keptNewest}), freed ${p.bytesFreed} B`),
    ...(result.stateRuns ?? []).map((r) => `state ${r.dir}: scanned ${r.scanned}, deleted ${r.deleted}, freed ${r.bytesFreed} B`),
    `total: deleted ${result.totalDeleted}, freed ${result.totalBytesFreed} B`,
  ];
  return `${lines.join("\n")}\n`;
}
