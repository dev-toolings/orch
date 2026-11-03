// Linux /proc scan for live leads (Kiba). Presence is another source;
// this file merges the two and never puts environ values on the wire.
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HARNESSES, type Harness } from "../core/profile.ts";
import type { DashLane, DashLead, LeadActivity } from "./types.ts";

export interface ProjectOpts {
  labRoot?: string;
  projects?: string[];
  orchRoot?: string;
  home?: string;
}

function activityFor(project: string, lanes: DashLane[], busy = false): LeadActivity {
  const mine = lanes.filter((lane) => lane.project === project);
  if (mine.some((lane) => lane.status === "running")) return "working";
  if (mine.some((lane) => lane.status === "blocked")) return "blocked";
  return busy ? "busy" : "idle";
}

export const DEFAULT_HZ = 100;
const NOISE_COMM = new Set([
  "docker", "dockerd", "containerd", "containerd-shim-runc-v2",
  "containerd-shim", "docker-proxy", "runc", "containerd-shim-runc-v1",
]);

export interface ProcFlags {
  orchLead: boolean;
  orchLane: boolean;
  orchBench: boolean;
  harness?: Harness;
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  cwd: string | null;
  startTicks: number | null;
  flags: ProcFlags;
}

function trimSlash(path: string | undefined): string | undefined {
  return path ? path.replace(/\/+$/, "") || path : undefined;
}

function isGitRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function projectFromCwd(cwd: string, opts: ProjectOpts | string = {}): string {
  const clean = trimSlash(cwd) || cwd;
  const parsed = typeof opts === "string" ? { labRoot: opts } : opts;
  const lab = trimSlash(parsed.labRoot);
  const orch = trimSlash(parsed.orchRoot);
  const home = trimSlash(parsed.home);
  const known = new Set(parsed.projects ?? []);

  if (home && clean === home) return "home";

  if (orch && (clean === orch || clean.startsWith(`${orch}/`))) {
    const rest = clean.slice(orch.length + 1).split("/").filter(Boolean);
    if (rest[0] && rest[1]?.startsWith("wt-")) return rest[0];
    if (rest[0] && known.has(rest[0])) return rest[0];
  }

  let dir = clean;
  while (dir && dir !== "/") {
    const name = basename(dir);
    const underLab = Boolean(lab && (dir === lab || dir.startsWith(`${lab}/`)));
    const git = isGitRoot(dir);
    if (lab && dir === lab) return basename(lab);
    if (underLab && (known.has(name) || git)) return name;
    if (!underLab && git) return name;
    if (home && dir === home) return "home";
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return basename(clean) || "home";
}

function uptimeSec(started: string | null, now: Date): number | null {
  if (!started) return null;
  const ms = now.getTime() - Date.parse(started);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
}

function argValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const name of names) {
      if (a === name) return argv[i + 1];
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
  }
  return undefined;
}

function cValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c" && argv[i + 1]) out.push(argv[i + 1]);
    else if (argv[i].startsWith("-c") && argv[i].length > 2 && argv[i][2] !== "-") out.push(argv[i].slice(2));
  }
  return out;
}

function cPair(argv: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  for (const value of cValues(argv)) {
    if (value.startsWith(prefix)) {
      let raw = value.slice(prefix.length);
      if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1);
      }
      return raw;
    }
  }
  return undefined;
}

// The launcher is the command itself: `kiba`, or `bun [--flag] .../lead.ts`.
// Only the command position counts: `tmux new-session -s kiba` or
// `orch.ts kiba mcp` carry the word as an argument and are not leads.
export function scriptIndex(argv: string[]): number {
  for (let i = 0; i < Math.min(argv.length, 3); i++) {
    if (/(^|\/)(kiba|lead\.ts)$/.test(argv[i])) return i;
    if (i > 0 && !argv[i].startsWith("-")) break;
  }
  return -1;
}

export function isLeadLauncher(argv: string[]): boolean {
  return scriptIndex(argv) >= 0;
}

function binName(argv: string[], comm: string): string {
  return basename(argv[0] ?? comm).replace(/\.exe$/, "");
}

function isClaude(entry: ProcEntry): boolean {
  return binName(entry.argv, entry.comm) === "claude" || entry.comm === "claude";
}

