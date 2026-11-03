// Read-only snapshot for `orch dash`. Same sources as `orch top`, the orch
// serve tasks, the lane ledger and the bus. Tests inject every live dependency.
import { spawnSync } from "node:child_process";
import { defaultBusRoot, loadBusConfig, parseMessage } from "../bus/bus.ts";
import { estimateUsageUsd } from "../core/paid.ts";
import { loadPolicy, readSpend, type ControlPolicy, type SpendEntry } from "../core/policy.ts";
import { costsOf } from "./costs.ts";
import { projectsRoot } from "../core/project.ts";
import { stateDir } from "../core/paths.ts";
import { HARNESSES, loadProfile, ROOT, type Harness, type Profile } from "../core/profile.ts";
import { listLanes, reapDeadLanes, type LaneState } from "../lane.ts";
import { laneBudget, type MachineFigures } from "../lanes/budget.ts";
import { readLedger, type LedgerRow } from "../lanes/ledger.ts";
import { type LaneProgress, readLaneProgress } from "../lanes/progress.ts";
import { claudeProjectsDir, tokensOnDay, tokenUsage, utcDay } from "../ops/usage.ts";
import { listProjectNames, ledgerTokensOnDay } from "../top/top.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { DashSubagent } from "./types.ts";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { detect } from "../harness/registry.ts";
import { discoverLeads } from "./leads.ts";
import { type Pulse, readPulse } from "../core/lead-pulse.ts";
import { tasksDir, TaskStore } from "../core/tasks.ts";
import { kibaProfile } from "../kiba/native.ts";
import { activityOf, enrichLane, NOTE_TEXT_MAX, parseSkillFront, publicLogText, runtimesOf, sanitizeLogs, workingOf } from "./life.ts";
import { applyProviderLive, collectProviderLive, providerLiveFromSummary } from "./providers-live.ts";
import type { ProviderLiveSnapshot, ProviderUsageSummary } from "./providers-live.ts";
import { runningLanes } from "../kiba/live.ts";
import type { DashBusLine, DashBusMailbox, DashBusState, DashLane, DashLaneProgress, DashLead, DashLedgerLine, DashLogLine, DashProject, DashSkill, DashSnapshot, DashTask } from "./types.ts";

const LEDGER_LIMIT = 200;

export function projectOf(repoOrCwd: string): string {
  return basename(repoOrCwd.replace(/\/+$/, "") || repoOrCwd);
}

export function laneActivity(status: string): "running" | "blocked" | "other" {
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  return "other";
}

export function activityFor(project: string, lanes: DashLane[]): DashLead["activity"] {
  const mine = lanes.filter((lane) => lane.project === project);
  if (mine.some((lane) => lane.status === "running")) return "working";
  if (mine.some((lane) => lane.status === "blocked")) return "blocked";
  return "idle";
}

function modelOf(id: string, lane: LaneState, ledger: LedgerRow[]): string {
  if (lane.model) return lane.model;
  const run = [...ledger].reverse().find((row) => row.kind === "run" && row.id === id);
  return run && run.kind === "run" ? run.model : "—";
}

function effortOf(id: string, ledger: LedgerRow[]): string | null {
  const run = [...ledger].reverse().find((row) => row.kind === "run" && row.id === id);
  return run && run.kind === "run" ? run.effort : null;
}

// progress.json is read only for running lanes: a few small files per
// snapshot, never a worker log.
export function dashLanesOf(
  lanes: LaneState[], ledger: LedgerRow[] = [], now = new Date(),
  readProgress: (id: string) => LaneProgress | null = () => null,
): DashLane[] {
  return [...lanes]
    .sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0))
    .map((lane) => {
      const live = lane.status === "running" ? readProgress(lane.id) : null;
      const model = modelOf(lane.id, lane, ledger);
      return {
        ...enrichLane(lane, now),
        model: model === "—" && live?.model ? live.model : model,
        effort: lane.effort ?? effortOf(lane.id, ledger) ?? live?.effort ?? null,
        costUsd: estimateUsageUsd(lane.usage),
        progress: live ? dashProgressOf(live) : null,
      };
    });
}

