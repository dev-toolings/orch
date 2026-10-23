// Lane ledger: one append-only JSON line per finished lane run and per closed
// lane (integrated, dropped, no change), under the state dir. It is the
// evidence `lane route` reads; never a memory note, never a model call.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../core/paths.ts";
import type { Status, Usage } from "../harness/harness.ts";
import type { SpecFeatures } from "./route.ts";

export interface RunRecord {
  kind: "run";
  id: string;
  at: string;
  repo: string;
  to: string;
  model: string;
  effort: string;
  channel: string;
  status: Status;
  changed: boolean;
  verifyOk: boolean | null;
  features: SpecFeatures;
  diff: { files: string[]; insertions: number; deletions: number };
  outOfScope: string[];
  durationS: number;
  usage: Usage;
}

export type Outcome = "integrated" | "dropped" | "nochange";

export interface OutcomeRecord {
  kind: "outcome";
  id: string;
  at: string;
  outcome: Outcome;
  by: "integrate" | "gc";
}

// A gate refusal, kept as evidence (it prompts a spec or harness fix, it is
// not a worker failure on its own).
export interface GateRecord { kind: "gate"; id: string; at: string; reasons: string[] }

// A review of a lane branch: the gate needs `ship` from one for a risky lane.
export interface ReviewRecord { kind: "review"; id: string; at: string; to: string; model: string; effort: string; verdict: Verdict }
export type Verdict = "ship" | "fix-first" | "rethink" | "unknown";

export type LedgerRow = RunRecord | OutcomeRecord | GateRecord | ReviewRecord;
const KINDS = new Set(["run", "outcome", "gate", "review"]);

export interface HarnessSummary {
  to: string;
  runs: number;
  integrated: number;
  failed: number;
  meanTokens?: number;
  meanDurationS?: number;
  gateRefusals: number;
}

export const ledgerPath = (root = stateDir()) => join(root, "lanes.jsonl");

export function appendLedger(row: LedgerRow, root = stateDir()): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(ledgerPath(root), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

// A torn or hand-edited line is skipped, never fatal: routing degrades to the
// static rules, it does not stop a lane.
export function readLedger(root = stateDir()): LedgerRow[] {
  const p = ledgerPath(root);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line) as LedgerRow;
      return row && KINDS.has(row.kind) && typeof row.id === "string" ? [row] : [];
    } catch { return []; }
  });
}

// One verdict per run: integrated is a success; dropped, failed, refused and
// timeout are failures; the rest (noop, blocked, unavailable, still open) say
// nothing about the worker's skill and are left out.
export function verdicts(rows: LedgerRow[]): { run: RunRecord; ok: boolean }[] {
  const outcome = new Map<string, Outcome>();
  for (const r of rows) if (r.kind === "outcome") outcome.set(r.id, r.outcome);
  return rows.flatMap((r): { run: RunRecord; ok: boolean }[] => {
    if (r.kind !== "run") return [];
    const o = outcome.get(r.id);
    if (o === "integrated") return [{ run: r, ok: true }];
    if (o === "dropped" || ["failed", "refused", "timeout"].includes(r.status)) return [{ run: r, ok: false }];
    return [];
  });
}

export function summarize(rows: LedgerRow[]): HarnessSummary[] {
  const runsByHarness = new Map<string, RunRecord[]>();
  for (const row of rows) {
    if (row.kind !== "run") continue;
    const runs = runsByHarness.get(row.to) ?? [];
    runs.push(row);
    runsByHarness.set(row.to, runs);
  }

  const verdictCounts = new Map<string, { integrated: number; failed: number }>();
  for (const verdict of verdicts(rows)) {
    const counts = verdictCounts.get(verdict.run.to) ?? { integrated: 0, failed: 0 };
    if (verdict.ok) counts.integrated++;
    else counts.failed++;
    verdictCounts.set(verdict.run.to, counts);
  }

  return [...runsByHarness.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([to, runs]) => {
      const ids = new Set(runs.map((run) => run.id));
      const tokens = runs.flatMap((run) => {
        const usage = run.usage;
        if (typeof usage?.total === "number" && Number.isFinite(usage.total)) return [usage.total];
        if (typeof usage?.input === "number" && Number.isFinite(usage.input)
          && typeof usage.output === "number" && Number.isFinite(usage.output)) {
          return [usage.input + usage.output];
        }
        return [];
      });
      const durations = runs.flatMap((run) => Number.isFinite(run.durationS) ? [run.durationS] : []);
      const counts = verdictCounts.get(to) ?? { integrated: 0, failed: 0 };
      const gateRefusals = rows.filter((row) => row.kind === "gate" && ids.has(row.id)).length;
      return {
        to,
        runs: runs.length,
        integrated: counts.integrated,
        failed: counts.failed,
        ...(tokens.length ? { meanTokens: Math.round(tokens.reduce((sum, value) => sum + value, 0) / tokens.length) } : {}),
        ...(durations.length ? { meanDurationS: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) } : {}),
        gateRefusals,
      };
    });
}

// The last review of a lane decides: a later fix-first overrides an earlier ship.
export function lastVerdict(rows: LedgerRow[], id: string): Verdict | undefined {
  let v: Verdict | undefined;
  for (const r of rows) if (r.kind === "review" && r.id === id) v = r.verdict;
  return v;
}

export function parseVerdict(message: string): Verdict {
  const m = /VERDICT:\s*(ship|fix-first|rethink)\b/i.exec(message);
  return m ? (m[1].toLowerCase() as Verdict) : "unknown";
}
