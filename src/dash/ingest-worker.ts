// Bun Worker for `orch dash`: runs the synchronous provider log ingest off
// the server's event loop and posts a compact summary after each pass.
import { claudeProjectsDir, tokensOnDay, tokenUsage, utcDay } from "../ops/usage.ts";
import { cachedProviderSummary, ingestProviderLogs, summarizeProviderMemory } from "./providers-live.ts";
import type { ProviderSyncReply, ProviderSyncRequest } from "./provider-sync.ts";

declare const self: Worker;

let first = true;

function planTokens(home: string, now: Date): { day: string; tokens: number } {
  const day = utcDay(now);
  return { day, tokens: tokensOnDay(tokenUsage(claudeProjectsDir(home), new Date(`${day}T00:00:00.000Z`)), day) };
}

self.onmessage = (event: MessageEvent<ProviderSyncRequest>) => {
  const req = event.data;
  const reply = (msg: ProviderSyncReply) => self.postMessage(msg);
  try {
    if (first) {
      first = false;
      // The persisted cache alone, so the dash shows numbers before the first pass ends.
      const cached = cachedProviderSummary({ home: req.home, state: req.state, now: new Date() });
      if (cached) reply({ type: "cached", id: req.id, summary: cached });
    }
    const now = new Date();
    const errors = ingestProviderLogs({ home: req.home, state: req.state, now, grokRoots: req.grokRoots });
    const summary = summarizeProviderMemory(req.home, now, errors);
    if (req.planTokens) {
      try { summary.planTokens = planTokens(req.home, now); } catch { /* plan figure is best effort */ }
    }
    reply({ type: "done", id: req.id, summary });
  } catch (error) {
    reply({ type: "error", id: req.id, message: error instanceof Error ? error.message : String(error) });
  }
};
