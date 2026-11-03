// Times the first GET /api/snapshot of `orch dash` against the real HOME (read
// only) and a throwaway state dir, so the operator's state is never written.
//
//   bun scripts/bench-dash-snapshot.ts                 # cold, no usage cache
//   bun scripts/bench-dash-snapshot.ts --cache FILE    # cold, with a cache copy
//   bun scripts/bench-dash-snapshot.ts --legacy        # old CLI path: sync ingest per request
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cache: { type: "string" },
    legacy: { type: "boolean", default: false },
    "wait-sync": { type: "string", default: "60" },
    keep: { type: "boolean", default: false },
  },
});

const state = mkdtempSync(join(tmpdir(), "orch-bench-dash-"));
// stateDir() reads ORCH_STATE at call time: set it before anything collects.
process.env.ORCH_STATE = state;
process.env.LOG_LEVEL ??= "warn";
if (values.cache) {
  const cache = JSON.parse(readFileSync(values.cache, "utf8")) as { scope?: { home: string; state: string } };
  cache.scope = { home: process.env.HOME ?? "", state };
  writeFileSync(join(state, "dash-usage-cache.json"), `${JSON.stringify(cache)}\n`);
}
const dist = join(state, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html>");

const { serveDash } = await import("../src/dash/serve.ts");
const { collectDash } = await import("../src/dash/collect.ts");

const t0 = performance.now();
const server = serveDash({
  host: "127.0.0.1",
  port: 0,
  dist,
  ...(values.legacy ? { collect: () => collectDash() } : {}),
});
const base = `http://${server.hostname}:${server.port}`;

async function get(): Promise<{ ms: number; syncing: boolean | undefined }> {
  const s = performance.now();
  const body = await (await fetch(`${base}/api/snapshot`)).json() as { providersSyncing?: boolean };
  return { ms: Math.round(performance.now() - s), syncing: body.providersSyncing };
}

try {
  const first = await get();
  const second = await get();
  const out: Record<string, unknown> = {
    mode: values.legacy ? "legacy (sync per request)" : "background worker",
    cache: values.cache ? "copy" : "none",
    firstMs: first.ms,
    secondMs: second.ms,
    firstSyncing: first.syncing,
  };
  if (!values.legacy) {
    const deadline = Date.now() + Number(values["wait-sync"]) * 1000;
    let last = second;
    let maxDuringSync = 0;
    while (last.syncing && Date.now() < deadline) {
      await Bun.sleep(100);
      last = await get();
      if (last.syncing) maxDuringSync = Math.max(maxDuringSync, last.ms);
    }
    out.maxSnapshotDuringSyncMs = maxDuringSync;
    out.syncDoneAfterMs = last.syncing ? null : Math.round(performance.now() - t0);
    const warm = await get();
    out.afterSyncMs = warm.ms;
  }
  console.log(JSON.stringify(out));
} finally {
  server.stop(true);
  if (!values.keep) rmSync(state, { recursive: true, force: true });
}
