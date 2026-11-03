// Cooperative operator configuration for lead hooks, never worker confinement.
// Keep this module independent of profiles and the control/spend policy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HookPermission = "off" | "ask" | "deny";
export type HookMode = "bypass" | "default";
export const PERMISSION_DEFAULTS = {
  "secrets.read": { bypass: "deny", default: "deny" },
  "secrets.edit": { bypass: "deny", default: "deny" },
  "orch.guard-files": { bypass: "off", default: "deny" },
  "rm.recursive": { bypass: "ask", default: "ask" },
  "rm.outside": { bypass: "ask", default: "ask" },
  "git.push": { bypass: "off", default: "ask" },
  "net.calls": { bypass: "off", default: "ask" },
  "git.hooks-path": { bypass: "off", default: "ask" },
  "guardrail.files": { bypass: "off", default: "ask" },
  "protected.paths": { bypass: "off", default: "ask" },
} as const;
export type HookPermissionId = keyof typeof PERMISSION_DEFAULTS;
export const BEHAVIOR_IDS = ["nudge.post-edit", "nudge.fresh-session", "stop.lane-pending"] as const;
// Behaviors of retired leads (the Codex conductor deny): ignored without a warning.
const RETIRED_BEHAVIORS = ["codex.conductor-deny"];
export type HookBehaviorId = typeof BEHAVIOR_IDS[number];
type Toggle = "on" | "off";
type Origin = "default" | "file";
export interface HookPolicy {
  permissions: Record<HookPermissionId, Record<HookMode, HookPermission>>;
  behaviors: Record<HookBehaviorId, Toggle>;
  origins: Record<HookPermissionId, Record<HookMode, Origin>> & Record<HookBehaviorId, Origin>;
  warnings: string[];
  error?: string;
}

export function hookPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCH_HOOK_POLICY || join(env.HOME || homedir(), ".orch", "policy", "hooks.yaml");
}

