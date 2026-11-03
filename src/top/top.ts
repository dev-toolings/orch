// Snapshot + text render for `orch top`. Tests drive renderTop with a
// constructed snapshot; collectTop reads the live state.
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { formatList, loadBusConfig, readInbox } from "../bus/bus.ts";
import { formatEvents, readEvents, type ControlEvent } from "../core/events.ts";
import { estimateUsageUsd } from "../core/paid.ts";
import { loadPolicy, spentToday, type ControlPolicy } from "../core/policy.ts";
import { projectsRoot } from "../core/project.ts";
import { stateDir } from "../core/paths.ts";
import { loadProfile, type Profile } from "../core/profile.ts";
import { listLanes, type LaneState } from "../lane.ts";
import { laneBudget, type LaneBudget, type MachineFigures } from "../lanes/budget.ts";
import { readLedger, type LedgerRow, type RunRecord } from "../lanes/ledger.ts";
import { formatTiming, type GateTiming } from "../lanes/timing.ts";
import { claudeProjectsDir, tokensOnDay, tokenUsage, utcDay } from "../ops/usage.ts";

export interface TopLane {
  id: string;
  project: string;
  status: string;
  harness: string;
  model: string;
  costUsd: number;
  gate?: GateTiming;
}

export interface TopBus {
  project: string;
  lines: string[];
}

export interface TopProject {
  name: string;
  lanes: number;
}

export interface TopSnapshot {
  at: string;
  projects: TopProject[];
  lanes: TopLane[];
  spend: { used: number };
  plan: { used: number; cap: number | null };
  budget: LaneBudget;
  bus: TopBus[];
  events: ControlEvent[];
}

const SKIP_PROJECT = new Set(["bus-keys"]);

export function listProjectNames(root = projectsRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_PROJECT.has(e.name))
    .map((e) => e.name)
    .sort();
}

export function ledgerTokensOnDay(ledger: LedgerRow[], day: string): number {
  let n = 0;
  for (const row of ledger) {
    if (row.kind !== "run") continue;
    if (!row.at || row.at.slice(0, 10) !== day) continue;
    const u = row.usage ?? {};
    if (typeof u.total === "number" && Number.isFinite(u.total)) n += u.total;
    else n += (u.input ?? 0) + (u.output ?? 0) + (u.cached ?? 0);
  }
  return n;
}

function modelOf(id: string, ledger: LedgerRow[]): string {
  const run = [...ledger].reverse().find((r): r is RunRecord => r.kind === "run" && r.id === id);
  return run?.model || "—";
}

export function topLanesOf(lanes: LaneState[], ledger: LedgerRow[] = []): TopLane[] {
  return [...lanes]
    .sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0))
    .map((lane) => ({
      id: lane.id,
      project: basename(lane.repo),
      status: lane.status,
      harness: lane.to,
      model: modelOf(lane.id, ledger),
      costUsd: estimateUsageUsd(lane.usage),
      gate: lane.gate,
    }));
}

function liveBus(cwd?: string): TopBus[] {
  const config = loadBusConfig(cwd);
  if (!config) return [];
  const rows = readInbox(config);
  return [{ project: config.name, lines: formatList(rows).split("\n") }];
}

const money = (n: number) => `$${n.toFixed(4)}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

export function collectTop(opts: {
  state?: string;
  projectsRoot?: string;
  policy?: ControlPolicy;
  machine?: MachineFigures;
  now?: Date;
  claudeProjects?: string;
  cwd?: string;
  lanes?: LaneState[];
  ledger?: LedgerRow[];
  bus?: TopBus[];
  limits?: Profile["limits"];
  spendUsed?: number;
  planUsed?: number;
  events?: ControlEvent[];
} = {}): TopSnapshot {
  const now = opts.now ?? new Date();
  const state = opts.state ?? stateDir();
  const policy = opts.policy ?? loadPolicy();
  const lanes = opts.lanes ?? listLanes(state);
  const ledger = opts.ledger ?? readLedger(state);
  const names = listProjectNames(opts.projectsRoot ?? projectsRoot());
  const counts = new Map<string, number>();
  for (const lane of lanes) {
    const key = basename(lane.repo);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const projects = [...new Set([...names, ...counts.keys()])].sort().map((name) => ({
    name,
    lanes: counts.get(name) ?? 0,
  }));
  const planCap = policy.spend.plan_tokens ?? null;
  const day = utcDay(now);
  const fromLedger = ledgerTokensOnDay(ledger, day);
  const fromTranscripts = planCap == null
    ? 0
    : tokensOnDay(
      tokenUsage(opts.claudeProjects ?? claudeProjectsDir(), new Date(`${day}T00:00:00.000Z`)),
      day,
    );
  const planUsed = opts.planUsed ?? fromTranscripts + fromLedger;
  const remaining = planCap == null ? null : Math.max(0, planCap - planUsed);
  const limits = opts.limits ?? loadProfile().limits;
  return {
    at: now.toISOString(),
    projects,
    lanes: topLanesOf(lanes, ledger),
    spend: { used: opts.spendUsed ?? spentToday(state, now) },
    plan: { used: planCap == null ? 0 : planUsed, cap: planCap },
    budget: laneBudget(limits, opts.machine, { remainingTokens: remaining }),
    bus: opts.bus ?? liveBus(opts.cwd),
    events: opts.events ?? readEvents(state),
  };
}

export function renderTop(snap: TopSnapshot): string {
  const plan = snap.plan.cap == null
    ? "unlimited"
    : `${tokens(snap.plan.used)} / ${tokens(snap.plan.cap)}`;
  const q = snap.budget.quota == null ? "—" : String(snap.budget.quota);
  const lines = [
    `orch top  ${snap.at}`,
    `ESTIMATED COST (TODAY)  ${money(snap.spend.used)}`,
    `PLAN   ${plan}`,
    `BUDGET ${snap.budget.budget}  limited by ${snap.budget.limitedBy}  cpu ${snap.budget.cpu}  ram ${snap.budget.ram}  ceiling ${snap.budget.ceiling}  quota ${q}`,
    "",
    "PROJECTS",
  ];
  if (!snap.projects.length) lines.push("  (none)");
  else for (const p of snap.projects) lines.push(`  ${p.name.padEnd(24)} ${p.lanes} lane${p.lanes === 1 ? "" : "s"}`);
  lines.push("", "LANES");
  if (!snap.lanes.length) lines.push("  (none)");
  else {
    lines.push("  id                              status       harness  model           cost      gate");
    for (const lane of snap.lanes) {
      const gate = lane.gate ? formatTiming(lane.gate).replace(/^GATE TIME: /, "") : "—";
      lines.push(
        `  ${lane.id.slice(0, 30).padEnd(30)}  ${lane.status.padEnd(12)} ${lane.harness.padEnd(8)} ${lane.model.slice(0, 14).padEnd(14)}  ${money(lane.costUsd).padStart(8)}  ${gate}`,
      );
    }
  }
  lines.push("", "BUS");
  if (!snap.bus.length) lines.push("  (not configured)");
  else {
    for (const b of snap.bus) {
      lines.push(`  ${b.project}`);
      for (const row of b.lines) lines.push(`    ${row}`);
    }
  }
  const alerts = formatEvents(snap.events ?? []);
  if (alerts) lines.push("", alerts);
  return lines.join("\n") + "\n";
}
