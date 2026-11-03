// Reference-mission bench: a bug, a feature, and a two-project contract
// change (API + client). Default runner is dry
// (no model); --live is the operator's paid path.
import { pauseReason, spentToday, loadPolicy } from "../core/policy.ts";
import { stateDir } from "../core/paths.ts";
import type { Rule } from "./rules.ts";
import { betterScore, readBaseline, scoreOf, setStatus, writeBaseline, type BenchScore } from "./rules.ts";

export const REFERENCE_MISSIONS = [
  { id: "bug", kind: "bug", title: "fix an off-by-one in a parser" },
  { id: "feature", kind: "feature", title: "add a status field to an existing command" },
  { id: "contract", kind: "contract", title: "change an API shape and its client together" },
] as const;

export type MissionId = (typeof REFERENCE_MISSIONS)[number]["id"];

export interface MissionResult {
  id: MissionId;
  pass: boolean;
  costUsd: number;
  escalated: boolean;
  note?: string;
}

export type MissionRunner = (mission: (typeof REFERENCE_MISSIONS)[number], rules: Rule[]) => MissionResult;

// Dry runner: no model. A candidate helps when its text names the mission
// kind it claims to fix (`bug` / `feature` / `contract`). An empty or
// "never" rule fails everything. Neutral rules leave the baseline (all pass,
// $1, no escalation) unchanged — and are pruned (no improvement).
export function dryRunner(mission: (typeof REFERENCE_MISSIONS)[number], rules: Rule[]): MissionResult {
  const active = rules.filter((r) => r.status === "candidate" || r.status === "kept");
  if (active.some((r) => /\bnever\b/i.test(r.text))) {
    return { id: mission.id, pass: false, costUsd: 1, escalated: true, note: "harmful rule" };
  }
  const helps = active.some((r) => r.text.toLowerCase().includes(mission.kind));
  return { id: mission.id, pass: true, costUsd: helps ? 0.8 : 1, escalated: false, note: helps ? "rule matched kind" : "baseline" };
}

export function assertBenchAllowed(env: NodeJS.ProcessEnv = process.env, state = stateDir()): string | null {
  const pause = pauseReason(env, state);
  if (pause) return `paused: ${pause}`;
  // Keep reading policy/spend so compatibility warnings still surface once.
  loadPolicy();
  spentToday(state);
  return null;
}

export function runMissions(rules: Rule[], runner: MissionRunner = dryRunner): MissionResult[] {
  return REFERENCE_MISSIONS.map((m) => runner(m, rules));
}

export function decideCandidates(
  candidates: Rule[],
  baseline: BenchScore,
  scored: Map<string, BenchScore>,
  state = stateDir(),
): { kept: string[]; pruned: string[] } {
  const kept: string[] = [];
  const pruned: string[] = [];
  for (const rule of candidates) {
    const score = scored.get(rule.id);
    if (score && betterScore(score, baseline)) {
      setStatus(rule.id, "kept", state);
      kept.push(rule.id);
    } else {
      setStatus(rule.id, "pruned", state);
      pruned.push(rule.id);
    }
  }
  return { kept, pruned };
}

export function benchRules(opts: {
  rules: Rule[];
  runner?: MissionRunner;
  state?: string;
  env?: NodeJS.ProcessEnv;
  live?: boolean;
}): { refused?: string; score: BenchScore; results: MissionResult[]; kept: string[]; pruned: string[] } {
  const state = opts.state ?? stateDir();
  const block = assertBenchAllowed(opts.env ?? process.env, state);
  if (block) return { refused: block, score: { passRate: 0, costUsd: 0, escalations: 0, n: 0 }, results: [], kept: [], pruned: [] };
  const runner = opts.runner ?? dryRunner;
  const keptRules = opts.rules.filter((r) => r.status === "kept");
  const candidates = opts.rules.filter((r) => r.status === "candidate");
  const baselineRun = scoreOf(runMissions(keptRules, runner));
  const stored = readBaseline(state) ?? baselineRun;
  const scored = new Map<string, BenchScore>();
  for (const rule of candidates) {
    scored.set(rule.id, scoreOf(runMissions([...keptRules, { ...rule, status: "candidate" }], runner)));
  }
  const { kept, pruned } = decideCandidates(candidates, stored, scored, state);
  const finalRules = [
    ...keptRules,
    ...opts.rules.filter((r) => kept.includes(r.id)).map((r) => ({ ...r, status: "kept" as const })),
  ];
  const score = scoreOf(runMissions(finalRules, runner));
  if (betterScore(score, stored) || !readBaseline(state)) writeBaseline(score, state);
  return { score, results: runMissions(finalRules, runner), kept, pruned };
}
