// orch doctor: can each worker harness run a lane from here? One line per
// check, so a missing piece is named before a lane fails on it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { grokProfileInstalled } from "../harness/grok-runtime.ts";
import { join } from "node:path";
import { detect, HARNESS_IDS, onPath, REGISTRY, type Which } from "../harness/registry.ts";

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

export function doctorChecks(home: string, which: Which = onPath, nested: Probe = nestedUserns): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const detected = detect(which);
  const leadHarnesses = detected.filter((harness) => REGISTRY[harness].lead);
  let ok = leadHarnesses.length > 0;
  const check = (label: string, missing: string[], fix: string) => {
    if (missing.length) ok = false;
    lines.push(missing.length ? `FAIL ${label}: missing ${missing.join(", ")} (${fix})` : `ok   ${label}`);
  };
  if (!leadHarnesses.length) check("lead harness", ["no lead-capable harness installed"], "install Claude Code, Codex CLI, or Grok CLI");
  const absent = (bins: string[]) => bins.filter((bin) => !which(bin));
  for (const harness of HARNESS_IDS) {
    if (!detected.includes(harness)) {
      lines.push(`skip ${harness} (not installed)`);
      continue;
    }
    if (!REGISTRY[harness].lead) {
      lines.push(`skip ${harness} (not lead-capable)`);
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
    } else if (harness === "codex") {
      check("codex worker", absent(["git"]), "install the Codex CLI");
      const rules = join(home, ".codex", "rules", "orch.rules");
      check("codex lead rule (lane, orch outside the sandbox)", existsSync(rules) ? [] : ["~/.codex/rules/orch.rules"], "orch install");
    } else {
      check("grok worker", absent(["git"]), "install the Grok CLI");
      check("grok worker sandbox profile orch-lane", grokProfileInstalled(home) ? [] : ["~/.grok/sandbox.toml [profiles.orch-lane], as orch installs it"], "orch install");
    }
  }
  return { ok, lines };
}
