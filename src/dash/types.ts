import type { LaneBudget } from "../lanes/budget.ts";
import type { Harness } from "../core/profile.ts";

export type LeadActivity = "working" | "idle" | "blocked" | "busy";
export type LaneLife = "queued" | "claimed" | "running" | "verify" | "done" | "failed" | "blocked";

export interface DashLead {
  id: string;
  project: string;
  pid: number | null;
  harness: Harness;
  model: string;
  effort: string;
  permissionMode: string | null;
  started: string | null;
  uptimeSec: number | null;
  remoteControl: boolean;
  supervised: boolean;
  cwd: string;
  activity: LeadActivity;
}

export interface DashTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DashSubagent {
  session: string;
  agent_id: string;
  agent_type: string;
  transcript_path: string;
  last_assistant_message: string;
  cwd: string;
  lead_pid: number | null;
  started: string | null;
  ended: string | null;
  running: boolean;
}

export interface DashLane {
  id: string;
  project: string;
  status: string;
  harness: string;
  model: string;
  effort: string | null;
  costUsd: number;
  started: string;
  ended: string | null;
  life: LaneLife;
  blocked: boolean;
  verifyOk: boolean | null;
  worktree: string;
  durationSec: number | null;
  tokens: DashTokens;
  pid: number | null;
  // Live progress of a running lane (progress.json), null when absent.
  progress: DashLaneProgress | null;
}

export interface DashLaneProgress {
  phase: "setup" | "worker" | "verify" | "done";
  updated: string;
  turns: number;
  toolCalls: number;
  lastTool: string | null;
  lastFile: string | null;
  filesTouched: number;
  lastText: string | null;
}

export interface DashLedgerLine {
  id: string;
  at: string;
  kind: string;
  project?: string;
  harness?: string;
  status?: string;
  model?: string;
  effort?: string;
  costUsd?: number;
  channel?: string;
}

export interface DashBusMailbox {
  project: string;
  inboxValid: number;
  inboxInvalid: number;
  acked: number;
  escalated: number;
  neighbors: { name: string; role: string }[];
}

/** @deprecated use DashBusMailbox; kept as the per-project mailbox row */
export type DashBus = DashBusMailbox;

export interface DashBusLine {
  id: string;
  from: string;
  to: string;
  kind: string;
  at: string;
  status: string;
  subject: string;
}

export interface DashBusRounds {
  threads: number;
  hops: number;
  maxHop: number;
  roundTrips: number;
}

export interface DashBusState {
  active: boolean;
  mailboxes: DashBusMailbox[];
  recent: DashBusLine[];
  pending: DashBusLine[];
  rounds: DashBusRounds;
}

export interface DashProject {
  name: string;
  leads: number;
  lanes: number;
  spendUsd: number;
}

export interface DashLogLine {
  at: string;
  kind: string;
  project: string;
  text: string;
}

export interface DashEvent {
  at: string;
  actor: { kind: "lead" | "lane" | "log"; id: string; harness?: string; project?: string };
  verb: string;
  text: string;
}

export interface DashWorking {
  laneId: string;
  project: string;
  harness: string;
  model: string;
  effort: string | null;
  elapsedSec: number;
  // From progress.json: "Edit · src/a.ts", "VERIFY en cours"; null without it.
  lastStep: string | null;
  lastText: string | null;
  // true when the row comes from live progress, false for the estimate
  live: boolean;
  toolCalls: number | null;
  stream: string[];
  steps: { label: string; durationSec: number }[];
}

export interface DashRuntime {
  id: string;
  kind: "host" | "harness";
  name: string;
  online: boolean;
  live: boolean;
  detail: string;
  tokens: DashTokens;
  costUsd: number;
  estimate?: boolean;
  billing?: "usd" | "quota";
  authType?: "clé API" | "login" | "inconnu";
  quota?: {
    primaryUsedPercent?: number;
    secondaryUsedPercent?: number;
    primaryResetAt?: string;
    secondaryResetAt?: string;
  };
  /** Rate-limit windows (5 h, weekly) with reset time and burn rate. */
  limits?: DashQuota;
}

export interface DashQuotaWindow {
  id: string;
  /** "Fenêtre 5 h", "Hebdo", ... */
  label: string;
  /** Percent used, null when the provider does not expose this window. */
  usedPercent: number | null;
  windowMinutes?: number;
  resetAt?: string;
  /** Burn rate in percent per hour from the last snapshots; null when not enough data. */
  ratePerHour?: number | null;
  projectedFullAt?: string | null;
  fullBeforeReset?: boolean;
  note?: string;
  /** Why the window is unavailable ("indisponible"). */
  unavailable?: string;
}

export interface DashQuota {
  /** Where the numbers come from (statusLine snapshot, rollouts, logs). */
  source: string;
  capturedAt?: string;
  /** Snapshot older than 6 h ("ancien"). */
  stale: boolean;
  windows: DashQuotaWindow[];
  /** Whole provider quota unavailable, with the reason. */
  unavailable?: string;
  /** First background ingest still running and no data yet. */
  loading?: boolean;
}

/** One Paris day of estimated spend, split by who spent it. */
export interface DashCostDay {
  day: string;
  total: number;
  /** Kiba sessions. */
  lead: number;
  lane: number;
  /** Reviews, contests and judges. */
  consult: number;
  other: number;
  /** Lane runs that day. */
  runs: number;
}

export interface DashCosts {
  /** Today, Paris day. */
  today: number;
  /** The last 7 Paris days, today included. */
  week: number;
  /** The last 14 Paris days, oldest first. */
  days: DashCostDay[];
  /** Last 7 days, highest first. */
  byProject: { name: string; usd: number }[];
  byModel: { name: string; usd: number }[];
  laneRuns: number;
  perLaneRun: number | null;
}

export interface DashHeatCell {
  day: string;
  costUsd: number;
  runs: number;
}

export interface DashSkill {
  id: string;
  name: string;
  description: string;
}

// orch serve tasks (src/core/tasks.ts), for the atelier desks and threads.
export interface DashTask {
  id: string; objective: string; state: string; next: string; project: string | null; thread: string;
  revision: number; deliveredRevision: number; failures: number;
  /** The task's native worker session and the step running now, if any. */
  session: string; sessionStarted: boolean; job: { id: string; kind: string; status: string } | null;
  lane: string | null; branch: string | null; pr: string | null; failure: string | null;
  createdAt: string; updatedAt: string; lastEvidence: string | null;
  /** Summed from the job receipts; null when none reported a cost. */
  costUsd: number | null;
  /** The running lane of this task (its VERIFY), with its live progress. */
  progress: { id: string; phase: string | null; turns: number | null; lastTool: string | null; lastFile: string | null; lastText: string | null; elapsedS: number | null } | null;
}

export interface DashSnapshot {
  at: string;
  // orch serve tasks, oldest first.
  tasks?: DashTask[];
  projects: DashProject[];
  leads: DashLead[];
  subagents?: DashSubagent[];
  lanes: DashLane[];
  ledger: DashLedgerLine[];
  spend: { used: number };
  /** Estimated spend from the spend journal: the one source for every total shown. */
  costs: DashCosts;
  plan: { used: number; cap: number | null };
  budget: LaneBudget;
  bus: DashBusState;
  activity: DashEvent[];
  working: DashWorking[];
  runtimes: DashRuntime[];
  providersSyncing?: boolean;
  heat: DashHeatCell[];
  daily: DashHeatCell[];
  skills: DashSkill[];
  logs: DashLogLine[];
}

