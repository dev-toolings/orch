// Read-only planner: a second architecture opinion. the lead keeps its own plan,
// shows both, and prefers the one that deletes more.
import { loadOrchDoc } from "../core/orch-yaml.ts";
import type { Harness, Profile } from "../core/profile.ts";
import { HARNESSES } from "../core/profile.ts";

export interface PlannerChoice {
  to: Harness;
  model?: string;
  effort?: string;
}

export function parsePlanner(raw: unknown): PlannerChoice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const to = typeof rec.to === "string" && (HARNESSES as string[]).includes(rec.to) ? rec.to as Harness : null;
  if (!to) return null;
  return {
    to,
    ...(typeof rec.model === "string" ? { model: rec.model } : {}),
    ...(typeof rec.effort === "string" ? { effort: rec.effort } : {}),
  };
}

export function plannerOf(profile: Profile, cwd = process.cwd()): PlannerChoice {
  try {
    const doc = loadOrchDoc(cwd);
    const fromYaml = parsePlanner(doc?.planner);
    if (fromYaml) return fromYaml;
  } catch { /* fall through */ }
  return parsePlanner(profile.planner) ?? { to: "codex", effort: "medium" };
}

// Count explicit structured deletions only (DELETE:/REMOVE: sections or
// "- path (N lines)"). A negated sentence ("Do not delete files") is 0.
export function deletionScore(text: string): number {
  let n = 0;
  let section: "in" | "out" = "out";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(DELETE|REMOVE|DROPS?|RETIRE):\s*(.*)$/i.exec(line);
    if (heading) {
      section = "in";
      if (heading[2]) n += heading[2].split(/[,;]+/).map((s) => s.trim()).filter(Boolean).length;
      continue;
    }
    if (/^[A-Z][A-Z0-9 /_-]{0,24}:\s*$/.test(line)) {
      section = "out";
      continue;
    }
    if (section === "in" && /^[-*]\s+\S/.test(line)) n++;
    else if (/^[-*]\s+\S+\s+\(\s*\d+\s+lines?\s*\)/.test(line)) n++;
  }
  return n;
}

export function planDiff(lead: string, other: string): string {
  const a = new Set(lead.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const b = new Set(other.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const onlyLead = [...a].filter((l) => !b.has(l));
  const onlyOther = [...b].filter((l) => !a.has(l));
  const lines = [
    ...onlyLead.map((l) => `- ${l}`),
    ...onlyOther.map((l) => `+ ${l}`),
  ];
  return lines.join("\n") || "(plans agree)";
}

export function comparePlans(lead: string, other: string): {
  preferred: "lead" | "planner" | "tie";
  reason: string;
  leadDeletes: number;
  plannerDeletes: number;
  diff: string;
} {
  const leadDeletes = deletionScore(lead);
  const plannerDeletes = deletionScore(other);
  const diff = planDiff(lead, other);
  if (plannerDeletes > leadDeletes) {
    return { preferred: "planner", reason: `planner deletes more (${plannerDeletes} > ${leadDeletes})`, leadDeletes, plannerDeletes, diff };
  }
  if (leadDeletes > plannerDeletes) {
    return { preferred: "lead", reason: `lead deletes more (${leadDeletes} > ${plannerDeletes})`, leadDeletes, plannerDeletes, diff };
  }
  return { preferred: "tie", reason: `same deletion score (${leadDeletes})`, leadDeletes, plannerDeletes, diff };
}