function dashProgressOf(p: LaneProgress): DashLaneProgress {
  return {
    phase: p.phase, updated: p.updated, turns: p.turns, toolCalls: p.toolCalls,
    lastTool: p.lastTool, lastFile: p.lastFile, filesTouched: p.filesTouched,
    lastText: p.lastText ? publicLogText(p.lastText) : null,
  };
}

export function dashLedgerOf(rows: LedgerRow[], limit = LEDGER_LIMIT): DashLedgerLine[] {
  const out: DashLedgerLine[] = [];
  const runs = new Map<string, Extract<LedgerRow, { kind: "run" }>>();
  for (const row of rows) if (row.kind === "run") runs.set(row.id, row);
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const row = rows[i];
    if (row.kind === "run") {
      out.push({
        id: row.id,
        at: row.at,
        kind: row.kind,
        project: projectOf(row.repo),
        status: row.status,
        model: row.model,
        effort: row.effort,
        costUsd: estimateUsageUsd(row.usage),
        channel: row.channel,
      });
      continue;
    }
    if (row.kind === "outcome") {
      const run = runs.get(row.id);
      out.push({
        id: row.id, at: row.at, kind: row.kind, status: row.outcome,
        ...(run?.repo ? { project: projectOf(run.repo) } : {}),
        ...(run?.to ? { harness: run.to } : {}),
      });
      continue;
    }
    if (row.kind === "gate") {
      out.push({ id: row.id, at: row.at, kind: row.kind, status: "refused" });
      continue;
    }
    if (row.kind === "review") {
      out.push({ id: row.id, at: row.at, kind: row.kind, status: row.verdict, model: row.model, effort: row.effort });
      continue;
    }
    out.push({ id: row.id, at: row.at, kind: row.kind, status: row.verdict });
  }
  return out;
}

const BUS_RECENT = 20;
const SUBJECT_LEN = 80;

export function emptyBus(): DashBusState {
  return {
    active: false,
    mailboxes: [],
    recent: [],
    pending: [],
    rounds: { threads: 0, hops: 0, maxHop: 0, roundTrips: 0 },
  };
}

function busSubject(body: Record<string, unknown> | undefined, fallback: string): string {
  const raw = typeof body?.text === "string" ? body.text
    : typeof body?.escalate === "string" ? body.escalate
    : fallback;
  const text = publicLogText(String(raw).replace(/\s+/g, " "));
  return (text ?? fallback).slice(0, SUBJECT_LEN);
}

function readBox(dir: string, status: string): {
  lines: DashBusLine[];
  valid: number;
  invalid: number;
  hops: Map<string, number>;
} {
  const lines: DashBusLine[] = [];
  const hops = new Map<string, number>();
  let valid = 0;
  let invalid = 0;
  if (!existsSync(dir)) return { lines, valid, invalid, hops };
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(dir, file);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const message = parseMessage(raw);
      if (!message) {
        invalid += 1;
        lines.push({
          id: file.replace(/\.json$/, ""),
          from: "",
          to: "",
          kind: "invalid",
          at: "",
          status: "invalid",
          subject: "",
        });
        continue;
      }
      valid += 1;
      hops.set(message.thread, Math.max(hops.get(message.thread) ?? 0, message.hop));
      lines.push({
        id: message.id,
        from: message.from,
        to: message.to,
        kind: message.type,
        at: message.at,
        status,
        subject: busSubject(message.body, message.type),
      });
    } catch {
      invalid += 1;
    }
  }
  return { lines, valid, invalid, hops };
}

