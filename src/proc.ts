import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

// Environment passed to workers and verify commands: an allowlist, so tokens
// and secrets exported in the lead's shell never reach a worker. ORCH_LANE
// marks the process as a worker: `orch mem add` refuses it.
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TZ"];

export function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("XDG_") && v) env[k] = v;
  return { ...env, ORCH_LANE: "1", ...extra };
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
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: [stdin, out, out],
    });
    let timedOut = false;
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
      closeSync(out);
      if (typeof stdin === "number") closeSync(stdin);
      resolve(r);
    };
    child.on("error", (e) => done({ code: 127, timedOut, spawnError: e.message }));
    child.on("exit", (code, signal) => {
      // reap any descendant left in the group
      kill("SIGKILL");
      done({ code: code ?? (signal ? 128 : null), timedOut });
    });
  });
}
