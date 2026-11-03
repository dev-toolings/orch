// The pure rules orch serve and `lane route` share under the `kiba` profile:
// task kind from the spec, the effort ladder (two failures, one rung up,
// never above high) and the profile section that tunes them, plus the
// code-first event filter (src/core/inbound.ts). No model call here.
import type { Route, SpecFeatures } from "../lanes/route.ts";

export const TASK_KINDS = ["mechanical", "normal", "risky"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const isCodeKind = (k: string): k is TaskKind => (TASK_KINDS as readonly string[]).includes(k);

export interface Rung { model: string; effort: string }

export interface KibaConfig {
  ladder: Record<TaskKind, Rung>;
  // Failures of the same task before one rung up (model first, then effort).
  escalate_after: number;
  // Failures after which the task goes back to the operator.
  max_attempts: number;
  lane_timeout_seconds: number;
  // The fresh-session nudge (src/hooks/journal.ts): past this share of the window or this many turns.
  fresh_session_percent: number;
  fresh_session_turns: number;
  // Watchdog (src/kiba/watchdog.ts) of orch serve workers: no progress for
  // this long is a stall; this many worker turns without a test run is a loop.
  watchdog: { stall_seconds: number; max_turns_without_test: number; tick_seconds: number };
}

export const DEFAULT_KIBA: KibaConfig = {
  ladder: {
    mechanical: { model: "haiku", effort: "low" },
    normal: { model: "sonnet", effort: "medium" },
    risky: { model: "opus", effort: "high" },
  },
  watchdog: { stall_seconds: 300, max_turns_without_test: 30, tick_seconds: 15 },
  escalate_after: 2, max_attempts: 3,
  lane_timeout_seconds: 900, fresh_session_percent: 60, fresh_session_turns: 40,
};

export const MODEL_STEPS = ["haiku", "sonnet", "opus"];
// Efforts a ladder rung may name. xhigh and max are never reached by an
// automatic bump: only a spec's REASONING (or an explicit --effort) asks them.
export const EFFORT_STEPS = ["low", "medium", "high", "xhigh"];
export const AUTO_EFFORT_CAP = "high";

const posInt = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0;

export function validateKibaConfig(raw: Partial<KibaConfig>, name = "kiba"): KibaConfig {
  const c: KibaConfig = {
    ...DEFAULT_KIBA, ...raw, ladder: { ...DEFAULT_KIBA.ladder, ...raw.ladder }, watchdog: { ...DEFAULT_KIBA.watchdog, ...raw.watchdog },
  };
  for (const k of ["stall_seconds", "max_turns_without_test", "tick_seconds"] as const) {
    if (!posInt(c.watchdog[k])) throw new Error(`profile ${name}: kiba.watchdog.${k} must be a positive integer`);
  }
  for (const k of Object.keys(c.ladder)) if (!(TASK_KINDS as readonly string[]).includes(k)) throw new Error(`profile ${name}: kiba.ladder has an unknown kind ${k} (${TASK_KINDS.join(", ")})`);
  for (const k of TASK_KINDS) {
    const r = c.ladder[k];
    if (!r || typeof r.model !== "string" || !r.model) throw new Error(`profile ${name}: kiba.ladder.${k} needs a model`);
    if (!EFFORT_STEPS.includes(r.effort)) throw new Error(`profile ${name}: kiba.ladder.${k}.effort must be one of ${EFFORT_STEPS.join(", ")}`);
  }
  if (!posInt(c.escalate_after)) throw new Error(`profile ${name}: kiba.escalate_after must be a positive integer`);
  if (!posInt(c.max_attempts)) throw new Error(`profile ${name}: kiba.max_attempts must be a positive integer`);
  // At most one automatic rung up: after escalate_after failures the task moves
  // up once (if it can stay at or below high), then goes back to the lead.
  if (c.max_attempts > c.escalate_after + 1) throw new Error(`profile ${name}: kiba.max_attempts must be at most escalate_after + 1 (one rung up, then back to the lead)`);
  if (!posInt(c.lane_timeout_seconds)) throw new Error(`profile ${name}: kiba.lane_timeout_seconds must be a positive integer`);
  if (!posInt(c.fresh_session_turns)) throw new Error(`profile ${name}: kiba.fresh_session_turns must be a positive integer`);
  if (!(c.fresh_session_percent > 0 && c.fresh_session_percent <= 100)) throw new Error(`profile ${name}: kiba.fresh_session_percent must be in (0, 100]`);
  // Keys of the retired conductor (lead_disallowed_tools, research, fast_path)
  // and kiba.pool, never consumed: dropped, still accepted in an older profile.
  for (const k of ["pool", "lead_disallowed_tools", "research", "fast_path"]) delete (c as unknown as Record<string, unknown>)[k];
  return c;
}

// ---- Task kind from the spec (code rule, same risk paths as route.ts).

export function codeKind(f: SpecFeatures): TaskKind {
  if (f.risk.length) return "risky";
  return f.mechanical ? "mechanical" : "normal";
}

// ---- Effort ladder: one rung up (model, then effort, never above high) after
// `escalate_after` failures; when no rung is left, or after max_attempts, the
// task goes back to the lead and the operator instead of a blind retry.

export type LadderStep = { to: "lane"; rung: Rung; steps: number } | { to: "operator"; why: string };

export function rungFor(kind: TaskKind, failures: number, cfg: Pick<KibaConfig, "ladder" | "escalate_after" | "max_attempts">): LadderStep {
  if (failures >= cfg.max_attempts) return { to: "operator", why: `${failures} failures: back to the lead and the operator` };
  const steps = Math.floor(failures / cfg.escalate_after);
  let rung: Rung = { ...cfg.ladder[kind] };
  for (let i = 0; i < steps; i++) {
    const up = bump(rung);
    if (!up) return { to: "operator", why: `${failures} failures at the top of the ladder (${rung.model}/${rung.effort}): back to the lead and the operator` };
    rung = up;
  }
  return { to: "lane", rung, steps };
}

// The next rung, or null at the top: xhigh and max stay explicit.
export function bump(r: Rung): Rung | null {
  const m = MODEL_STEPS.indexOf(r.model);
  if (m >= 0 && m < MODEL_STEPS.length - 1) return { model: MODEL_STEPS[m + 1], effort: r.effort };
  const e = EFFORT_STEPS.indexOf(r.effort);
  const cap = EFFORT_STEPS.indexOf(AUTO_EFFORT_CAP);
  return e >= 0 && e < cap ? { model: r.model, effort: EFFORT_STEPS[e + 1] } : null;
}

// `lane route` under Kiba (profile `kiba` section): the ladder replaces the effort rule
// (and the model, for a Claude lane), and two failures move one rung up
// instead of handing the spec back; max_attempts failures still escalate.
// A spec REASONING keeps its own effort.
// `hint` is the spec's KIND: it may raise the
// code kind, never lower it below a risk the paths show.
export function kibaRoute(r: Route, f: SpecFeatures, failures: number, cfg: KibaConfig, hint?: string): Route {
  if (r.action === "self" || f.reasoning) return r;
  const code = codeKind(f);
  const asked = hint && isCodeKind(hint) ? hint : undefined;
  const kind = asked && TASK_KINDS.indexOf(asked) > TASK_KINDS.indexOf(code) ? asked : code;
  const step = rungFor(kind, failures, cfg);
  if (step.to === "operator") return { ...r, action: "escalate", reasons: [...r.reasons, `kiba: ${step.why}`] };
  if (!r.to) return r;
  const { model, effort } = step.rung;
  const why = `kiba: ${kind} rung ${model}/${effort}${step.steps ? ` (${step.steps} up after ${failures} failures)` : ""}${r.to === "claude" ? "" : `; ${r.to} keeps its profile model`}`;
  return { ...r, action: "lane", effort, ...(r.to === "claude" ? { model } : {}), reasons: [...r.reasons, why] };
}

// ---- Code-first event filter with provenance (src/core/inbound.ts).

export { filterEvent, isNudge, provenance } from "../core/inbound.ts";
export type { EventKind, EventSource, FilterContext, InboundEvent, Verdict } from "../core/inbound.ts";
