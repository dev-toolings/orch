import { parseArgs } from "node:util";
import { loadFixture } from "./collect.ts";
import { DEFAULT_HOST, DEFAULT_INTERVAL_SEC, DEFAULT_PORT, serveDash } from "./serve.ts";

export const DASH_USAGE = `usage: orch dash [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--interval sec] [--fixture path]`;

export function parseDashArgs(args: string[]): {
  port: number;
  host: string;
  interval: number;
  fixture?: string;
} {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      interval: { type: "string" },
      fixture: { type: "string" },
    },
  });
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("dash: --port must be 1-65535");
  const host = values.host ?? DEFAULT_HOST;
  if (!host.trim()) throw new Error("dash: --host is required");
  const interval = values.interval === undefined ? DEFAULT_INTERVAL_SEC : Number(values.interval);
  if (!Number.isFinite(interval) || interval < 0.2) throw new Error("dash: --interval must be at least 0.2");
  return { port, host, interval, fixture: values.fixture };
}

/**
 * serveDash options for `orch dash`: a fixture is served as is; otherwise no
 * `collect` is passed, so snapshots read the background ingest summary only.
 */
export function dashServeOptions(opts: ReturnType<typeof parseDashArgs>): Parameters<typeof serveDash>[0] {
  const fixture = opts.fixture ? loadFixture(opts.fixture) : undefined;
  return {
    host: opts.host,
    port: opts.port,
    intervalSec: opts.interval,
    ...(fixture ? { collect: () => fixture } : {}),
  };
}

export async function dash(args: string[]): Promise<void> {
  const server = serveDash(dashServeOptions(parseDashArgs(args)));
  process.stdout.write(`orch dash  http://${server.hostname}:${server.port}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