function neighborsOf(project: string, labRoot?: string, cwd?: string): { name: string; role: string }[] {
  const roots = [labRoot, cwd].filter((row): row is string => Boolean(row));
  for (const root of roots) {
    try {
      const config = loadBusConfig(join(root, project));
      if (config?.neighbors.length) return config.neighbors.map((n) => ({ name: n.name, role: n.role }));
    } catch { /* orch.yaml missing or invalid */ }
    try {
      const config = loadBusConfig(root);
      if (config?.name === project) return config.neighbors.map((n) => ({ name: n.name, role: n.role }));
    } catch { /* ignore */ }
  }
  return [];
}

function readRounds(root: string, fromMessages: Map<string, number>): DashBusState["rounds"] {
  const hops = new Map(fromMessages);
  const threadsDir = join(root, "threads");
  if (existsSync(threadsDir)) {
    for (const file of readdirSync(threadsDir).filter((name) => name.endsWith(".json"))) {
      try {
        const doc = JSON.parse(readFileSync(join(threadsDir, file), "utf8")) as { hop?: unknown };
        if (typeof doc.hop === "number" && Number.isInteger(doc.hop) && doc.hop >= 0) {
          const id = file.replace(/\.json$/, "");
          hops.set(id, Math.max(hops.get(id) ?? 0, doc.hop));
        }
      } catch { /* skip torn thread file */ }
    }
  }
  const threadHops = [...hops.values()];
  return {
    threads: hops.size,
    hops: threadHops.reduce((n, hop) => n + hop, 0),
    maxHop: threadHops.reduce((n, hop) => Math.max(n, hop), 0),
    roundTrips: threadHops.reduce((n, hop) => n + Math.floor(hop / 2), 0),
  };
}

export function collectBus(opts: {
  bus?: DashBusState;
  busRoot?: string | null;
  labRoot?: string;
  cwd?: string;
} = {}): DashBusState {
  if (opts.bus) return opts.bus;
  const fromConfig = (() => {
    try { return loadBusConfig(opts.cwd)?.root; } catch { return undefined; }
  })();
  const root = opts.busRoot === undefined ? (fromConfig ?? defaultBusRoot()) : opts.busRoot;
  if (!root || !existsSync(root)) return emptyBus();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return emptyBus();
  }
  const mailboxes: DashBusMailbox[] = [];
  const recent: DashBusLine[] = [];
  const pending: DashBusLine[] = [];
  const hops = new Map<string, number>();
  for (const name of names.sort()) {
    if (name === "keys" || name === "threads") continue;
    const dir = join(root, name);
    const inbox = join(dir, "inbox");
    const ack = join(dir, "ack");
    const escalate = join(dir, "escalate");
    if (!existsSync(inbox) && !existsSync(ack) && !existsSync(escalate)) continue;
    const inBox = readBox(inbox, "inbox");
    const acked = readBox(ack, "ack");
    const esc = readBox(escalate, "escalate");
    for (const [thread, hop] of [...inBox.hops, ...acked.hops, ...esc.hops]) {
      hops.set(thread, Math.max(hops.get(thread) ?? 0, hop));
    }
    mailboxes.push({
      project: name,
      inboxValid: inBox.valid,
      inboxInvalid: inBox.invalid,
      acked: acked.valid,
      escalated: esc.valid + esc.invalid,
      neighbors: neighborsOf(name, opts.labRoot, opts.cwd),
    });
    recent.push(...inBox.lines, ...acked.lines, ...esc.lines);
    pending.push(...esc.lines.filter((line) => line.status === "escalate"));
  }
  recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const trimmed = recent.slice(0, BUS_RECENT);
  return {
    active: true,
    mailboxes,
    recent: trimmed,
    pending,
    rounds: readRounds(root, hops),
  };
}

/** @deprecated use collectBus; kept for the mailbox-only shape in older tests */
export function dashBusOf(opts: { bus?: DashBusState; cwd?: string; busRoot?: string | null; labRoot?: string } = {}): DashBusMailbox[] {
  return collectBus(opts).mailboxes;
}

function uptimeSec(started: string | null, now: Date): number | null {
  if (!started) return null;
  const ms = now.getTime() - Date.parse(started);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
}

