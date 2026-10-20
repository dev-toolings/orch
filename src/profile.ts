import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type Harness = "claude" | "codex" | "grok";
export const HARNESSES: Harness[] = ["claude", "codex", "grok"];

export interface ModelChoice {
  model?: string | null;
  effort?: string;
}

export interface Profile {
  name: string;
  lead: Record<Harness, ModelChoice>;
  lanes: Record<Harness, ModelChoice>;
  review: Record<Harness, ModelChoice & { to: Harness }>;
  limits: {
    max_concurrent: number;
    max_depth: number;
    report_max_bytes: number;
    timeout_seconds: number;
  };
}

export const ROOT = join(import.meta.dir, "..");

export function loadProfile(name = process.env.ORCH_PROFILE ?? "max20"): Profile {
  const raw = readFileSync(join(ROOT, "catalog", "profiles", `${name}.yaml`), "utf8");
  const p = parse(raw) as Profile;
  for (const h of HARNESSES) {
    if (!p.lead?.[h] || !p.lanes?.[h] || !p.review?.[h]) throw new Error(`profile ${name}: missing ${h}`);
  }
  if (p.lanes.grok.model) throw new Error(`profile ${name}: grok lanes must inherit their model`);
  return p;
}
