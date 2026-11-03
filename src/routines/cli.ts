// orch routine list|run|status|journal (see routines.ts).
import { parseArgs } from "node:util";
import { EXIT_UNAVAILABLE } from "../brain/db.ts";
import { paint, status, useColor } from "../core/color.ts";
import { loadPresenceConfig } from "../presence/presence.ts";
import { notify } from "../presence/notify.ts";
import { histories, loadRoutines, nextRun, readJournal, runRoutine, tick } from "./routines.ts";

export const ROUTINE_USAGE = `usage: orch routine list
       orch routine tick           run every routine that is due (orch-routines.timer)
       orch routine run <id>       one run now, due or not, under the routine lock
       orch routine status         last run and next run of each routine
       orch routine journal [--limit n]`;

export async function routine(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { limit: { type: "string" } } });
  const routines = loadRoutines();
  const color = useColor();
  if (sub === "list") {
    for (const r of routines) console.log(`${r.id.padEnd(18)} ${r.enabled ? "on " : paint("off", "dim", color)}  every ${r.every.padEnd(4)}${r.retry ? ` retry ${r.retry}` : ""}  ${r.description}`);
  } else if (sub === "tick") {
    const channel = loadPresenceConfig().notify;
    const { ran, busy } = await tick(routines, { notify: (n) => notify(n, channel) });
    if (busy) console.log("another tick or run holds the lock: the next tick catches up");
    for (const e of ran) console.log(e.deferred ? `DEFER ${e.id}  ${e.deferred}` : `${status(e.ok, color)} ${e.id}  ${e.steps.map((s) => `${s.command}=${s.exit}`).join(", ")}`);
    if (!busy && !ran.length) console.log("nothing due");
    if (ran.some((e) => !e.ok && !e.deferred)) process.exitCode = 1;
  } else if (sub === "run" && positionals[0]) {
    const r = routines.find((x) => x.id === positionals[0]);
    if (!r) throw new Error(`routine: unknown ${positionals[0]} (orch routine list)`);
    if (!r.enabled) throw new Error(`routine: ${r.id} is disabled in catalog/routines.yaml`);
    const channel = loadPresenceConfig().notify;
    const e = await runRoutine(r, { notify: (n) => notify(n, channel) });
    if (e.deferred) console.log(`DEFER ${e.id}  ${e.deferred}`);
    else for (const s of e.steps) console.log(`${status(s.exit === 0, color)} ${s.command}  ${s.ms} ms${s.timed_out ? "  (timed out)" : ""}${s.exit === 0 ? "" : `\n${s.tail}`}`);
    if (e.skipped) console.log(`skipped: ${e.skipped}`);
    // A deferred run did not do its work: say so to a script or to the lead
    // (75, as the brain commands), while the tick itself stays green.
    if (e.deferred) process.exitCode = EXIT_UNAVAILABLE;
    else if (!e.ok) process.exitCode = 1;
  } else if (sub === "status") {
    const hist = histories();
    const now = new Date();
    for (const r of routines) {
      const h = hist.get(r.id);
      const e = h?.last;
      const next = r.enabled ? nextRun(r, h, now) : null;
      const when = !next ? "" : next <= now ? `  next: ${paint("due now", "yellow", color)}` : `  next: ${next.toISOString().slice(0, 16)}`;
      console.log(`${r.id.padEnd(18)} ${r.enabled ? "on " : paint("off", "dim", color)}  ${e ? `${e.deferred ? `DEFER ${e.deferred}` : status(e.ok, color)} ${e.end.slice(0, 16)}${e.skipped ? ` (${e.skipped})` : ""}` : paint("never ran", r.enabled ? "yellow" : "dim", color)}${when}`);
    }
  } else if (sub === "journal") {
    const n = values.limit ? Number(values.limit) : 20;
    for (const e of readJournal().slice(-n)) console.log(`${e.end.slice(0, 16)}  ${e.deferred ? `DEFER ${e.deferred}` : status(e.ok, color)} ${e.id}${e.waited_ms && e.waited_ms >= 1000 ? ` (waited ${Math.round(e.waited_ms / 1000)}s for the lock)` : ""}${e.deferred ? `  deferred: ${e.deferred}` : e.skipped ? `  ${e.skipped}` : `  ${e.steps.map((s) => `${s.command}=${s.exit}`).join(", ")}`}`);
  } else {
    console.log(ROUTINE_USAGE);
    process.exitCode = 2;
  }
}
