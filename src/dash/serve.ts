// Read-only HTTP for `orch dash`. JSON + SSE (/api/stream, /api/flow), then the built SPA. No actions.
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { ROOT } from "../core/profile.ts";
import { collectDash } from "./collect.ts";
import { stateDir } from "../core/paths.ts";
import { loadPolicy } from "../core/policy.ts";
import { providerWatchDirs, type ProviderUsageSummary } from "./providers-live.ts";
import { startProviderSyncLoop, workerProviderSync, type ProviderSyncRunner } from "./provider-sync.ts";
import { createDashLogger } from "./log.ts";
import type { Logger } from "pino";
import type { DashSnapshot } from "./types.ts";
import { flowState, type FlowState } from "./flow.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7894;
export const DEFAULT_INTERVAL_SEC = 2;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

export function dashDist(root = ROOT): string {
  return join(root, "ui", "dist");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safeFile(dist: string, pathname: string): string | null {
  const raw = decodeURIComponent(pathname.split("?")[0] || "/");
  if (raw.includes("\0")) return null;
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const resolved = resolve(dist, rel);
  const root = resolve(dist) + sep;
  if (!resolved.startsWith(root) && resolved !== resolve(dist)) return null;
  const norm = normalize(relative(dist, resolved));
  if (norm.startsWith("..") || norm.startsWith(sep)) return null;
  return resolved;
}

function staticResponse(dist: string, pathname: string): Response {
  if (!existsSync(dist)) {
    return new Response("dash: UI not built (run bun run --cwd ui build)\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const wanted = safeFile(dist, pathname);
  const file = wanted && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(dist, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) {
    return new Response("dash: UI not built (run bun run --cwd ui build)\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  return new Response(readFileSync(file), {
    headers: { "content-type": type, "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=60" },
  });
}

export const SSE_HEARTBEAT_MS = 5000;

type HubClient = { kind: "snapshot" | "flow"; send: (chunk: string) => boolean };

// One build per change for every open page: the hub collects the snapshot
// once, sends it to each /api/stream client, and sends the architecture view
// of flow.ts (only when it changed) to each /api/flow client.
// Watchers (provider dirs, and the Kiba, lanes and leads state recursively)
// and the fallback tick run only while a client is connected.
export function createHub(o: {
  collect: () => DashSnapshot;
  intervalMs: number;
  log: Logger;
  subscribe?: (fn: () => void) => () => void;
  watchDirs?: () => string[];
  recursiveDirs?: () => string[];
  flow?: (snap: DashSnapshot) => FlowState;
  heartbeatMs?: number;
}) {
  const clients = new Set<HubClient>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let watchers: Array<ReturnType<typeof watch>> = [];
  let lastFlow: FlowState | null = null;
  let lastFlowKey = "";
  let lastSnapshot = "";
  const deliver = (kind: HubClient["kind"], chunk: string) => {
    for (const c of clients) if (c.kind === kind && !c.send(chunk)) clients.delete(c);
  };
  const flowKey = (f: FlowState) => JSON.stringify({ ...f, at: "" });
  const build = () => {
    debounce = undefined;
    let snap: DashSnapshot;
    try { snap = o.collect(); } catch {
      deliver("snapshot", `event: error\ndata: {"error":"snapshot"}\n\n`);
      return;
    }
    lastSnapshot = `data: ${JSON.stringify(snap)}\n\n`;
    deliver("snapshot", lastSnapshot);
    if (!o.flow || ![...clients].some((c) => c.kind === "flow")) return;
    let next: FlowState;
    try { next = o.flow(snap); } catch { return; }
    const key = flowKey(next);
    lastFlow = next;
    if (key !== lastFlowKey) { lastFlowKey = key; deliver("flow", `event: state\ndata: ${JSON.stringify(next)}\n\n`); }
  };
  const trigger = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(build, 250);
  };
  const start = () => {
    unsubscribe = o.subscribe?.(trigger);
    for (const dir of o.watchDirs?.() ?? []) {
      try { watchers.push(watch(dir, trigger)); } catch { /* watch unsupported path */ }
    }
    for (const dir of o.recursiveDirs?.() ?? []) {
      try { if (existsSync(dir)) watchers.push(watch(dir, { recursive: true }, trigger)); } catch { /* no recursive watch here */ }
    }
    // fs.watch can miss events; keep a periodic fallback tick.
    timer = setInterval(build, Math.max(5000, o.intervalMs));
    // A quiet stream still sends a comment line, so neither Bun's idle timeout
    // nor a proxy cuts it (a cut page misses the changes until it reconnects).
    beat = setInterval(() => { deliver("snapshot", ": ping\n\n"); deliver("flow", ": ping\n\n"); }, o.heartbeatMs ?? SSE_HEARTBEAT_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    if (beat) clearInterval(beat);
    if (debounce) clearTimeout(debounce);
    unsubscribe?.();
    for (const w of watchers) {
      try { w.close(); } catch { /* noop */ }
    }
    watchers = [];
    timer = beat = debounce = unsubscribe = undefined;
    lastFlow = null;
    lastFlowKey = "";
  };
  return {
    clients: () => clients.size,
    response(kind: HubClient["kind"], path: string): Response {
      let client: HubClient | undefined;
      const stream = new ReadableStream({
        start(controller) {
          o.log.debug({ path }, "sse client connected");
          const enc = new TextEncoder();
          client = { kind, send: (chunk) => { try { controller.enqueue(enc.encode(chunk)); return true; } catch { return false; } } };
          if (clients.size === 0) start();
          clients.add(client);
          if (kind === "flow" && lastFlow) client.send(`event: state\ndata: ${JSON.stringify(lastFlow)}\n\n`);
          if (kind === "snapshot" && lastSnapshot && timer) client.send(lastSnapshot);
          // A new page gets a fresh build right away (shared with the others).
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(build, 0);
        },
        cancel() {
          o.log.debug({ path }, "sse client disconnected");
          if (client) clients.delete(client);
          if (clients.size === 0) stop();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
      });
    },
  };
}

function planTokensWanted(): boolean {
  try { return loadPolicy().spend.plan_tokens != null; } catch { return false; }
}

function createSseNotifier() {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    trigger(): void {
      for (const fn of listeners) {
        try { fn(); } catch { /* ignore listener failures */ }
      }
    },
  };
}

export function serveDash(opts: {
  host?: string;
  port?: number;
  intervalSec?: number;
  /** Static snapshot source (fixture mode): no provider sync runs. */
  collect?: () => DashSnapshot;
  /** Live snapshot from the last background summary; defaults to collectDash. */
  collectWith?: (args: { providerSummary: ProviderUsageSummary | null; providersSyncing: boolean }) => DashSnapshot;
  /** Background ingest runner; defaults to a Bun Worker. */
  providerSync?: ProviderSyncRunner;
  /** Pause between two background ingest passes. */
  providerSyncMs?: number;
  dist?: string;
} = {}): ReturnType<typeof Bun.serve> {
  const log = createDashLogger("dash");
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const intervalMs = Math.round((opts.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000);
  const sseNotify = createSseNotifier();
  let providerSummary: ProviderUsageSummary | null = null;
  let providersSyncing = !opts.collect;
  const collectWith = opts.collectWith ?? ((args: { providerSummary: ProviderUsageSummary | null; providersSyncing: boolean }) => collectDash(args));
  const collect = opts.collect ?? (() => collectWith({ providerSummary, providersSyncing }));
  const dist = opts.dist ?? dashDist();
  let sync: { stop(): void } | null = null;
  if (!opts.collect) {
    const home = process.env.HOME ?? process.env.ORCH_HOME ?? "";
    const runner = opts.providerSync ?? workerProviderSync({ home, state: stateDir(), planTokens: planTokensWanted() });
    sync = startProviderSyncLoop({
      runner,
      intervalMs: opts.providerSyncMs,
      onUpdate: (summary) => {
        providerSummary = summary;
        for (const [provider, message] of Object.entries(summary.errors)) {
          log.warn({ provider, message }, "provider usage ingest warning");
        }
        sseNotify.trigger();
      },
      onPassEnd: ({ ok, ms, message, first }) => {
        if (ok) log[first ? "info" : "debug"]({ ms }, "provider usage ingestion sync complete");
        else log.warn({ message, ms }, "provider usage ingestion sync failed");
        if (first) {
          providersSyncing = false;
          sseNotify.trigger();
        }
      },
    });
  }
  const snapshot = (source: "api" | "sse"): DashSnapshot => {
    const t0 = performance.now();
    try {
      return collect();
    } finally {
      const ms = Math.round(performance.now() - t0);
      log.debug({ source, ms }, "snapshot built");
      if (ms > 1000) log.warn({ source, ms }, "slow snapshot build");
    }
  };
  const state = stateDir();
  const hub = createHub({
    collect: () => snapshot("sse"), intervalMs, log, subscribe: sseNotify.subscribe,
    watchDirs: () => (opts.collect ? [] : providerWatchDirs()),
    recursiveDirs: () => (opts.collect ? [] : ["kiba", "lanes", "leads"].map((d) => join(state, d))),
    flow: (snap) => flowState(snap, state),
  });
  const server = Bun.serve({
    hostname: host,
    port,
    // SSE streams stay open: the heartbeat keeps them under this idle limit.
    idleTimeout: 60,
    async fetch(req) {
      const started = performance.now();
      const url = new URL(req.url);
      let status = 500;
      if (req.method !== "GET" && req.method !== "HEAD") {
        status = 405;
        const response = new Response("method not allowed\n", { status });
        const ms = Math.round(performance.now() - started);
        log.debug({ method: req.method, path: url.pathname, status, ms }, "http request");
        return response;
      }
      let response: Response;
      try {
        if (url.pathname === "/api/health") {
          status = 200;
          response = json({ ok: true });
        } else if (url.pathname === "/api/snapshot") {
          status = 200;
          response = json(snapshot("api"));
        } else if (url.pathname === "/api/stream") {
          status = 200;
          response = hub.response("snapshot", url.pathname);
        } else if (url.pathname === "/api/flow") {
          status = 200;
          response = hub.response("flow", url.pathname);
        } else if (url.pathname.startsWith("/api/")) {
          status = 404;
          response = json({ error: "not found" }, status);
        } else {
          response = staticResponse(dist, url.pathname);
          status = response.status;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ method: req.method, path: url.pathname, message }, "request failed");
        status = 500;
        response = json({ error: "internal" }, status);
      }
      const ms = Math.round(performance.now() - started);
      log.debug({ method: req.method, path: url.pathname, status, ms }, "http request");
      if (ms > 500 || status >= 500) log.info({ method: req.method, path: url.pathname, status, ms }, "slow/error request");
      return response;
    },
  });
  if (sync) {
    const stopServer = server.stop.bind(server);
    server.stop = ((closeActiveConnections?: boolean) => {
      sync?.stop();
      sync = null;
      return stopServer(closeActiveConnections);
    }) as typeof server.stop;
  }
  log.info({ host: server.hostname, port: server.port }, `listening http://${server.hostname}:${server.port}`);
  return server;
}
