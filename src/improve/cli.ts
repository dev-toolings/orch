// orch improve digest|run|show (see improve.ts).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../core/profile.ts";
import { notify } from "../presence/notify.ts";
import { loadPresenceConfig } from "../presence/presence.ts";
import { collect, improveDir, latest, runImprove } from "./improve.ts";

export const IMPROVE_USAGE = `usage: orch improve digest        the last 24 h of evidence, no model call
       orch improve run           proposals from that evidence (routine improve), sent to the phone
       orch improve show [date]   the latest proposals, or those of YYYY-MM-DD`;

const projects = () => join(process.env.ORCH_HOME ?? homedir(), ".claude", "projects");

export async function improve(args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === "digest") {
    const d = collect({ since: new Date(Date.now() - 86_400_000), projects: projects() });
    process.stdout.write(d.signals ? d.text : "nothing in the last 24 h\n");
  } else if (sub === "run") {
    const profile = loadProfile();
    const c = loadPresenceConfig();
    const r = await runImprove({
      projects: projects(), choice: profile.improve ?? profile.lead.claude, timeoutMs: profile.limits.timeout_seconds * 1000,
      notify: async (n) => { await notify(n, c.notify); },
    });
    console.log(r.note);
    for (const t of r.titles) console.log(`  ${t}`);
  } else if (sub === "show") {
    if (arg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error("improve show: date as YYYY-MM-DD");
    const path = arg ? join(improveDir(), `${arg}.md`) : latest();
    if (!path || !existsSync(path)) throw new Error(`improve: no proposals${arg ? ` for ${arg}` : " yet"} (routine improve, or orch improve run)`);
    process.stdout.write(readFileSync(path, "utf8"));
  } else {
    console.log(IMPROVE_USAGE);
    process.exitCode = 2;
  }
}
