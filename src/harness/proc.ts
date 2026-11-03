import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { bunCacheDir } from "../core/paths.ts";

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  peakRssMb?: number;
}

const TERM_GRACE_MS = 5000;
// Owned process groups: reaped when the group is gone, and the grace between
// SIGTERM and SIGKILL on a stop (a lane CLI needs room for its finalizer).
const owned = new Map<number, { reaped: Promise<void>; graceMs: number }>();
const SIGNAL_CODES = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
let stopping = false;

export function processGroupAlive(pgid?: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid! <= 1) return false;
  try { process.kill(-pgid!, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch {}
}

async function waitForGroup(pgid: number): Promise<void> {
  while (processGroupAlive(pgid)) {
    // Orphaned zombies belong to init, so we cannot reap them. They cannot
    // run or write; GC still conservatively counts their group as alive.
    if (process.platform === "linux") {
      try {
        const running = readdirSync("/proc").some((entry) => {
          if (!/^\d+$/.test(entry)) return false;
          try {
            const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            return Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X";
          } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; }
        });
        if (!running) return;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type StopHook = (signal: string) => void | Promise<void>;
let stopHook: StopHook | null = null;
// Upper bound for the lane's finalizer on a stop signal: it saves the terminal
// record, closes the Orca observer and cuts the worktree, then the process exits.
export const STOP_HOOK_MS = 20_000;
let handlersOn = false;

// Handlers stay installed while a child is owned or a lane finalizer is
// registered: a signal between two runs (Orca detach, VERIFY setup) must reach
// the finalizer too, not the default handler that exits on the spot.
function syncHandlers(): void {
  const want = owned.size > 0 || stopHook !== null;
  if (want === handlersOn) return;
  handlersOn = want;
  for (const { name, handler } of signalHandlers) {
    if (want) process.on(name, handler);
    else process.off(name, handler);
  }
}

// The lane registers its finalizer, awaited (bounded) before the process exits.
export function onLaneStop(cb: StopHook | null): void {
  stopHook = cb;
  syncHandlers();
}

async function stopOwned(signal: keyof typeof SIGNAL_CODES): Promise<void> {
  if (stopping) return;
  stopping = true;
  const timers = [...owned].map(([pgid, o]) => {
    killGroup(pgid, "SIGTERM");
    return setTimeout(() => killGroup(pgid, "SIGKILL"), o.graceMs);
  });
  await Promise.all([...owned.values()].map((o) => o.reaped));
  for (const t of timers) clearTimeout(t);
  const hook = stopHook;
  if (hook) {
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve().then(() => hook(signal)).catch(() => {}),
      new Promise<void>((resolve) => { bound = setTimeout(resolve, STOP_HOOK_MS); }),
    ]);
    clearTimeout(bound);
  }
  process.exit(SIGNAL_CODES[signal]);
}

const signalHandlers = Object.entries(SIGNAL_CODES).map(([signal]) => {
  const name = signal as keyof typeof SIGNAL_CODES;
  return { name, handler: () => { void stopOwned(name); } };
});

// Environment passed to workers and verify commands: an allowlist, so tokens
// and secrets exported in the lead's shell never reach a worker. ORCH_LANE
// marks the process as a worker: `orch mem add` refuses it. Depth is forced
// here (not forwarded from the parent): a worker at depth N starts children
// at N+1, and `limits.max_depth` refuses when current depth >= max_depth.
// CLAUDE_CODE_EFFORT_LEVEL stays out on purpose: it would override the
// lane's own `--effort` from the route's ladder.
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TZ"];

export function laneDepth(env: NodeJS.ProcessEnv = process.env): number {
  if (env.ORCH_LANE !== "1") return 0;
  const raw = env.ORCH_LANE_DEPTH;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return 1;
}

// lane: values the lane owns, never read from the caller's environment.
// tmpDir becomes TMPDIR (over the lead's): the lane's own temp dir, the one
// extra path a Claude worker's sandbox may write.
export function workerEnv(extra: Record<string, string> = {}, lane: { tmpDir?: string } = {}): Record<string, string> {
  for (const [k, v] of Object.entries(extra)) {
    if (!/^LANE_[A-Z0-9_]+$/.test(k)) {
      throw new Error(`workerEnv: extra key ${k} is not a LANE_* variable`);
    }
    if (v.includes("\0")) throw new Error(`workerEnv: value for ${k} contains a NUL byte`);
  }
  if (lane.tmpDir !== undefined && (!isAbsolute(lane.tmpDir) || lane.tmpDir.includes("\0"))) {
    throw new Error(`workerEnv: lane temp dir ${JSON.stringify(lane.tmpDir)} is not an absolute path`);
  }

  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("XDG_") && v) env[k] = v;
  // Forced off: a parent ENABLE_CLAUDEAI_MCP_SERVERS=true must not re-enable claude.ai MCP.
  return {
    ...env,
    ...extra,
    ...(lane.tmpDir ? { TMPDIR: lane.tmpDir } : {}),
    ORCH_LANE: "1",
    ORCH_LANE_DEPTH: String(laneDepth() + 1),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR || bunCacheDir(),
  };
}

// Runs argv in its own process group; stdout+stderr go to logPath. On timeout
// or runner termination, stop the whole group and wait before releasing it.
export function runLogged(
  argv: string[],
  opts: { cwd: string; logPath: string; stderrPath?: string; stdinPath?: string; timeoutMs: number; env: Record<string, string>; onSpawn?: (pgid: number) => void; termGraceMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (stopping) return;
    const out = openSync(opts.logPath, "a");
    let err = out;
    let stdin: number | "ignore" = "ignore";
    try {
      if (opts.stderrPath) err = openSync(opts.stderrPath, "a");
      if (opts.stdinPath) stdin = openSync(opts.stdinPath, "r");
    } catch (error) {
      try { closeSync(out); } catch {}
      if (err !== out) try { closeSync(err); } catch {}
      if (typeof stdin === "number") try { closeSync(stdin); } catch {}
      reject(error);
      return;
    }
    const canSampleRss = process.platform === "linux" && existsSync("/proc");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: [stdin, out, err],
      });
    } catch (error) {
      try { closeSync(out); } catch {}
      if (err !== out) try { closeSync(err); } catch {}
      if (typeof stdin === "number") try { closeSync(stdin); } catch {}
      reject(error);
      return;
    }
    let reaped: (() => void) | undefined;
    if (child.pid) {
      owned.set(child.pid, { reaped: new Promise<void>((resolve) => { reaped = resolve; }), graceMs: opts.termGraceMs ?? TERM_GRACE_MS });
      syncHandlers();
    }
    let timedOut = false;
    let finished = false;
    let recordError: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let peakRssMb: number | undefined;
    let sampleTimer: ReturnType<typeof setInterval> | undefined;
    const sampleRss = () => {
      if (!canSampleRss || !child.pid) return;
      let totalKb = 0;
      try {
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          const proc = `/proc/${entry}`;
          try {
            const stat = readFileSync(`${proc}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            if (Number(fields[2]) !== child.pid) continue;
            const status = readFileSync(`${proc}/status`, "utf8");
            totalKb += Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0);
          } catch {}
        }
      } catch {}
      if (totalKb > 0) peakRssMb = Math.max(peakRssMb ?? 0, Math.ceil(totalKb / 1024));
    };
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid) killGroup(child.pid, sig);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), opts.termGraceMs ?? TERM_GRACE_MS);
    }, opts.timeoutMs);
    const done = async (r: RunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (sampleTimer) clearInterval(sampleTimer);
      kill("SIGKILL");
      if (child.pid) await waitForGroup(child.pid);
      try { closeSync(out); } catch {}
      if (err !== out) try { closeSync(err); } catch {}
      if (typeof stdin === "number") try { closeSync(stdin); } catch {}
      if (child.pid) owned.delete(child.pid);
      reaped?.();
      if (stopping) return; // do not start VERIFY or release a slot during shutdown
      syncHandlers();
      if (recordError) reject(recordError);
      else resolve({ ...r, peakRssMb });
    };
    if (canSampleRss) child.once("spawn", () => {
      sampleRss();
      sampleTimer = setInterval(sampleRss, 2000);
    });
    child.on("error", (e) => done({ code: 127, timedOut, spawnError: e.message }));
    child.on("exit", (code, signal) => {
      // reap any descendant left in the group
      sampleRss();
      done({ code: code ?? (signal ? 128 : null), timedOut });
    });
    if (child.pid) {
      try { opts.onSpawn?.(child.pid); } catch (e) {
        recordError = e;
        kill("SIGKILL");
      }
    }
  });
}
