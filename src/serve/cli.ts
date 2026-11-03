// `orch task new|list|show|follow|stop|adopt` and `orch serve [--once]`.
// Operator commands persist an event, then admit it deterministically (no
// model call), so they work whether or not an engine runs.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { git } from "../core/git.ts";
import { stateDir } from "../core/paths.ts";
import { jobAlive, newTaskId, tasksDir, TaskStore, type Task, type TaskEvent } from "../core/tasks.ts";
import { pauseFile } from "../core/kill.ts";
import { admitOperator, loadServePolicy, serve, splitFiles } from "./engine.ts";
import { migrateConductor, migrationText } from "./migrate.ts";

const USAGE = "usage: orch task new --repo <p> --files <globs> --verify <cmd> [--risk] [--base <branch>] \"<objective>\" | list | show <id> | follow <id> \"<message>\" | stop <id> | adopt ...";

async function operatorEvent(store: TaskStore, ev: Omit<TaskEvent, "key" | "source" | "sender">): Promise<string> {
  const key = `op-${randomUUID()}`;
  await store.receive({ ...ev, key, source: "operator", sender: "operator-cli" });
  const stored = store.read().events[key];
  return admitOperator(store, stored, loadServePolicy().version, stateDir());
}

function line(t: Task): string {
  return `${t.id}  ${t.state.padEnd(13)} next=${t.next.padEnd(7)} r${t.revision}${t.deliveredRevision ? ` (delivered r${t.deliveredRevision})` : ""}  ${t.objective.split("\n")[0].slice(0, 70)}`;
}

export function showTask(t: Task): string {
  const m = t.mandate;
  return [`TASK ${t.id}`, `STATE: ${t.state}`, `NEXT: ${t.next}`, `OBJECTIVE: ${t.objective}`,
    `MANDATE: repo ${m.repo}; FILES ${m.files.join(", ")}; VERIFY ${m.verify}; risk ${m.risk}; base ${m.baseBranch}; from ${m.source} (${m.sender}); policy ${m.policy}`,
    `THREAD: ${t.thread}`, `SESSION: ${t.session}${t.sessionStarted ? "" : " (not started)"}`,
    `REVISION: ${t.revision} (delivered ${t.deliveredRevision}); attempts ${t.attempt}; failures ${t.failures}`,
    ...(t.worktree ? [`WORKTREE: ${t.worktree} (${t.workBranch})`] : []), ...(t.lane ? [`LANE: ${t.lane}`] : []),
    ...(t.branch ? [`BRANCH: ${t.branch}`] : []), ...(t.pr ? [`PR: ${t.pr}`] : []), ...(t.stopped ? [`STOPPED: by ${t.stopped.by} at ${t.stopped.at}`] : []),
    ...(t.failure ? [`FAILURE: ${t.failure}`] : []), "EVIDENCE:", ...t.evidence.slice(-12).map((e) => `  ${e.at} ${e.kind}: ${e.text}`), ""].join("\n");
}

// `kiba --conductor`: the conductor is orch serve; this is its status.
export function serveStatus(root = stateDir()): string {
  const store = new TaskStore(tasksDir(root));
  let s;
  try { s = store.read(); } catch (e) { return `ORCH SERVE\nSTATUS: unreadable task journal: ${String(e)}\n`; }
  let engine: { pid?: number; start?: string; at?: string } | undefined;
  try { engine = JSON.parse(readFileSync(join(tasksDir(root), "serve.json"), "utf8")); } catch {}
  const running = engine?.pid && jobAlive(engine) ? `running (pid ${engine.pid}, since ${engine.at})` : "not running";
  const open = Object.values(s.tasks).filter((t) => t.state !== "ended").sort((a, b) => a.created.localeCompare(b.created));
  const workers = Object.values(s.jobs).filter((j) => j.status === "running" || j.status === "planned");
  const effects = Object.values(s.outbox).filter((e) => e.status === "pending");
  return [
    "ORCH SERVE (the conductor; the dispatch-only kiba --conductor is retired)",
    `ENGINE: ${running}${existsSync(pauseFile(root)) ? "; PAUSE set (orch resume clears it)" : ""}`,
    `TASKS: ${open.length} open of ${Object.keys(s.tasks).length}`, ...open.map((t) => `  ${line(t)}`),
    `WORKERS: ${workers.length}`, ...workers.map((j) => `  ${j.id} ${j.kind} ${j.status}${j.pid ? ` pid ${j.pid}` : ""}`),
    `PENDING EFFECTS: ${effects.length}`, ...effects.map((e) => `  ${e.key} (${e.attempts} attempt${e.attempts === 1 ? "" : "s"}${e.error ? `: ${e.error.split("\n")[0].slice(0, 80)}` : ""})`),
    `MIGRATION: ${s.migration?.done ? `imported ${s.migration.done}` : "not run yet (orch serve migrate, also run at orch serve start)"}`,
    "START: systemctl --user enable --now orch-serve.service (opt-in unit), or orch serve in a terminal; orch serve --once for one pass; orch task new|list|show to drive it",
    "",
  ].join("\n");
}

