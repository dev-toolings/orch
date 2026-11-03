// Background provider usage sync for `orch dash`: one ingest pass at a time
// in a Bun Worker, repeated on an interval. The server only keeps the last
// summary; a request never reads provider logs itself.
import type { ProviderUsageSummary } from "./providers-live.ts";

export interface ProviderSyncRequest {
  id: number;
  home: string;
  state: string;
  grokRoots?: string[];
  /** Also count today's Claude transcript tokens (policy.spend.plan_tokens). */
  planTokens?: boolean;
}

export type ProviderSyncReply =
  | { type: "cached"; id: number; summary: ProviderUsageSummary }
  | { type: "done"; id: number; summary: ProviderUsageSummary }
  | { type: "error"; id: number; message: string };

/** Runs one ingest pass; `onCached` may get a cache-only summary first. */
export interface ProviderSyncRunner {
  run(onCached: (summary: ProviderUsageSummary) => void): Promise<ProviderUsageSummary>;
  stop(): void;
}

export const DEFAULT_PROVIDER_SYNC_MS = 20_000;

export function workerProviderSync(opts: Omit<ProviderSyncRequest, "id">): ProviderSyncRunner {
  let worker: Worker | null = null;
  let seq = 0;
  let pending: { id: number; onCached: (s: ProviderUsageSummary) => void; resolve: (s: ProviderUsageSummary) => void; reject: (e: Error) => void } | null = null;
  const fail = (error: Error) => {
    const p = pending;
    pending = null;
    p?.reject(error);
  };
  const ensure = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL("./ingest-worker.ts", import.meta.url).href);
    (w as Worker & { unref?: () => void }).unref?.();
    w.onmessage = (event: MessageEvent<ProviderSyncReply>) => {
      const msg = event.data;
      if (!pending || msg.id !== pending.id) return;
      if (msg.type === "cached") {
        pending.onCached(msg.summary);
        return;
      }
      const p = pending;
      pending = null;
      if (msg.type === "done") p.resolve(msg.summary);
      else p.reject(new Error(msg.message));
    };
    w.onerror = (event) => {
      // A crashed worker is replaced on the next pass.
      worker = null;
      try { w.terminate(); } catch { /* already gone */ }
      fail(new Error(event.message || "provider ingest worker failed"));
    };
    worker = w;
    return w;
  };
  return {
    run(onCached) {
      if (pending) return Promise.reject(new Error("provider sync already running"));
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending = { id, onCached, resolve, reject };
        try {
          ensure().postMessage({ ...opts, id } satisfies ProviderSyncRequest);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    stop() {
      fail(new Error("provider sync stopped"));
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
    },
  };
}

/**
 * Loops `runner.run` every `intervalMs` after the previous pass ends (never
 * overlapping). `onUpdate` gets every summary; `first` marks the end of the
 * first pass, successful or not.
 */
export function startProviderSyncLoop(opts: {
  runner: ProviderSyncRunner;
  intervalMs?: number;
  onUpdate: (summary: ProviderUsageSummary, phase: "cached" | "done") => void;
  onPassEnd: (result: { ok: boolean; ms: number; message?: string; first: boolean }) => void;
}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_PROVIDER_SYNC_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  const pass = async () => {
    if (stopped) return;
    const t0 = performance.now();
    const wasFirst = first;
    first = false;
    try {
      const summary = await opts.runner.run((cached) => { if (!stopped) opts.onUpdate(cached, "cached"); });
      if (stopped) return;
      opts.onUpdate(summary, "done");
      opts.onPassEnd({ ok: true, ms: Math.round(performance.now() - t0), first: wasFirst });
    } catch (error) {
      if (stopped) return;
      opts.onPassEnd({ ok: false, ms: Math.round(performance.now() - t0), message: error instanceof Error ? error.message : String(error), first: wasFirst });
    }
    if (!stopped) {
      timer = setTimeout(() => { void pass(); }, intervalMs);
      timer.unref?.();
    }
  };
  void pass();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      opts.runner.stop();
    },
  };
}
