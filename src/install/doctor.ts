// orch doctor: can each worker harness run a lane from here? One line per
// check, so a missing piece is named before a lane fails on it.
import { shellcheckDoctorLine } from "./shellcheck.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { grokProfileInstalled } from "../harness/grok-runtime.ts";
import { detect, HARNESS_IDS, onPath, REGISTRY, type Which } from "../harness/registry.ts";
import { loadBrainConfig } from "../brain/db.ts";
import { ROOT } from "../core/profile.ts";
import { stateDir } from "../core/paths.ts";
import { loadHookPolicy } from "../core/hook-policy.ts";
import { leadSettingsStatus } from "./lead-settings.ts";

export type Probe = () => boolean;

// Claude Code's sandbox runs its seccomp helper inside bwrap, and that helper
// opens a second user namespace. Ubuntu 24.04+ (apparmor_restrict_unprivileged_userns
// = 1, profile bwrap-userns-restrict) strips capabilities from bwrap's children,
// so the helper fails and every sandboxed command with it. The same nesting,
// without Claude Code:
export const nestedUserns: Probe = () =>
  spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user",
    "unshare", "--user", "--map-root-user", "true"], { stdio: "ignore" }).status === 0;

// System packages the sandboxed Claude worker needs on Linux, by binary.
const CLAUDE_SANDBOX_PACKAGES: Record<string, string> = { bwrap: "bubblewrap", socat: "socat" };

// apt packages to install for the Claude worker's sandbox; empty off Linux.
export function missingSystemPackages(which: Which = onPath): string[] {
  if (process.platform !== "linux") return [];
  return Object.entries(CLAUDE_SANDBOX_PACKAGES).filter(([bin]) => !which(bin)).map(([, pkg]) => pkg);
}

// The installed lead settings against the current template: stale rule names
// (Claude Code warns about each at start-up) or an older template. A missing
// file is not a failure here: Claude may be installed for workers only.
function leadSettingsLine(home: string, state: string, lines: string[], fail: () => void) {
  const label = "claude lead settings ~/.claude/orch/lead-settings.json";
  const status = leadSettingsStatus(home, state);
  const shown = status.stale.slice(0, 3).join(", ") + (status.stale.length > 3 ? `, +${status.stale.length - 3} more` : "");
  if (status.state === "missing") lines.push(`skip ${label} (not installed: orch install)`);
  else if (status.state === "current") lines.push(`ok   ${label}`);
  else if (status.state === "outdated") {
    fail();
    lines.push(`FAIL ${label}: older template${status.stale.length ? `, stale rules ${shown}` : ""} (orch install; kiba also refreshes it at launch)`);
  } else if (status.stale.length) {
    fail();
    lines.push(`FAIL ${label}: edited since install, stale rules ${shown} (use Edit(<path>) rules, or revert it and orch install)`);
  } else lines.push(`ok   ${label} (edited since install)`);
}

// Files earlier installs wrote for leads that are gone: the dispatch-only
// conductor (presence unit) and the Codex and Grok leads. `orch install`
// removes the unedited ones its manifest recorded; the rest are the operator's.
export const RETIRED_LEAD_FILES = [
  ".config/systemd/user/orch-kiba.service",
  ".grok/agents/kiba.md",
  ".grok/agents/lead-explore.md",
  ".grok/hooks/orch.json",
];

export function retiredLeadLine(home: string): string | null {
  const left = RETIRED_LEAD_FILES.filter((p) => existsSync(join(home, p)));
  return left.length ? `WARN retired lead files still installed: ${left.map((p) => `~/${p}`).join(", ")} (Kiba runs on Claude only and orch serve replaced the conductor; orch install removes the unedited ones it recorded)` : null;
}

export function doctorChecks(
  home: string,
  which: Which = onPath,
  nested: Probe = nestedUserns,
  memory?: { provider?: string; reachable?: boolean },
  state: string = stateDir(),
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const hookPolicy = loadHookPolicy({ ...process.env, HOME: home });
  if (hookPolicy.error || hookPolicy.warnings.length) lines.push(`WARN hook policy: ${[...(hookPolicy.error ? [`${hookPolicy.error}; using defaults`] : []), ...hookPolicy.warnings].join("; ")}`);
  const detected = detect(which);
  let ok = detected.some((harness) => REGISTRY[harness].lead);
  const check = (label: string, missing: string[], fix: string) => {
    if (missing.length) ok = false;
    lines.push(missing.length ? `FAIL ${label}: missing ${missing.join(", ")} (${fix})` : `ok   ${label}`);
  };
  let provider = memory?.provider ?? process.env.ORCH_MEMORY_PROVIDER;
  if (!provider) {
    try { provider = loadBrainConfig(join(ROOT, "catalog", "brain.yaml")).memory_provider; }
    catch { provider = undefined; }
  }
  if (provider !== "hindsight" && provider !== "brain") {
    ok = false;
    lines.push(`FAIL memory provider: unknown ${provider ?? "(unset)"} (set ORCH_MEMORY_PROVIDER to hindsight or brain)`);
  } else {
    lines.push(`ok   memory provider ${provider}`);
    if (memory && "reachable" in memory) {
      if (memory.reachable) lines.push(`ok   memory reachability (${provider})`);
      else {
        ok = false;
        lines.push(`FAIL memory reachability: ${provider} unreachable`);
      }
    }
  }
  if (!ok) check("lead harness", ["Claude Code"], "install Claude Code: Kiba runs on Claude only, Codex and Grok are lane workers and reviewers");
  const retired = retiredLeadLine(home);
  if (retired) lines.push(retired);
  const absent = (bins: string[]) => bins.filter((bin) => !which(bin));
  for (const harness of HARNESS_IDS) {
    if (!detected.includes(harness)) {
      lines.push(`skip ${harness} (not installed)`);
      continue;
    }
    if (harness === "claude") {
      const missing = absent(["git"]);
      if (process.platform === "linux") missing.push(...absent(["bwrap", "socat"]));
      check("claude worker (sandboxed Bash)", missing, "sudo apt install bubblewrap socat");
      if (process.platform === "linux" && !missing.length) {
        check("claude worker sandbox can nest a user namespace", nested() ? [] : ["nested user namespace in bwrap"],
          "AppArmor blocks it: scripts/claude-sandbox-apparmor.sh --install");
      }
      leadSettingsLine(home, state, lines, () => { ok = false; });
    } else if (harness === "codex") {
      check("codex worker", absent(["git"]), "install the Codex CLI");
    } else {
      check("grok worker", absent(["git"]), "install the Grok CLI");
      check("grok worker sandbox profile orch-lane", grokProfileInstalled(home) ? [] : ["~/.grok/sandbox.toml [profiles.orch-lane], as orch installs it"], "orch install");
    }
  }
  lines.push(shellcheckDoctorLine(which, home));
  return { ok, lines };
}
