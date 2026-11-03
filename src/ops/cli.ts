// orch ops check|usage (see ops.ts, usage.ts).
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { latestBackup } from "../brain/admin.ts";
import { paint, useColor } from "../core/color.ts";
import { loadBrainConfig } from "../brain/db.ts";
import { histories, loadRoutines } from "../routines/routines.ts";
import { backupControl, brainBoundControl, collect, dockerPublished, envFileControl, explain, exposureControl, firewallControl, formatControls, hostFiltered, listeners, loadOpsConfig, restoreControl, routinesControl, routineState, sshControls } from "./ops.ts";
import { tokenUsage, usageLines } from "./usage.ts";

export const OPS_USAGE = `usage: orch ops check            host controls, exit 1 on any FAIL (read-only)
       orch ops usage [--days n]   Claude Code tokens per day and model`;

export async function ops(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: { days: { type: "string" } } });
  if (sub === "check") {
    const o = loadOpsConfig();
    const brain = loadBrainConfig();
    const host = collect();
    const ls = listeners(host.ss);
    const latest = latestBackup(brain);
    const hist = histories();
    const routines = loadRoutines();
    const now = new Date();
    const backupRoutine = routines.find((r) => r.id === "brain-backup");
    const backup = backupRoutine?.enabled ? routineState(backupRoutine, hist.get("brain-backup"), now, host.bootAt) : "overdue";
    const controls = [
      ...sshControls(host.ssh),
      firewallControl(host.ufw),
      exposureControl(ls, o.public_ports, { filtered: hostFiltered(host.ufw, host.ufwDefaults), docker: dockerPublished(host.docker) }),
      brainBoundControl(ls, brain.port),
      backupControl(latest && existsSync(latest) ? { path: latest, mtime: statSync(latest).mtime } : null, o.backup_max_age_hours, now, backup),
      restoreControl(hist.get("brain-backup"), backup),
      // inside the ops-check routine, it does not judge its own run
      routinesControl(routines, hist, now, host.bootAt, process.env.ORCH_ROUTINE),
      envFileControl(host.envMode),
    ];
    const color = useColor();
    for (const l of formatControls(controls, color)) console.log(l);
    const pass = controls.filter((c) => c.ok === true).length;
    const failed = controls.some((c) => c.ok === false);
    console.log(paint(`${pass}/${controls.length} green`, failed ? "red" : pass === controls.length ? "green" : "yellow", color));
    // Inside a routine, the alert explains itself (see alertFor in routines.ts).
    if (process.env.ORCH_ROUTINE) {
      const bad = controls.filter((c) => c.ok === false);
      if (!bad.length) console.log("ALERT-OK: Les contrôles de l'hôte sont de nouveau tous bons");
      else {
        console.log(`ALERT-TITLE: ${bad.length === 1 ? "Un point à corriger sur l'hôte" : `${bad.length} points à corriger sur l'hôte`}`);
        for (const c of bad) console.log(`ALERT: ${explain(c)}`);
      }
    }
    if (controls.some((c) => c.ok === false)) process.exitCode = 1;
  } else if (sub === "usage") {
    const days = values.days ? Number(values.days) : 1;
    if (!Number.isInteger(days) || days < 1) throw new Error("ops usage: --days must be a positive integer");
    const since = new Date(Date.now() - days * 86_400_000);
    for (const l of usageLines(tokenUsage(join(process.env.ORCH_HOME ?? homedir(), ".claude", "projects"), since))) console.log(l);
  } else {
    console.log(OPS_USAGE);
    process.exitCode = 2;
  }
}