// A busy pulse older than this is a turn that ended without its Stop hook
// (interrupted): the process scan decides instead.
const BUSY_PULSE_MAX_MS = 30 * 60_000;

export function pulseState(p: Pulse | null, now: Date): "busy" | "idle" | null {
  if (!p) return null;
  if (p.state === "busy" && now.getTime() - Date.parse(p.at) > BUSY_PULSE_MAX_MS) return null;
  return p.state;
}

// orch serve tasks for the atelier: objective, state, next action, worker
// session and step, lane and delivery. Model text is filtered like log notes.
export function tasksOf(state: string, lanes = runningLanes(state)): DashTask[] {
  let s;
  try { s = new TaskStore(tasksDir(state)).read(); } catch { return []; }
  const clean = (t: string) => publicLogText(t, NOTE_TEXT_MAX) ?? "";
  return Object.values(s.tasks).sort((a, b) => a.created.localeCompare(b.created)).slice(-50).map((t) => {
    const jobs = Object.values(s.jobs).filter((j) => j.task === t.id);
    const costs = jobs.map((j) => j.receipt?.cost).filter((c): c is number => typeof c === "number");
    const job = t.job ? s.jobs[t.job] : undefined;
    const lane = lanes.find((l) => l.id === t.lane) ?? lanes.find((l) => l.intent === t.id) ?? null;
    return {
      id: t.id, objective: clean(t.objective), state: t.state, next: t.next, project: projectOf(t.mandate.repo), thread: t.thread,
      revision: t.revision, deliveredRevision: t.deliveredRevision, failures: t.failures,
      session: t.session, sessionStarted: t.sessionStarted, job: job ? { id: job.id, kind: job.kind, status: job.status } : null,
      lane: t.lane ?? null, branch: t.branch ?? null, pr: t.pr ?? null, failure: t.failure ? clean(t.failure) : null,
      createdAt: t.created, updatedAt: t.updated, lastEvidence: t.evidence.at(-1) ? clean(`${t.evidence.at(-1)!.kind}: ${t.evidence.at(-1)!.text}`) : null,
      costUsd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
      progress: lane ? { id: lane.id, phase: lane.phase, turns: lane.turns, lastTool: lane.lastTool, lastFile: lane.lastFile, lastText: lane.lastText, elapsedS: lane.elapsedS } : null,
    };
  });
}

export function collectSubagents(state: string): DashSubagent[] {
  const dir = join(state, "subagents");
  if (!existsSync(dir)) return [];
  const result: DashSubagent[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    const agents = new Map<string, DashSubagent>();
    let lines: string[];
    try { lines = readFileSync(join(dir, file), "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (typeof event.agent_id !== "string" || typeof event.at !== "string"
          || !["subagent-start", "subagent-stop"].includes(event.event)) continue;
        const previous = agents.get(event.agent_id);
        const value = (key: string, fallback = "") => typeof event[key] === "string" && event[key] ? event[key] : fallback;
        // Async hooks can finish out of order. A late start must not erase
        // an already recorded stop or its final message.
        const started = event.event === "subagent-start" ? event.at : previous?.started ?? null;
        const ended = event.event === "subagent-stop" ? event.at : previous?.ended ?? null;
        agents.set(event.agent_id, {
          session: file.slice(0, -6), agent_id: event.agent_id,
          agent_type: value("agent_type", previous?.agent_type),
          transcript_path: event.event === "subagent-start" && previous?.ended
            ? previous.transcript_path : value("transcript_path", previous?.transcript_path),
          last_assistant_message: (event.event === "subagent-start" && previous?.ended
            ? previous.last_assistant_message : value("last_assistant_message", previous?.last_assistant_message)).slice(0, 300),
          cwd: value("cwd", previous?.cwd), lead_pid: Number(event.lead_pid) || previous?.lead_pid || null,
          started, ended, running: Boolean(started && !ended),
        });
      } catch { /* Ignore a partial or malformed append. */ }
    }
    const rows = [...agents.values()];
    result.push(...rows.filter((row) => row.running),
      ...rows.filter((row) => !row.running).sort((a, b) => (b.ended ?? "").localeCompare(a.ended ?? "")).slice(0, 20));
  }
  return result;
}