function isCodex(entry: ProcEntry): boolean {
  return binName(entry.argv, entry.comm) === "codex" || entry.comm === "codex";
}

function isGrok(entry: ProcEntry): boolean {
  return binName(entry.argv, entry.comm) === "grok" || entry.comm === "grok";
}

// A lead session: Kiba's prompt file (Claude), or `--agent kiba` (Grok).
export function hasLeadAgent(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--append-system-prompt-file" && /(^|\/)catalog\/kiba\.md$/.test(argv[i + 1] ?? "")) return true;
    if (argv[i] === "--agent" && argv[i + 1] === "kiba") return true;
    if (argv[i] === "--agent=kiba") return true;
  }
  return false;
}

export function isLeadPrompt(argv: string[]): boolean {
  return cValues(argv).some((value) => {
    if (!value.startsWith("developer_instructions=")) return false;
    return value.includes("Who you are") || value.includes("You are Kiba");
  });
}

function launcherHarness(argv: string[]): Harness {
  const i = scriptIndex(argv);
  const next = i >= 0 ? argv[i + 1] : undefined;
  if (next && (HARNESSES as string[]).includes(next)) return next as Harness;
  return "claude";
}

function parseFlags(raw: Buffer | string): ProcFlags {
  const flags: ProcFlags = { orchLead: false, orchLane: false, orchBench: false };
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  for (const entry of text.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (key === "ORCH_LEAD" && value === "1") flags.orchLead = true;
    else if (key === "ORCH_LANE" && value === "1") flags.orchLane = true;
    else if (key === "ORCH_BENCH_RUN" && value) flags.orchBench = true;
    else if (key === "ORCH_HARNESS" && (HARNESSES as string[]).includes(value)) flags.harness = value as Harness;
  }
  return flags;
}

export function parseProcStat(raw: string): { pid: number; comm: string; ppid: number; starttime: number } | null {
  const m = /^(\d+) \((.*)\) ([A-Za-z]) (\d+) ([\s\S]*)$/.exec(raw.trim());
  if (!m) return null;
  const rest = m[5].trim().split(/\s+/);
  const starttime = Number(rest[17]);
  if (!Number.isInteger(starttime) || starttime < 0) return null;
  return { pid: Number(m[1]), comm: m[2], ppid: Number(m[4]), starttime };
}

