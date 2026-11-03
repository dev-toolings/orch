// orch presence notify|status. The persistent lead it used to supervise is
// retired: start, stop, ensure and run only say that orch serve replaced it.
import { parseArgs } from "node:util";
import { loadPresenceConfig, notifyLine, PRESENCE_REPLACED } from "./presence.ts";
import { LEVELS, type Level, noticeOf, notify } from "./notify.ts";

export const PRESENCE_USAGE = `usage: orch presence status
       orch presence notify [--level info|ok|warn|fail] [--title t] [--note n] [--log l] <text>
                               send a message on every channel: --title the
                               outcome (else the first line), <text> the
                               Markdown body, --log raw output kept
                               monospace, --note small print under a rule`;

export async function presence(args: string[]): Promise<void> {
  const [sub] = args;
  if (sub === "start" || sub === "stop" || sub === "ensure" || sub === "run") { console.log(PRESENCE_REPLACED); return; }
  const c = loadPresenceConfig();
  if (sub === "status") { console.log(`notify    ${notifyLine(c.notify)}`); console.log(PRESENCE_REPLACED); }
  else if (sub === "notify" && args.length > 1) {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { level: { type: "string" }, title: { type: "string" }, note: { type: "string" }, log: { type: "string" } } });
    if (values.level && !(LEVELS as string[]).includes(values.level)) throw new Error(`presence notify: --level is one of ${LEVELS.join(", ")}`);
    const text = positionals.join(" ");
    const extra = { level: values.level as Level | undefined, note: values.note, log: values.log };
    const n = values.title ? { title: values.title, text: text.trim() || undefined, ...extra } : noticeOf(text, extra);
    console.log(`notify: ${await notify(n, c.notify)}${c.notify.length ? ` (${c.notify.join(", ")})` : ": no channel in catalog/presence.yaml"}`);
  } else {
    console.log(PRESENCE_USAGE);
    process.exitCode = 2;
  }
}
