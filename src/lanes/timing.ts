// Per-gate timings: wait (slot), setup (install / cache), run (VERIFY).
export interface GateTiming {
  waitMs: number;
  setupMs: number;
  runMs: number;
}

export function emptyTiming(): GateTiming {
  return { waitMs: 0, setupMs: 0, runMs: 0 };
}

export function formatTiming(t: GateTiming): string {
  const part = (label: string, ms: number) => `${label} ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`}`;
  return `GATE TIME: ${part("wait", t.waitMs)} · ${part("setup", t.setupMs)} · ${part("run", t.runMs)}`;
}

export function addTiming(a: GateTiming, b: Partial<GateTiming>): GateTiming {
  return {
    waitMs: a.waitMs + (b.waitMs ?? 0),
    setupMs: a.setupMs + (b.setupMs ?? 0),
    runMs: a.runMs + (b.runMs ?? 0),
  };
}
