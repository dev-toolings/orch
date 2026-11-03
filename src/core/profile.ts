import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { HarnessId } from "../harness/registry.ts";
import type { RouteConfig } from "../lanes/route.ts";
import { type KibaConfig, validateKibaConfig } from "../kiba/rules.ts";

export type Harness = "claude" | "codex" | "grok";
export const HARNESSES: Harness[] = ["claude", "codex", "grok"];

export interface ModelChoice {
  model?: string | null;
  effort?: string;
  // Claude: passed as --permission-mode. Other leads cannot change approvals.
  permission_mode?: string;
}

export type ReviewChoice = ModelChoice & {
  to: HarnessId;
  high?: ModelChoice;
  fallback?: HarnessId[];
};

export interface Profile {
  name: string;
  // Kiba runs on Claude only: the lead is Claude (Codex and Grok are lane
  // workers and reviewers). Older profiles' lead.codex and lead.grok are dropped.
  lead: { claude: ModelChoice };
  lanes: Record<Harness, ModelChoice>;
  // `high` overrides model and effort for a high-risk review (data migration,
  // security-sensitive path, public API change): `lane review --risk high`.
  review: Record<Harness, ReviewChoice>;
  // Model of the Claude read-only explorer (`Explore` / `lead-explore`);
  // without it the built-in Explore inherits the lead's model.
  explore?: { claude?: string };
  // Optional per-role model/effort (coordinator, explore, edit, review).
  // A project's orch.yaml `roles:` overlays these at run time.
  roles?: unknown;
  // `lane route`: harness order before the ledger has evidence, inline size
  // threshold, closed runs needed before a record outranks the order.
  route?: Partial<RouteConfig>;
  // `lane contest`: who answers (installed ones only) and the judge, a Claude
  // model other than the lead's so it does not grade its own family's habits.
  contest?: { to?: HarnessId[]; judge?: ModelChoice };
  // `orch improve run` (routine improve): the read-only Claude that turns the
  // day's evidence into proposals; the lead's model when absent.
  improve?: ModelChoice;
  // Optional read-only planner (architecture / simplification). Configurable
  // harness; file writes are refused (plan mode / read-only sandbox).
  planner?: { to?: string; model?: string; effort?: string };
  // Kiba's ladder and watchdog, used by orch serve and `lane route`: closed
  // task kinds, effort ladder with escalation. Absent: built-in defaults.
  kiba?: Partial<KibaConfig>;
  limits: {
    max_concurrent_ceiling: number;
    verify_concurrent: number;
    worker_gib: number;
    verify_gib: number;
    reserve_gib: number;
    max_depth: number;
    report_max_bytes: number;
    timeout_seconds: number;
    // How long a lane or consultation waits for a slot when the lane budget
    // is full before reporting unavailable (default 600, 0 refuses at once).
    slot_wait_seconds?: number;
    // Share of the model's context window that triggers a fresh-session
    // handoff. Percent of input+cache tokens, never transcript bytes.
    fresh_session_percent?: number;
  };
}

export const ROOT = join(import.meta.dir, "..", "..");

export function validateProfile(p: Profile, name = p.name): Profile {
  if (!p.lead?.claude) throw new Error(`profile ${name}: missing lead.claude`);
  p.lead = { claude: p.lead.claude };
  for (const h of HARNESSES) {
    if (!p.lanes?.[h] || !p.review?.[h]) throw new Error(`profile ${name}: missing ${h}`);
  }
  for (const [h, choice] of Object.entries(p.review)) {
    if (!choice || !(HARNESSES as string[]).includes(choice.to)) {
      throw new Error(`profile ${name}: invalid review target for ${h}`);
    }
    if (choice.fallback?.some((fallback) => !(HARNESSES as string[]).includes(fallback))) {
      throw new Error(`profile ${name}: invalid review fallback for ${h}`);
    }
  }
  const fresh = p.limits?.fresh_session_percent;
  if (fresh !== undefined && !(typeof fresh === "number" && Number.isFinite(fresh) && fresh > 0 && fresh <= 100)) {
    throw new Error(`profile ${name}: limits.fresh_session_percent must be in (0, 100]`);
  }
  if (p.kiba !== undefined) p.kiba = validateKibaConfig(p.kiba ?? {}, name);
  return p;
}

export function loadProfile(name = process.env.ORCH_PROFILE ?? "max20"): Profile {
  const raw = readFileSync(join(ROOT, "catalog", "profiles", `${name}.yaml`), "utf8");
  return validateProfile(parse(raw) as Profile, name);
}
