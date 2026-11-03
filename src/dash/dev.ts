// Vite HMR + orch dash API, one process group. Ctrl-C stops both.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../core/profile.ts";
import { createDashLogger } from "./log.ts";

export const DEFAULT_DEV_PORT = 7894;
export const DEFAULT_API_PORT = 7895;
export const DEFAULT_DEV_HOST = "127.0.0.1";
export const DEFAULT_API_WAIT_MS = 30_000;
export const DEFAULT_API_REQUEST_TIMEOUT_MS = 2_000;
export const CHILD_STOP_GRACE_MS = 2_000;

export function parseDevEnv(env: Record<string, string | undefined> = process.env): {
  host: string;
  devPort: number;
  apiPort: number;
} {
  const host = (env.HOST ?? DEFAULT_DEV_HOST).trim() || DEFAULT_DEV_HOST;
  const devPort = env.DEV_PORT === undefined || env.DEV_PORT === "" ? DEFAULT_DEV_PORT : Number(env.DEV_PORT);
  const apiPort = env.DASH_API_PORT === undefined || env.DASH_API_PORT === "" ? DEFAULT_API_PORT : Number(env.DASH_API_PORT);
  if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65535) throw new Error("dash dev: DEV_PORT must be 1-65535");
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error("dash dev: DASH_API_PORT must be 1-65535");
  if (devPort === apiPort) throw new Error("dash dev: DEV_PORT and DASH_API_PORT must differ");
  return { host, devPort, apiPort };
}

export async function waitForApi(
  url: string,
  opts: {
    waitMs?: number;
    requestTimeoutMs?: number;
    isProcessAlive?: () => boolean;
  } = {},
): Promise<void> {
  const waitMs = opts.waitMs ?? DEFAULT_API_WAIT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_API_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
  let last = "";
  while (Date.now() < deadline) {
    if (opts.isProcessAlive && !opts.isProcessAlive()) {
      throw new Error("dash dev: API exited early; check the error above and run `make stop` if needed");
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(120);
  }
  throw new Error(`dash dev: API not ready at ${url} (${last})`);
}

async function stopChildren(kids: ChildProcess[], graceMs = CHILD_STOP_GRACE_MS): Promise<void> {
  for (const child of kids) {
    if (!child.pid || child.killed || child.exitCode != null || child.signalCode != null) continue;
    try { child.kill("SIGTERM"); } catch { /* no-op */ }
  }
  const waiters = kids.map((child) => new Promise<void>((resolve) => {
    if (!child.pid || child.exitCode != null || child.signalCode != null) return resolve();
    const done = () => resolve();
    child.once("close", done);
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch { /* no-op */ }
      }
      resolve();
    }, graceMs);
  }));
  await Promise.all(waiters);
}

export async function dashDev(
  env: Record<string, string | undefined> = process.env,
  deps: {
    spawn?: typeof spawn;
    waitForApi?: typeof waitForApi;
  } = {},
): Promise<void> {
  const log = createDashLogger("dash-dev");
  const opts = parseDevEnv(env);
  const apiUrl = `http://127.0.0.1:${opts.apiPort}`;
  log.info({ host: opts.host, devPort: opts.devPort, apiUrl }, "starting dev server");
  const kids: ChildProcess[] = [];
  let stopping = false;
  const spawnChild = deps.spawn ?? spawn;
  const wait = deps.waitForApi ?? waitForApi;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await stopChildren(kids);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });

  // `bun --watch` restarts the API when a file it imports changes (src/dash,
  // src/kiba...), so a backend edit shows without restarting `make dev`; a
  // broken edit keeps the watcher waiting for the fix instead of exiting.
  const api = spawnChild("bun", ["--watch", "--no-env-file", "src/orch.ts", "dash", "--port", String(opts.apiPort), "--host", opts.host], {
    cwd: ROOT,
    stdio: "inherit",
  });
  kids.push(api);
  log.debug({ pid: api.pid, apiUrl }, "started api child");
  let apiAlive = true;
  api.on("exit", () => {
    apiAlive = false;
    log.debug({ pid: api.pid, exitCode: api.exitCode, signal: api.signalCode }, "api child exited");
    if (!stopping) void stop();
  });

  try {
    const waitMsRaw = env.DASH_API_WAIT_MS === undefined || env.DASH_API_WAIT_MS === ""
      ? DEFAULT_API_WAIT_MS
      : Number(env.DASH_API_WAIT_MS);
    if (!Number.isInteger(waitMsRaw) || waitMsRaw < 1) throw new Error("dash dev: DASH_API_WAIT_MS must be a positive integer");
    log.debug({ waitMs: waitMsRaw }, "waiting for api readiness");
    await wait(`${apiUrl}/api/health`, { waitMs: waitMsRaw, requestTimeoutMs: DEFAULT_API_REQUEST_TIMEOUT_MS, isProcessAlive: () => apiAlive });
    log.debug({ apiUrl }, "api ready");
  } catch (error) {
    log.error({ message: error instanceof Error ? error.message : String(error) }, "api startup failed");
    await stop();
    throw error;
  }

  const vite = spawnChild(
    "bun",
    ["x", "vite", "--port", String(opts.devPort), "--host", opts.host, "--strictPort"],
    {
      cwd: join(ROOT, "ui"),
      stdio: "inherit",
      env: {
        ...process.env,
        HOST: opts.host,
        DEV_PORT: String(opts.devPort),
        DASH_API: apiUrl,
      },
    },
  );
  kids.push(vite);
  log.debug({ pid: vite.pid, port: opts.devPort }, "started vite child");
  vite.on("exit", () => { if (!stopping) void stop(); });

  const open = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  process.stdout.write(`orch dash:dev  http://${open}:${opts.devPort}  (API ${apiUrl})\n`);
  log.info({ url: `http://${open}:${opts.devPort}`, apiUrl }, "dev server ready");

  await Promise.all([
    new Promise<void>((resolve) => api.on("close", () => resolve())),
    new Promise<void>((resolve) => vite.on("close", () => resolve())),
  ]);
}

if (import.meta.main) {
  await dashDev();
}
