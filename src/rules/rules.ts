// Candidate harness rules: harvested from gate refusals, review verdicts
// and human corrections. A nightly bench keeps a rule only if it improves
// pass rate / cost / escalations; otherwise it is pruned.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../core/paths.ts";
import type { LedgerRow } from "../lanes/ledger.ts";

export const RULE_SOURCES = ["gate", "review", "correction"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];
export const RULE_STATUSES = ["candidate", "kept", "pruned"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export interface Rule {
  id: string;
  at: string;
  source: RuleSource;
  text: string;
  provenance: string;
  status: RuleStatus;
}

export interface BenchScore {
  passRate: number;
  costUsd: number;
  escalations: number;
  n: number;
}

export function rulesPath(state = stateDir()): string {
  return join(state, "rules", "rules.jsonl");
}

export function baselinePath(state = stateDir()): string {
  return join(state, "rules", "baseline.json");
}

export function parseRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.text !== "string" || !r.text.trim()) return null;
  if (typeof r.source !== "string" || !(RULE_SOURCES as readonly string[]).includes(r.source)) return null;
  if (typeof r.status !== "string" || !(RULE_STATUSES as readonly string[]).includes(r.status)) return null;
  return {
    id: r.id,
    at: typeof r.at === "string" ? r.at : "",
    source: r.source as RuleSource,
    text: r.text.trim(),
    provenance: typeof r.provenance === "string" ? r.provenance : "",
    status: r.status as RuleStatus,
  };
}

export function readRules(state = stateDir()): Rule[] {
  const path = rulesPath(state);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return parseRule(JSON.parse(line)) ?? []; } catch { return []; }
  });
}

export function writeRules(rules: Rule[], state = stateDir()): void {
  const path = rulesPath(state);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rules.map((r) => JSON.stringify(r)).join("\n") + (rules.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, path);
}

export function addRule(input: Omit<Rule, "id" | "at" | "status"> & { status?: RuleStatus }, state = stateDir()): Rule {
  const existing = readRules(state);
  const dup = existing.find((r) => r.status !== "pruned" && r.text === input.text.trim());
  if (dup) return dup;
  const rule: Rule = {
    id: `r-${Date.now().toString(36)}-${existing.length}`,
    at: new Date().toISOString(),
    source: input.source,
    text: input.text.trim(),
    provenance: input.provenance,
    status: input.status ?? "candidate",
  };
  mkdirSync(dirname(rulesPath(state)), { recursive: true });
  appendFileSync(rulesPath(state), `${JSON.stringify(rule)}\n`, { mode: 0o600 });
  return rule;
}

export function harvestLedger(rows: LedgerRow[], state = stateDir()): Rule[] {
  const added: Rule[] = [];
  for (const row of rows) {
    if (row.kind === "gate") {
      const text = `gate refusal: ${row.reasons.join("; ")}`.slice(0, 240);
      added.push(addRule({ source: "gate", text, provenance: `ledger:gate:${row.id}` }, state));
    } else if (row.kind === "review" && (row.verdict === "fix-first" || row.verdict === "rethink")) {
      const text = `review ${row.verdict} on ${row.id}`.slice(0, 240);
      added.push(addRule({ source: "review", text, provenance: `ledger:review:${row.id}` }, state));
    }
  }
  return added;
}

export function setStatus(id: string, status: RuleStatus, state = stateDir()): Rule | null {
  const rules = readRules(state);
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return null;
  rules[i] = { ...rules[i], status };
  writeRules(rules, state);
  return rules[i];
}

export function betterScore(next: BenchScore, prev: BenchScore): boolean {
  if (next.n === 0) return false;
  if (next.passRate > prev.passRate) return true;
  if (next.passRate < prev.passRate) return false;
  if (next.escalations < prev.escalations) return true;
  if (next.escalations > prev.escalations) return false;
  return next.costUsd < prev.costUsd;
}

export function readBaseline(state = stateDir()): BenchScore | null {
  const path = baselinePath(state);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as BenchScore;
    if (![raw.passRate, raw.costUsd, raw.escalations, raw.n].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return raw;
  } catch { return null; }
}

export function writeBaseline(score: BenchScore, state = stateDir()): void {
  const path = baselinePath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(score)}\n`, { mode: 0o600 });
}

export function scoreOf(rows: Array<{ pass: boolean; costUsd: number; escalated: boolean }>): BenchScore {
  const n = rows.length;
  if (!n) return { passRate: 0, costUsd: 0, escalations: 0, n: 0 };
  return {
    passRate: rows.filter((r) => r.pass).length / n,
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    escalations: rows.filter((r) => r.escalated).length,
    n,
  };
}
