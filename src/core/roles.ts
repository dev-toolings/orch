// Per-role model/effort: coordinator (lead), explore (read), edit (lanes),
// review (cross-family). Profile defaults, then orch.yaml `roles:` overlays.
import type { Harness } from "./profile.ts";
import type { ModelChoice, Profile } from "./profile.ts";
import { loadOrchDoc } from "./orch-yaml.ts";

export const ROLE_NAMES = ["coordinator", "explore", "edit", "review"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export type RoleTable = Partial<Record<RoleName, Partial<Record<Harness, ModelChoice>>>>;

function asChoice(value: unknown): ModelChoice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const choice: ModelChoice = {};
  if (typeof rec.model === "string" || rec.model === null) choice.model = rec.model as string | null;
  if (typeof rec.effort === "string") choice.effort = rec.effort;
  return Object.keys(choice).length ? choice : undefined;
}

export function parseRoles(raw: unknown): RoleTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RoleTable = {};
  for (const name of ROLE_NAMES) {
    const row = (raw as Record<string, unknown>)[name];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const by: Partial<Record<Harness, ModelChoice>> = {};
    for (const h of ["claude", "codex", "grok"] as const) {
      const choice = asChoice((row as Record<string, unknown>)[h]);
      if (choice) by[h] = choice;
    }
    if (Object.keys(by).length) out[name] = by;
  }
  return out;
}

export function profileRoles(profile: Profile): RoleTable {
  return parseRoles(profile.roles);
}

export function projectRoles(cwd = process.cwd()): RoleTable {
  try {
    const doc = loadOrchDoc(cwd);
    return doc ? parseRoles(doc.roles) : {};
  } catch {
    return {};
  }
}

export function mergeRoles(...tables: RoleTable[]): RoleTable {
  const out: RoleTable = {};
  for (const table of tables) {
    for (const name of ROLE_NAMES) {
      const row = table[name];
      if (!row) continue;
      out[name] = { ...out[name], ...Object.fromEntries(
        (["claude", "codex", "grok"] as const).map((h) => [h, { ...out[name]?.[h], ...row[h] }]),
      ) };
    }
  }
  return out;
}

export function roleChoice(
  role: RoleName,
  harness: Harness,
  profile: Profile,
  cwd = process.cwd(),
): ModelChoice {
  const merged = mergeRoles(profileRoles(profile), projectRoles(cwd));
  return merged[role]?.[harness] ?? {};
}

export function applyRole(base: ModelChoice, overlay: ModelChoice): ModelChoice {
  return {
    ...base,
    ...(overlay.model !== undefined ? { model: overlay.model } : {}),
    ...(overlay.effort !== undefined ? { effort: overlay.effort } : {}),
    ...(overlay.permission_mode !== undefined ? { permission_mode: overlay.permission_mode } : {}),
  };
}

// Role overlay first, then an explicit --model / --effort. The flag always wins.
export function withExplicit(
  base: ModelChoice,
  overlay: ModelChoice,
  explicit: { model?: string; effort?: string } = {},
): ModelChoice {
  return applyRole(applyRole(base, overlay), {
    ...(explicit.model ? { model: explicit.model } : {}),
    ...(explicit.effort ? { effort: explicit.effort } : {}),
  });
}