export function loadFixture(path: string): DashSnapshot {
  if (!existsSync(path)) throw new Error(`dash: fixture not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as DashSnapshot;
}

export function collectDash(opts: {
  state?: string;
  projectsRoot?: string;
  policy?: ControlPolicy;
  machine?: MachineFigures;
  now?: Date;
  claudeProjects?: string;
  cwd?: string;
  lanes?: LaneState[];
  ledger?: LedgerRow[];
  bus?: DashBusState;
  limits?: Profile["limits"];
  spendUsed?: number;
  spendRows?: SpendEntry[];
  planUsed?: number;
  leads?: DashLead[];
  profile?: Profile;
  logs?: DashLogLine[];
  skills?: DashSkill[];
  installed?: string[];
  hostName?: string;
  procRoot?: string | null;
  labRoot?: string;
  busRoot?: string | null;
  orchRoot?: string;
  home?: string;
  onProviderError?: (provider: "claude" | "codex" | "grok", error: unknown) => void;
  providerIngestMode?: "sync" | "cache-only";
  providerLive?: ProviderLiveSnapshot;
  /**
   * Last background ingest summary (null: none yet). When set, provider logs
   * are never read here: the request path stays cheap.
   */
  providerSummary?: ProviderUsageSummary | null;
  providersSyncing?: boolean;
} = {}): DashSnapshot {
  const now = opts.now ?? new Date();
  const state = opts.state ?? stateDir();
  const policy = opts.policy ?? loadPolicy();
  const lanesState = opts.lanes ?? (reapDeadLanes(state), listLanes(state));
  const ledger = opts.ledger ?? readLedger(state);
  const dashLanes = dashLanesOf(lanesState, ledger, now, (id) => readLaneProgress(join(state, "lanes", id)));
  // Kiba is the only lead: its profile sets the lane budget and the lead shown.
  const profile = opts.profile ?? loadProfile(kibaProfile());
  const labRoot = opts.labRoot ?? join(process.env.HOME ?? process.env.ORCH_HOME ?? "", "lab");
  const names = listProjectNames(opts.projectsRoot ?? projectsRoot());
  const orchRoot = opts.orchRoot ?? opts.projectsRoot ?? projectsRoot();
  const home = opts.home ?? process.env.HOME ?? process.env.ORCH_HOME ?? "";
  const leads = opts.leads ?? discoverLeads({
    pulse: (pid) => pulseState(readPulse(pid, state), now),
    procRoot: opts.procRoot,
    labRoot,
    projects: names,
    orchRoot,
    home,
    now,
    lanes: dashLanes,
  });
  const laneCounts = new Map<string, number>();
  for (const lane of dashLanes) laneCounts.set(lane.project, (laneCounts.get(lane.project) ?? 0) + 1);
  const leadCounts = new Map<string, number>();
  for (const lead of leads) leadCounts.set(lead.project, (leadCounts.get(lead.project) ?? 0) + 1);
  const day = utcDay(now);
  const ledgerLines = dashLedgerOf(ledger);
  const spendByProject = new Map<string, number>();
  for (const row of ledgerLines) {
    if (row.kind !== "run" || !row.project || !row.at || row.at.slice(0, 10) !== day) continue;
    spendByProject.set(row.project, (spendByProject.get(row.project) ?? 0) + (row.costUsd ?? 0));
  }
  const projects: DashProject[] = [...new Set([...names, ...laneCounts.keys(), ...leadCounts.keys()])]
    .sort()
    .map((name) => ({
      name,
      leads: leadCounts.get(name) ?? 0,
      lanes: laneCounts.get(name) ?? 0,
      spendUsd: spendByProject.get(name) ?? 0,
    }));
  const planCap = policy.spend.plan_tokens ?? null;
  const fromLedger = ledgerTokensOnDay(ledger, day);
  const fromSummary = opts.providerSummary === undefined
    ? undefined
    : opts.providerSummary?.planTokens?.day === day ? opts.providerSummary.planTokens.tokens : 0;
  const fromTranscripts = planCap == null
    ? 0
    : fromSummary ?? tokensOnDay(
      tokenUsage(opts.claudeProjects ?? claudeProjectsDir(), new Date(`${day}T00:00:00.000Z`)),
      day,
    );
  const planUsed = opts.planUsed ?? fromTranscripts + fromLedger;
  const remaining = planCap == null ? null : Math.max(0, planCap - planUsed);
  const limits = opts.limits ?? profile.limits;
  const logs = opts.logs ?? readProjectLogs(state);
  const machine = opts.machine ?? { cores: 0, memAvailableGib: 0 };
  const installed = opts.installed ?? detect();
  const liveProviders = opts.providerLive ?? (opts.providerSummary !== undefined
    ? providerLiveFromSummary(opts.providerSummary, { leads, installed, now, home, state, syncing: opts.providersSyncing })
    : collectProviderLive({
    leads,
    installed,
    now,
    home,
    state,
    onProviderError: opts.onProviderError,
    ingestMode: opts.providerIngestMode ?? "sync",
  }));
  const costs = costsOf(opts.spendRows ?? readSpend(state), now);
  // Every chart and total reads the spend journal: lanes alone would miss
  // Kiba sessions and consults, and lanes plus ledger counted runs twice.
  const daily = costs.days.map((d) => ({ day: d.day, costUsd: d.total, runs: d.runs }));
  const { runtimes } = runtimesOf({
    hostName: opts.hostName ?? hostname(),
    cores: machine.cores,
    ramGib: machine.memAvailableGib,
    installed,
    leads,
    lanes: dashLanes,
    ledger: ledgerLines,
  });
  const liveRuntimes = applyProviderLive(runtimes, liveProviders);
  const activity = activityOf({ leads, lanes: dashLanes, ledger: ledgerLines, logs, now });
  let tasks: DashTask[] = [];
  try { tasks = tasksOf(state); } catch { /* the task journal is optional */ }
  return {
    at: now.toISOString(),
    tasks,
    projects,
    leads,
    subagents: collectSubagents(state),
    lanes: dashLanes,
    ledger: ledgerLines,
    spend: { used: opts.spendUsed ?? costs.today },
    costs,
    plan: { used: planCap == null ? 0 : planUsed, cap: planCap },
    budget: laneBudget(limits, opts.machine, { remainingTokens: remaining }),
    bus: collectBus({ bus: opts.bus, busRoot: opts.busRoot, labRoot, cwd: opts.cwd }),
    activity,
    working: workingOf(dashLanes, now),
    runtimes: liveRuntimes,
    heat: daily,
    daily,
    skills: opts.skills ?? listLocalSkills(),
    logs,
    providersSyncing: opts.providersSyncing,
  };
}

export function readProjectLogs(state: string): DashLogLine[] {
  const root = join(state, "missions");
  if (!existsSync(root)) return [];
  const rows: { at: string; kind: string; text: string; project: string }[] = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name, "log.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { at?: string; kind?: string; text?: string };
        if (typeof row.text === "string" && typeof row.kind === "string" && typeof row.at === "string") {
          rows.push({ at: row.at, kind: row.kind, text: row.text, project: name });
        }
      } catch { /* skip torn line */ }
    }
  }
  return sanitizeLogs(rows);
}

export function listLocalSkills(root = join(ROOT, ".agents", "skills")): DashSkill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((id) => {
    const file = join(root, id, "SKILL.md");
    if (!existsSync(file)) return [];
    try {
      const meta = parseSkillFront(readFileSync(file, "utf8"));
      return meta ? [{ id, name: meta.name, description: meta.description }] : [];
    } catch {
      return [];
    }
  });
}
