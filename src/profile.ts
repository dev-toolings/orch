import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type Harness = "claude" | "codex" | "grok";
export const HARNESSES: Harness[] = ["claude", "codex", "grok"];

export interface ModelChoice {
  model?: string | null;
  effort?: string;
  // Lead only. Claude: passed as --permission-mode. Codex: only "yolo", which
  // starts it with --dangerously-bypass-approvals-and-sandbox (alias --yolo).
  permission_mode?: string;
}

export interface Profile {
  name: string;
  lead: Record<Harness, ModelChoice>;
  lanes: Record<Harness, ModelChoice>;
  // `high` overrides model and effort for a high-risk review (data migration,
  // security-sensitive path, public API change): `lane review --risk high`.
  review: Record<Harness, ModelChoice & { to: Harness; high?: ModelChoice }>;
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
  if (p.lead.grok.permission_mode) throw new Error(`profile ${name}: permission_mode is not supported for the grok lead`);
  const codexMode = p.lead.codex.permission_mode;
  if (codexMode && codexMode !== "yolo") throw new Error(`profile ${name}: the codex lead permission_mode can only be yolo`);
  if (p.lanes.grok.model) throw new Error(`profile ${name}: grok lanes must inherit their model`);
  return p;
}
