// orch kiba [args]: start Kiba, exactly as the `kiba` command does. The
// subcommands of the retired dispatch-only conductor (mcp, run, wait,
// status, watchdog, event, github) now point at orch serve.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const KIBA_USAGE = "usage: orch kiba [claude args]  (the conductor is orch serve: orch serve [--once] | migrate, orch task ...)";
const RETIRED = new Set(["mcp", "run", "wait", "status", "watchdog", "event", "github"]);

export async function kiba(rest: string[]): Promise<void> {
  const [sub] = rest;
  if (sub && RETIRED.has(sub)) {
    console.error(`orch kiba ${sub}: the dispatch-only conductor is retired; orch serve replaced it (orch task list, orch serve --once, kiba --conductor for its status)`);
    process.exitCode = 2;
    return;
  }
  if (sub === "help" || sub === "--help") { console.log(KIBA_USAGE); return; }
  const r = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "..", "lead.ts"), ...rest], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
}
