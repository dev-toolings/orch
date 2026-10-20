// orch doctor: can each worker harness run a lane from here? One line per
// check, so a missing piece is named before a lane fails on it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { grokProfileInstalled } from "./lane.ts";
import { join } from "node:path";

export type Which = (bin: string) => boolean;
export type Probe = () => boolean;

// Claude Code's sandbox runs its seccomp helper inside bwrap, and that helper
// opens a second user namespace. Ubuntu 24.04+ (apparmor_restrict_unprivileged_userns
// = 1, profile bwrap-userns-restrict) strips capabilities from bwrap's children,
// so the helper fails and every sandboxed command with it. The same nesting,
// without Claude Code:
export const nestedUserns: Probe = () =>
  spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user",
    "unshare", "--user", "--map-root-user", "true"], { stdio: "ignore" }).status === 0;

export const onPath: Which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;

// System packages the sandboxed Claude worker needs on Linux, by binary.
const CLAUDE_SANDBOX_PACKAGES: Record<string, string> = { bwrap: "bubblewrap", socat: "socat" };

// apt packages to install for the Claude worker's sandbox; empty off Linux.
export function missingSystemPackages(which: Which = onPath): string[] {
  if (process.platform !== "linux") return [];
  return Object.entries(CLAUDE_SANDBOX_PACKAGES).filter(([bin]) => !which(bin)).map(([, pkg]) => pkg);
}

export function doctorChecks(home: string, which: Which = onPath, nested: Probe = nestedUserns): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const check = (label: string, missing: string[], fix: string) => {
    if (missing.length) ok = false;
    lines.push(missing.length ? `FAIL ${label}: missing ${missing.join(", ")} (${fix})` : `ok   ${label}`);
  };
  const absent = (bins: string[]) => bins.filter((b) => !which(b));

  check("codex worker", absent(["codex", "git"]), "install the Codex CLI");
  check("grok worker", absent(["grok", "git"]), "install the Grok CLI");
  // Grok write workers run under orch's `orch-lane` profile (no child network).
  check("grok worker sandbox profile orch-lane", grokProfileInstalled(home) ? [] : ["~/.grok/sandbox.toml [profiles.orch-lane], as orch installs it"], "orch install");
  // The Claude write worker runs Bash in Claude Code's OS sandbox, which needs
  // bubblewrap and socat on Linux; without them it refuses to start.
  const claudeMissing = absent(["claude", "git"]);
  if (process.platform === "linux") claudeMissing.push(...absent(["bwrap", "socat"]));
  check("claude worker (sandboxed Bash)", claudeMissing, "sudo apt install bubblewrap socat");
  if (process.platform === "linux" && !claudeMissing.length) {
    check("claude worker sandbox can nest a user namespace", nested() ? [] : ["nested user namespace in bwrap"],
      "AppArmor blocks it: scripts/claude-sandbox-apparmor.sh --install");
  }
  // A Codex lead runs lane and orch only through this exec-policy rule.
  const rules = join(home, ".codex", "rules", "orch.rules");
  check("codex lead rule (lane, orch outside the sandbox)", existsSync(rules) ? [] : ["~/.codex/rules/orch.rules"], "orch install");
  return { ok, lines };
}
