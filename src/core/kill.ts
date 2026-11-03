// Kill switch: stop worker process groups and write PAUSE, which orch serve
// and running lanes honor. `orch resume` clears the file.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processGroupAlive } from "../harness/proc.ts";
import { listLanes, type LaneState } from "../lane.ts";
import { appendEvent } from "./events.ts";
import { pauseReason } from "./policy.ts";
import { stateDir } from "./paths.ts";

export const KILL_USAGE = `usage: orch kill [--all|<lane>]
       orch resume`;

export function pauseFile(state = stateDir()): string {
  return join(state, "PAUSE");
}

export function writePause(state = stateDir()): string {
  mkdirSync(state, { recursive: true });
  const path = pauseFile(state);
  writeFileSync(path, "");
  return path;
}

export function clearPause(state = stateDir()): boolean {
  const path = pauseFile(state);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export interface KillDeps {
  list?: (state: string) => LaneState[];
  kill?: (pgid: number, signal: NodeJS.Signals) => void;
  alive?: (pgid?: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
}

function defaultKill(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch {
    try { process.kill(pgid, signal); } catch {}
  }
}

export async function terminateGroup(
  pgid: number,
  deps: KillDeps = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  const kill = deps.kill ?? defaultKill;
  const alive = deps.alive ?? processGroupAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const grace = deps.graceMs ?? 1500;
  kill(pgid, "SIGTERM");
  const deadline = Date.now() + grace;
  while (alive(pgid) && Date.now() < deadline) await sleep(50);
  if (alive(pgid)) kill(pgid, "SIGKILL");
  return !alive(pgid);
}

export function lanesToKill(
  lanes: LaneState[],
  target: "all" | string,
  alive: (pgid?: number) => boolean = processGroupAlive,
): LaneState[] {
  const running = lanes.filter((lane) => lane.status === "running" || alive(lane.workerPgid));
  if (target === "all") return running;
  return running.filter((lane) => lane.id === target || lane.id.endsWith(target));
}

export async function killWorkers(
  target: "all" | string,
  state = stateDir(),
  deps: KillDeps = {},
): Promise<{ killed: string[]; missed: string[] }> {
  const list = deps.list ?? listLanes;
  const chosen = lanesToKill(list(state), target, deps.alive ?? processGroupAlive);
  const killed: string[] = [];
  const missed: string[] = [];
  for (const lane of chosen) {
    const pgid = lane.workerPgid;
    if (!pgid) {
      missed.push(lane.id);
      continue;
    }
    const dead = await terminateGroup(pgid, deps);
    if (dead) killed.push(lane.id);
    else missed.push(lane.id);
  }
  return { killed, missed };
}

export async function killSwitch(
  target: "all" | string,
  state = stateDir(),
  deps: KillDeps = {},
): Promise<string> {
  const workers = await killWorkers(target, state, deps);
  const pause = writePause(state);
  appendEvent({
    kind: "info",
    text: target === "all" ? "kill all" : `kill ${target}`,
    source: "kill",
  }, state);
  const lines = [
    target === "all" ? "KILL all" : `KILL ${target}`,
    workers.killed.length ? `workers  ${workers.killed.join(", ")}` : "workers  none running",
    workers.missed.length ? `missed   ${workers.missed.join(", ")}` : "",
    `pause    ${pause}`,
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

export function resumeSwitch(state = stateDir()): string {
  const cleared = clearPause(state);
  const still = pauseReason({}, state);
  return cleared
    ? `RESUME  cleared ${pauseFile(state)}\n`
    : still
      ? `RESUME  still paused: ${still}\n`
      : "RESUME  not paused\n";
}

export async function killCli(args: string[], state = stateDir(), deps: KillDeps = {}): Promise<string> {
  const [sub] = args;
  if (sub === "--all" || sub === undefined) return killSwitch("all", state, deps);
  if (sub.startsWith("-")) throw new Error(KILL_USAGE);
  return killSwitch(sub, state, deps);
}
