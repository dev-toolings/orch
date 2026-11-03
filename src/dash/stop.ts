import { spawnSync } from "node:child_process";
import { DEFAULT_API_PORT, DEFAULT_DEV_PORT } from "./dev.ts";

const STOP_GRACE_MS = 2_000;
const ALLOWED = ["bun", "node", "vite"];

export interface ListenerProc {
  pid: number;
  command: string;
}

export interface StopDeps {
  run?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

function runDefault(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

export function parseSsListeners(raw: string): ListenerProc[] {
  const seen = new Set<number>();
  const out: ListenerProc[] = [];
  const re = /"([^"]+)",pid=(\d+)/g;
  for (const line of raw.split("\n")) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const pid = Number(m[2]);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      out.push({ pid, command: m[1] });
    }
  }
  return out;
}

function parseLsofListeners(raw: string): ListenerProc[] {
  const out: ListenerProc[] = [];
  let command = "";
  let pid = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") pid = Number(value) || 0;
    else if (kind === "c") command = value;
    if (command && pid > 0) {
      out.push({ pid, command });
      command = "";
      pid = 0;
    }
  }
  return out;
}

function parseFuserPids(raw: string): number[] {
  return raw.split(/\s+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}

function allowedCommand(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED.some((allow) => lower.includes(allow));
}

async function terminatePid(
  pid: number,
  deps: Required<Pick<StopDeps, "alive" | "kill" | "sleep">>,
): Promise<"stopped" | "missing"> {
  if (!deps.alive(pid)) return "missing";
  deps.kill(pid, "SIGTERM");
  const until = Date.now() + STOP_GRACE_MS;
  while (Date.now() < until) {
    if (!deps.alive(pid)) return "stopped";
    await deps.sleep(100);
  }
  if (!deps.alive(pid)) return "stopped";
  deps.kill(pid, "SIGKILL");
  return deps.alive(pid) ? "missing" : "stopped";
}

function resolvePorts(env: Record<string, string | undefined>): { devPort: number; apiPort: number } {
  const devPort = env.DEV_PORT === undefined || env.DEV_PORT === "" ? DEFAULT_DEV_PORT : Number(env.DEV_PORT);
  const apiPort = env.DASH_API_PORT === undefined || env.DASH_API_PORT === "" ? DEFAULT_API_PORT : Number(env.DASH_API_PORT);
  if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65535) throw new Error("dash stop: DEV_PORT must be 1-65535");
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error("dash stop: DASH_API_PORT must be 1-65535");
  return { devPort, apiPort };
}

function listenersForPort(port: number, run: Required<StopDeps>["run"]): ListenerProc[] {
  const ss = run("ss", ["-ltnp", `sport = :${port}`]);
  if (ss.status === 0) return parseSsListeners(ss.stdout);
  const lsof = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"]);
  if (lsof.status === 0) return parseLsofListeners(lsof.stdout);
  const fuser = run("fuser", ["-n", "tcp", String(port)]);
  if (fuser.status === 0) {
    const pids = parseFuserPids(`${fuser.stdout} ${fuser.stderr}`);
    return pids.map((pid) => {
      const ps = run("ps", ["-p", String(pid), "-o", "comm="]);
      return { pid, command: ps.stdout.trim() || "unknown" };
    });
  }
  return [];
}

export async function stopDashPorts(
  env: Record<string, string | undefined> = process.env,
  deps: StopDeps = {},
): Promise<string[]> {
  const run = deps.run ?? runDefault;
  const alive = deps.alive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const kill = deps.kill ?? ((pid, signal) => { try { process.kill(pid, signal); } catch { /* no-op */ } });
  const sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
  const { devPort, apiPort } = resolvePorts(env);
  const ports = [devPort, apiPort];
  const candidates = new Map<number, string>();
  for (const port of ports) {
    for (const proc of listenersForPort(port, run)) {
      if (!allowedCommand(proc.command)) continue;
      candidates.set(proc.pid, proc.command);
    }
  }
  if (!candidates.size) return [`nothing listening on ${ports.join(", ")}`];
  const out: string[] = [];
  for (const [pid, command] of candidates) {
    const result = await terminatePid(pid, { alive, kill, sleep });
    out.push(`${result === "stopped" ? "stopped" : "gone"} ${pid} (${command})`);
  }
  return out;
}

if (import.meta.main) {
  try {
    for (const line of await stopDashPorts()) process.stdout.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`dash stop: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
