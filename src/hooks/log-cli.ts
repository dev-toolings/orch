// orch log: show, append, snapshot the structured mission log.
import { parseArgs } from "node:util";
import { formatEvents, readEvents } from "../core/events.ts";
import { stateDir } from "../core/paths.ts";
import { projectKey } from "../core/project.ts";
import { appendLog, formatLog, isLogKind, journalPath, readLog, snapshotState } from "./journal.ts";

const USAGE = "usage: orch log | show | path | snapshot | append --kind state|decision|error|path|next|evidence --text t";

export function logCli(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const [sub, ...rest] = args;
  const project = projectKey(cwd);
  if (!sub || sub === "show") {
    const mission = formatLog(readLog(project, env)) || "MISSION LOG\n(empty)";
    const alerts = formatEvents(readEvents(env.ORCH_STATE || stateDir()));
    return alerts ? `${mission}\n\n${alerts}\n` : `${mission}\n`;
  }
  if (sub === "path") return `${journalPath(project, env)}\n`;
  if (sub === "snapshot") {
    const text = snapshotState({ cwd, project, env });
    return `LOG SNAPSHOT\n${text}\n`;
  }
  if (sub === "append") {
    const { values } = parseArgs({
      args: rest,
      options: { kind: { type: "string" }, text: { type: "string" } },
      strict: false,
    });
    const kind = typeof values.kind === "string" ? values.kind : "";
    const text = typeof values.text === "string" ? values.text : "";
    if (!kind || !isLogKind(kind) || !text.trim()) throw new Error(USAGE);
    const result = appendLog({ kind, text, project, env, session: env.ORCH_SESSION });
    if (!result.ok) throw new Error(`orch log: ${result.reason}`);
    return `LOG APPEND\nKIND: ${result.entry.kind}\n${result.entry.text}\n`;
  }
  throw new Error(USAGE);
}