export async function taskCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "adopt") return (await import("../tasks/adopt.ts")).taskCli(args);
  const store = new TaskStore(tasksDir());
  if (command === "new") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      repo: { type: "string" }, files: { type: "string" }, verify: { type: "string" }, risk: { type: "boolean" }, base: { type: "string" },
    } });
    const objective = positionals.join(" ").trim();
    if (!objective || !values.files || !values.verify) throw new Error(USAGE);
    const top = git(resolve(values.repo ?? process.cwd()), "rev-parse", "--show-toplevel");
    if (!top.ok) throw new Error(`--repo: not a git repository: ${values.repo ?? process.cwd()}`);
    const repo = realpathSync(top.out);
    const base = values.base ?? git(repo, "branch", "--show-current").out;
    if (!base || !git(repo, "show-ref", "--verify", `refs/heads/${base}`).ok) throw new Error("--base: name a local branch (the repository is on a detached HEAD)");
    const id = newTaskId();
    const files = splitFiles(values.files);
    const got = await operatorEvent(store, { kind: "request", task: id, thread: `task:${id}`, text: objective, repo,
      request: { objective, mandate: { repo, files, verify: values.verify, risk: values.risk ? "risky" : "normal", baseBranch: base, source: "operator", sender: "operator-cli" } } });
    if (got !== "created") { console.log(`TASK NEW\nSTATUS: ${got}`); process.exitCode = 2; return; }
    console.log(`TASK NEW\nTASK: ${id}\nSTATUS: working\nNEXT: orch serve runs it (orch serve --once for one pass)`);
    return;
  }
  if (command === "list") {
    const tasks = Object.values(store.read().tasks).sort((a, b) => a.created.localeCompare(b.created));
    console.log(tasks.length ? tasks.map(line).join("\n") : "no task");
    return;
  }
  const [id, ...words] = rest;
  const task = id ? store.read().tasks[id] : undefined;
  if (!["show", "follow", "stop"].includes(command ?? "")) throw new Error(USAGE);
  if (!task) { console.error(`no task ${id ?? ""}`); process.exitCode = 1; return; }
  if (command === "show") { process.stdout.write(showTask(task)); return; }
  if (command === "follow") {
    const text = words.join(" ").trim();
    if (!text) throw new Error(USAGE);
    const got = await operatorEvent(store, { kind: "follow", task: task.id, thread: task.thread, text });
    console.log(`TASK FOLLOW\nTASK: ${task.id}\nSTATUS: ${got}${got === "refused" ? " (stopped by a person)" : ""}`);
    if (got === "refused") process.exitCode = 2;
    return;
  }
  const got = await operatorEvent(store, { kind: "stop", task: task.id, thread: task.thread, text: "stop" });
  console.log(`TASK STOP\nTASK: ${task.id}\nSTATUS: ${got}`);
}

export async function serveCli(args: string[]): Promise<void> {
  if (args[0] === "migrate") {
    if (args.length > 1) throw new Error("usage: orch serve migrate");
    process.stdout.write(migrationText(await migrateConductor()));
    return;
  }
  const { values } = parseArgs({ args, options: { once: { type: "boolean" } } });
  if (!existsSync(stateDir())) throw new Error(`state dir ${stateDir()} is missing`);
  // The retired conductor's state, imported once (idempotent): a failure is
  // reported and never keeps the engine down.
  try {
    const r = await migrateConductor();
    if (!r.already && (r.tasks.length || r.effects.length || r.deferred.length)) process.stderr.write(migrationText(r));
  } catch (e) { console.error(`orch serve: migration of the retired conductor failed: ${String(e)}`); }
  process.exitCode = await serve({ once: values.once === true });
}