export function readBtime(procRoot: string): number | null {
  try {
    const raw = readFileSync(join(procRoot, "stat"), "utf8");
    const line = raw.split("\n").find((row) => row.startsWith("btime "));
    const n = Number(line?.slice(6));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readArgv(dir: string): string[] {
  try {
    return readFileSync(join(dir, "cmdline")).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function readCwd(dir: string): string | null {
  try {
    return readlinkSync(join(dir, "cwd"));
  } catch {
    return null;
  }
}

function readComm(dir: string, fallback: string): string {
  try {
    return readFileSync(join(dir, "comm"), "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

function readFlags(dir: string): ProcFlags {
  try {
    return parseFlags(readFileSync(join(dir, "environ")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
      return { orchLead: false, orchLane: false, orchBench: false };
    }
    return { orchLead: false, orchLane: false, orchBench: false };
  }
}

export function listProc(procRoot: string): ProcEntry[] {
  if (!existsSync(procRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const out: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(procRoot, name);
    const rawStat = (() => {
      try { return readFileSync(join(dir, "stat"), "utf8"); } catch { return ""; }
    })();
    const parsed = rawStat ? parseProcStat(rawStat) : null;
    const pid = parsed?.pid ?? Number(name);
    const argv = readArgv(dir);
    const comm = readComm(dir, parsed?.comm ?? argv[0] ?? name);
    out.push({
      pid,
      ppid: parsed?.ppid ?? 0,
      comm,
      argv,
      cwd: readCwd(dir),
      startTicks: parsed?.starttime ?? null,
      flags: readFlags(dir),
    });
  }
  return out;
}

export function isNoise(entry: ProcEntry): boolean {
  if (NOISE_COMM.has(entry.comm) || NOISE_COMM.has(binName(entry.argv, entry.comm))) return true;
  if (entry.flags.orchBench || entry.flags.orchLane) return true;
  if (entry.argv.some((a) => a === "app-server" || a.endsWith("/app-server"))) return true;
  const bin = binName(entry.argv, entry.comm);
  if (bin.includes("remote-control") || entry.comm.includes("remote-control")) return true;
  if (entry.cwd && (entry.cwd.startsWith("/var/lib/docker") || entry.cwd.startsWith("/run/docker"))) return true;
  return false;
}

export function isHarnessLead(entry: ProcEntry): boolean {
  if (isLeadLauncher(entry.argv)) return true;
  if ((isClaude(entry) || isGrok(entry)) && hasLeadAgent(entry.argv)) return true;
  if (isCodex(entry) && isLeadPrompt(entry.argv)) return true;
  return false;
}

export function isLeadCandidate(entry: ProcEntry, launchers: Set<number>): boolean {
  if (isNoise(entry)) return false;
  if (isHarnessLead(entry)) return true;
  if (isCodex(entry) && launchers.has(entry.ppid)) return true;
  return false;
}

function isLauncherKind(entry: ProcEntry): boolean {
  return isLeadLauncher(entry.argv) && !hasLeadAgent(entry.argv) && !isLeadPrompt(entry.argv);
}

function harnessOf(entry: ProcEntry): Harness {
  if (entry.flags.harness) return entry.flags.harness;
  if (isLeadLauncher(entry.argv)) return launcherHarness(entry.argv);
  if (isCodex(entry)) return "codex";
  if (isGrok(entry)) return "grok";
  if (isClaude(entry)) return "claude";
  return "claude";
}

function permissionOf(argv: string[]): string | null {
  if (argv.includes("--yolo") || argv.some((a) => a === "--yolo=true")) return "yolo";
  return argValue(argv, ["--permission-mode"]) ?? null;
}

function modelOf(argv: string[]): string {
  return argValue(argv, ["--model", "-m"]) ?? cPair(argv, "model") ?? "—";
}

function effortOf(argv: string[]): string {
  return argValue(argv, ["--effort", "--reasoning-effort"])
    ?? cPair(argv, "model_reasoning_effort")
    ?? "—";
}

function startedOf(entry: ProcEntry, btime: number | null, hz: number): string | null {
  if (entry.startTicks == null || btime == null || hz <= 0) return null;
  const sec = btime + entry.startTicks / hz;
  const ms = Math.floor(sec * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function descendantOf(pid: number, roots: Set<number>, parents: Map<number, number>): boolean {
  let cur = parents.get(pid) ?? 0;
  const seen = new Set<number>();
  while (cur && !seen.has(cur)) {
    if (roots.has(cur)) return true;
    seen.add(cur);
    cur = parents.get(cur) ?? 0;
  }
  return false;
}

function highestLead(pid: number, leadPids: Set<number>, parents: Map<number, number>): number {
  let top = leadPids.has(pid) ? pid : 0;
  let cur = parents.get(pid) ?? 0;
  const seen = new Set<number>([pid]);
  while (cur && !seen.has(cur)) {
    if (leadPids.has(cur)) top = cur;
    seen.add(cur);
    cur = parents.get(cur) ?? 0;
  }
  return top || pid;
}

export function assignLeadIds(leads: DashLead[]): DashLead[] {
  const counts = new Map<string, number>();
  for (const lead of leads) counts.set(lead.project, (counts.get(lead.project) ?? 0) + 1);
  return leads.map((lead) => ({
    ...lead,
    id: (counts.get(lead.project) ?? 0) > 1 && lead.pid
      ? `kiba:${lead.project}#${lead.pid}`
      : `kiba:${lead.project}`,
  }));
}

function sortLeads(leads: DashLead[]): DashLead[] {
  return [...leads].sort((a, b) => {
    if (a.supervised !== b.supervised) return a.supervised ? -1 : 1;
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    return (a.pid ?? 0) - (b.pid ?? 0);
  });
}

interface Found {
  lead: DashLead;
  ppid: number;
  kind: "harness" | "launcher";
}

function toLead(entry: ProcEntry, opts: {
  project: ProjectOpts;
  now: Date;
  btime: number | null;
  hz: number;
  lanes: DashLane[];
}): Found | null {
  const cwd = entry.cwd;
  if (!cwd && !isLeadLauncher(entry.argv) && !hasLeadAgent(entry.argv) && !isLeadPrompt(entry.argv)) {
    return null;
  }
  const project = cwd ? projectFromCwd(cwd, opts.project) : "unknown";
  const started = startedOf(entry, opts.btime, opts.hz);
  const harness = harnessOf(entry);
  const lead: DashLead = {
    id: `kiba:${project}`,
    project,
    pid: entry.pid,
    harness,
    model: modelOf(entry.argv),
    effort: effortOf(entry.argv),
    permissionMode: permissionOf(entry.argv),
    started,
    uptimeSec: uptimeSec(started, opts.now),
    remoteControl: entry.argv.includes("--remote-control") || entry.argv.some((a) => a.startsWith("--remote-control=")),
    supervised: false,
    cwd: cwd ?? "",
    activity: activityFor(project, opts.lanes),
  };
  return { lead, ppid: entry.ppid, kind: isLauncherKind(entry) ? "launcher" : "harness" };
}

// Children a lead keeps for its whole life (MCP servers, the Remote Control
// bridge): their presence says nothing about work in progress.
export function isServer(entry: Pick<ProcEntry, "argv" | "comm">): boolean {
  const line = [entry.comm, ...entry.argv].join(" ");
  return /(^|[\s/_-])mcp($|[\s_-])|mcp-server|\/remote\/srv\/|--bridge|--serve\b/.test(line);
}

function preferFound(a: Found, b: Found): Found {
  if (a.kind !== b.kind) return a.kind === "harness" ? a : b;
  const score = (f: Found) => (f.lead.model !== "—" ? 1 : 0) + (f.lead.permissionMode ? 1 : 0) + (f.lead.effort !== "—" ? 1 : 0);
  return score(a) >= score(b) ? a : b;
}

export function leadsFromProc(opts: {
  procRoot?: string | null;
  labRoot?: string;
  projects?: string[];
  orchRoot?: string;
  home?: string;
  now?: Date;
  lanes?: DashLane[];
  hz?: number;
  btime?: number | null;
  // busy/idle from the lead's hooks (src/core/lead-pulse.ts), by pid.
  pulse?: (pid: number) => "busy" | "idle" | null;
} = {}): { leads: DashLead[]; parents: Map<number, number> } {
  const procRoot = opts.procRoot === undefined ? "/proc" : opts.procRoot;
  const parents = new Map<number, number>();
  if (!procRoot || !existsSync(procRoot)) return { leads: [], parents };
  const now = opts.now ?? new Date();
  const hz = opts.hz ?? DEFAULT_HZ;
  const btime = opts.btime === undefined ? readBtime(procRoot) : opts.btime;
  const project: ProjectOpts = {
    labRoot: opts.labRoot,
    projects: opts.projects,
    orchRoot: opts.orchRoot,
    home: opts.home,
  };
  const entries = listProc(procRoot);
  for (const entry of entries) parents.set(entry.pid, entry.ppid);
  const launchers = new Set(entries.filter((e) => !isNoise(e) && isLeadLauncher(e.argv)).map((e) => e.pid));
  const found: Found[] = [];
  for (const entry of entries) {
    if (!isLeadCandidate(entry, launchers)) continue;
    const row = toLead(entry, { project, now, btime, hz, lanes: opts.lanes ?? [] });
    if (row) found.push(row);
  }
  const leadPids = new Set(found.flatMap((row) => row.lead.pid == null ? [] : [row.lead.pid]));
  const groups = new Map<number, Found[]>();
  for (const row of found) {
    const pid = row.lead.pid ?? 0;
    const root = highestLead(pid, leadPids, parents);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }
  const leads: DashLead[] = [];
  for (const [root, group] of groups) {
    const best = group.reduce(preferFound);
    const groupPids = new Set(group.flatMap((row) => row.lead.pid == null ? [] : [row.lead.pid]));
    const pulse = opts.pulse ? [root, ...groupPids].map((pid) => opts.pulse!(pid)).find((p) => p != null) ?? null : null;
    const busy = pulse != null
      ? pulse === "busy"
      : entries.some((entry) => !groupPids.has(entry.pid) && !isServer(entry) && descendantOf(entry.pid, new Set([root]), parents));
    leads.push({
      ...best.lead,
      activity: activityFor(best.lead.project, opts.lanes ?? [], busy),
    });
  }
  return { leads, parents };
}

export function mergeLeads(opts: {
  presence: DashLead[];
  proc: DashLead[];
  parents?: Map<number, number>;
  presencePids?: Array<number | null>;
  procScanned?: boolean;
}): DashLead[] {
  const parents = opts.parents ?? new Map<number, number>();
  const roots = new Set((opts.presencePids ?? opts.presence.map((l) => l.pid)).filter((n): n is number => n != null && n > 0));
  const used = new Set<number>();
  const out: DashLead[] = [];

  const takeProc = (lead: DashLead, extra: Partial<DashLead>): void => {
    if (lead.pid) used.add(lead.pid);
    out.push({ ...lead, ...extra, supervised: extra.supervised ?? lead.supervised });
  };

  const matchScore = (present: DashLead, row: DashLead): number => {
    if (row.pid && used.has(row.pid)) return -1;
    let score = 0;
    if (present.pid && row.pid === present.pid) score += 1000;
    if (row.pid && roots.size && descendantOf(row.pid, roots, parents)) score += 700;
    if (row.project === present.project) score += 120;
    if (row.cwd && present.cwd && row.cwd === present.cwd) score += 80;
    if (!row.cwd || !present.cwd) score += 10;
    if (row.harness === present.harness) score += 20;
    return score;
  };

  for (const present of opts.presence) {
    const ranked = opts.proc
      .map((row) => ({ row, score: matchScore(present, row) }))
      .filter((entry) => entry.score >= 120)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.row.pid ?? Number.MAX_SAFE_INTEGER) - (b.row.pid ?? Number.MAX_SAFE_INTEGER);
      });
    const match = ranked[0]?.row;
    if (match) {
      takeProc(match, {
        supervised: true,
        remoteControl: present.remoteControl || match.remoteControl,
        started: present.started ?? match.started,
        uptimeSec: present.started ? present.uptimeSec : match.uptimeSec,
        model: match.model !== "—" ? match.model : present.model,
        effort: match.effort !== "—" ? match.effort : present.effort,
        permissionMode: match.permissionMode ?? present.permissionMode,
        cwd: match.cwd || present.cwd,
        harness: match.harness || present.harness,
        activity: present.activity === "working" || present.activity === "blocked"
          ? present.activity
          : match.activity === "busy" ? "busy" : present.activity,
      });
    } else if (!opts.procScanned) {
      // No /proc to check against (tests, another OS): the supervisor's word.
      out.push({ ...present, supervised: true });
      if (present.pid) used.add(present.pid);
    }
    // With /proc and no living lead process, the session is not a lead: a
    // dead or restarting lead never shows as active.
  }

  for (const row of opts.proc) {
    if (row.pid && used.has(row.pid)) continue;
    if (row.pid && roots.size && descendantOf(row.pid, roots, parents) && out.some((l) => l.project === row.project && l.supervised)) {
      continue;
    }
    out.push({ ...row, supervised: false });
    if (row.pid) used.add(row.pid);
  }

  return assignLeadIds(sortLeads(out));
}

export function discoverLeads(opts: {
  presence?: DashLead[];
  presencePids?: Array<number | null>;
  procRoot?: string | null;
  labRoot?: string;
  projects?: string[];
  orchRoot?: string;
  home?: string;
  now?: Date;
  lanes?: DashLane[];
  hz?: number;
  pulse?: (pid: number) => "busy" | "idle" | null;
} = {}): DashLead[] {
  const scanned = leadsFromProc({
    procRoot: opts.procRoot,
    labRoot: opts.labRoot,
    projects: opts.projects,
    orchRoot: opts.orchRoot,
    home: opts.home,
    now: opts.now,
    lanes: opts.lanes,
    hz: opts.hz,
    pulse: opts.pulse,
  });
  const procRoot = opts.procRoot === undefined ? "/proc" : opts.procRoot;
  return mergeLeads({
    presence: opts.presence ?? [],
    proc: scanned.leads,
    parents: scanned.parents,
    presencePids: opts.presencePids,
    procScanned: Boolean(procRoot && existsSync(procRoot)),
  });
}
