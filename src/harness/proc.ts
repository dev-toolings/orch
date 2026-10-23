import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  peakRssMb?: number;
}

// Environment passed to workers and verify commands: an allowlist, so tokens
// and secrets exported in the lead's shell never reach a worker. ORCH_LANE
// marks the process as a worker: `orch mem add` refuses it.
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TZ"];

export function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(extra)) {
    if (!/^LANE_[A-Z0-9_]+$/.test(k)) {
      throw new Error(`workerEnv: extra key ${k} is not a LANE_* variable`);
    }
    if (v.includes("\0")) throw new Error(`workerEnv: value for ${k} contains a NUL byte`);
  }

  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("XDG_") && v) env[k] = v;
  return { ...env, ...extra, ORCH_LANE: "1" };
}

// Runs argv in its own process group; stdout+stderr go to logPath. On timeout
// the whole group gets SIGTERM, then SIGKILL, and we wait for the exit.
export function runLogged(
  argv: string[],
  opts: { cwd: string; logPath: string; stdinPath?: string; timeoutMs: number; env: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const out = openSync(opts.logPath, "a");
    const stdin = opts.stdinPath ? openSync(opts.stdinPath, "r") : "ignore";
    const canSampleRss = process.platform === "linux" && existsSync("/proc");
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: [stdin, out, out],
    });
    let timedOut = false;
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
      try {
        process.kill(-child.pid!, sig);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    const done = (r: RunResult) => {
      clearTimeout(timer);
      if (sampleTimer) clearInterval(sampleTimer);
      closeSync(out);
      if (typeof stdin === "number") closeSync(stdin);
      resolve({ ...r, peakRssMb });
    };
    if (canSampleRss) child.once("spawn", () => {
      sampleRss();
      sampleTimer = setInterval(sampleRss, 2000);
    });
    child.on("error", (e) => done({ code: 127, timedOut, spawnError: e.message }));
    child.on("exit", (code, signal) => {
      // reap any descendant left in the group
      sampleRss();
      kill("SIGKILL");
      done({ code: code ?? (signal ? 128 : null), timedOut });
    });
  });
}
