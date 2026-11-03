// Kiba, the only lead, on Claude Code only: one native `claude --agent kiba`
// session with one model/tool loop. Lanes remain optional, never a relay
// required for an ordinary edit. Inline definitions avoid stale installed agents.
// The always-on conductor is `orch serve` (src/serve/).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LeadPolicy } from "../core/policy.ts";
import { ROOT, type ModelChoice, type Profile } from "../core/profile.ts";
import { applyRole, roleChoice } from "../core/roles.ts";
import { leadSettings } from "../install/render.ts";

// Kiba's profile when none is named: `kiba` (the ladder, review roles).
export function kibaProfile(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env.ORCH_PROFILE ?? "kiba";
}

// policy.yaml `lead.claude: { model, effort }` wins over the profile and the role.
export function withLeadOverride(choice: ModelChoice, lead: Pick<LeadPolicy, "claude">): ModelChoice {
  const o = lead.claude ?? {};
  return { ...choice, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort as ModelChoice["effort"] } : {}) };
}

export function nativeChoice(profile: Profile, cwd = process.cwd()): ModelChoice {
  return { ...applyRole(profile.lead.claude, roleChoice("coordinator", "claude", profile, cwd)), permission_mode: profile.lead.claude.permission_mode };
}

export function nativeAgent(): { description: string; prompt: string } {
  return { description: "Kiba, the native developer with memory and optional lanes. Never spawn as a subagent.", prompt: readFileSync(join(ROOT, "catalog/kiba-native.md"), "utf8").trim() };
}

export function nativeKibaArgv(choice: ModelChoice, extra: string[] = []): string[] {
  const asked = (...flags: string[]) => extra.some((a) => flags.includes(a.split("=")[0]));
  const argv = ["claude", "--agent", "kiba", "--agents", JSON.stringify({ kiba: nativeAgent() }), "--settings", JSON.stringify(JSON.parse(leadSettings()))];
  if (choice.model && !asked("--model", "-m")) argv.push("--model", choice.model);
  if (choice.effort && !asked("--effort")) argv.push("--effort", choice.effort);
  if (choice.permission_mode && !asked("--permission-mode", "--dangerously-skip-permissions")) argv.push("--permission-mode", choice.permission_mode);
  return [...argv, ...extra];
}
