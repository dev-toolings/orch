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

export type LedgerRow = RunRecord | OutcomeRecord;

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
      return row && (row.kind === "run" || row.kind === "outcome") && typeof row.id === "string" ? [row] : [];
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
