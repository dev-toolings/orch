// orch doctor: can each worker harness run a lane from here? One line per
// check, so a missing piece is named before a lane fails on it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Which = (bin: string) => boolean;

export const onPath: Which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;

export function doctorChecks(home: string, which: Which = onPath): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const check = (label: string, missing: string[], fix: string) => {
    if (missing.length) ok = false;
    lines.push(missing.length ? `FAIL ${label}: missing ${missing.join(", ")} (${fix})` : `ok   ${label}`);
  };
  const absent = (bins: string[]) => bins.filter((b) => !which(b));

  check("codex worker", absent(["codex", "git"]), "install the Codex CLI");
  check("grok worker", absent(["grok", "git"]), "install the Grok CLI");
  // The Claude write worker runs Bash in Claude Code's OS sandbox, which needs
  // bubblewrap and socat on Linux; without them it refuses to start.
  const claudeMissing = absent(["claude", "git"]);
  if (process.platform === "linux") claudeMissing.push(...absent(["bwrap", "socat"]));
  check("claude worker (sandboxed Bash)", claudeMissing, "sudo apt install bubblewrap socat");
  // A Codex lead runs lane and orch only through this exec-policy rule.
  const rules = join(home, ".codex", "rules", "orch.rules");
  check("codex lead rule (lane, orch outside the sandbox)", existsSync(rules) ? [] : ["~/.codex/rules/orch.rules"], "orch install");
  return { ok, lines };
}