function defaults(env: NodeJS.ProcessEnv): HookPolicy {
  return {
    permissions: structuredClone(PERMISSION_DEFAULTS),
    behaviors: {
      "nudge.post-edit": env.ORCH_CONDUCTOR === "native" ? "off" : "on",
      "nudge.fresh-session": env.ORCH_PRESENCE === "1" ? "on" : "off",
      "stop.lane-pending": "on",
    },
    origins: Object.fromEntries([
      ...Object.keys(PERMISSION_DEFAULTS).map((id) => [id, { bypass: "default", default: "default" }]),
      ...BEHAVIOR_IDS.map((id) => [id, "default"]),
    ]) as HookPolicy["origins"],
    warnings: [],
  };
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

// Each hook reads afresh, including in a long-lived caller. Bun's built-in
// YAML parser loads no JS dependency and is called only for an existing file.
export function loadHookPolicy(env: NodeJS.ProcessEnv = process.env): HookPolicy {
  const result = defaults(env);
  let source: string;
  try { source = readFileSync(hookPolicyPath(env), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.error = String(error);
    return result;
  }
  try {
    const doc = mapping(Bun.YAML.parse(source), "hook policy");
    for (const key of Object.keys(doc)) {
      if (key !== "permissions" && key !== "behaviors") result.warnings.push(`unknown hook policy table ${key}, ignored`);
    }
    if (doc.permissions !== undefined) {
      for (const [id, raw] of Object.entries(mapping(doc.permissions, "permissions"))) {
        if (!Object.hasOwn(PERMISSION_DEFAULTS, id)) {
          result.warnings.push(`unknown hook permission ${id}, ignored`);
          continue;
        }
        const rule = id as HookPermissionId;
        for (const [mode, value] of Object.entries(mapping(raw, id))) {
          if (mode !== "bypass" && mode !== "default") throw new Error(`${id}: unknown mode ${mode}`);
          if (value !== "off" && value !== "ask" && value !== "deny") throw new Error(`${id}.${mode} must be off, ask or deny`);
          result.permissions[rule][mode] = value;
          result.origins[rule][mode] = "file";
        }
      }
    }
    if (doc.behaviors !== undefined) {
      for (const [id, value] of Object.entries(mapping(doc.behaviors, "behaviors"))) {
        if (RETIRED_BEHAVIORS.includes(id)) continue;
        if (!(BEHAVIOR_IDS as readonly string[]).includes(id)) {
          result.warnings.push(`unknown hook behavior ${id}, ignored`);
          continue;
        }
        if (value !== "on" && value !== "off") throw new Error(`${id} must be on or off`);
        result.behaviors[id as HookBehaviorId] = value;
        result.origins[id as HookBehaviorId] = "file";
      }
    }
    return result;
  } catch (error) {
    // A bad file cannot leave earlier overrides partially applied.
    return { ...defaults(env), error: String(error), warnings: result.warnings };
  }
}

export interface HookGuard { id: HookPermissionId; reason: string }

// Deny wins over ask across a compound command; off never masks another rule.
export function hookGuardDecision(
  policy: HookPolicy, guards: HookGuard[], mode: HookMode, headless = false,
): { decision: "ask" | "deny"; reason: string } | null {
  let ask: string | undefined;
  for (const guard of guards) {
    const decision = policy.permissions[guard.id][mode];
    if (decision === "deny") return { decision, reason: guard.reason };
    if (decision === "ask") ask ??= guard.reason;
  }
  return ask ? { decision: headless ? "deny" : "ask", reason: ask } : null;
}

export function hookPolicyDefaultsFile(): string {
  return [
    "# Cooperative lead guards. Worker confinement is independent.",
    "# Permissions: off | ask | deny. Missing values inherit defaults.",
    "# Hooks reload each call; settings-level denies update at next launch.",
    "permissions:",
    ...Object.entries(PERMISSION_DEFAULTS).map(([id, modes]) => `  ${id}: { bypass: ${modes.bypass}, default: ${modes.default} }`),
    "behaviors:",
    "  # Omit these two entries to keep environment-dependent defaults:",
    "  # nudge.post-edit: off  # off in native Kiba, on in other lead sessions",
    "  # nudge.fresh-session: off  # on only with ORCH_PRESENCE=1",
    "  stop.lane-pending: on",
    "",
  ].join("\n");
}

export async function hookPolicyCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, ...rest] = args;
  if (rest.length || !["show", "edit", "reset"].includes(command)) throw new Error("usage: orch policy show|edit|reset");
  const path = hookPolicyPath(env);
  if (command === "show") {
    const policy = loadHookPolicy(env);
    console.log(`Hook policy: ${path}\nid\tbypass\tdefault\torigin (bypass/default)`);
    for (const [id, modes] of Object.entries(policy.permissions)) {
      const origins = policy.origins[id as HookPermissionId];
      console.log(`${id}\t${modes.bypass}\t${modes.default}\t${origins.bypass}/${origins.default}`);
    }
    console.log("\nbehavior\tvalue\torigin");
    for (const id of BEHAVIOR_IDS) console.log(`${id}\t${policy.behaviors[id]}\t${policy.origins[id]}`);
    console.log("\nInherited user/managed permissions are outside this policy.\nSettings contain only denies shared by both modes; hooks decide mode-specific rules live.");
    if (policy.error) console.error(`WARN hook policy: ${policy.error}; using defaults`);
    for (const warning of policy.warnings) console.error(`WARN ${warning}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (command === "reset") writeFileSync(path, hookPolicyDefaultsFile(), { mode: 0o600 });
  else {
    try { writeFileSync(path, hookPolicyDefaultsFile(), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const { spawnSync } = await import("node:child_process");
    // EDITOR is operator-owned shell syntax; the policy path is a separate arg.
    const result = spawnSync("sh", ["-c", `${env.EDITOR || "vi"} "$1"`, "orch-policy", path], { stdio: "inherit", env });
    if (result.error || result.status !== 0) throw new Error(`policy editor failed: ${result.error?.message ?? result.status}`);
  }
  console.log(path);
}
