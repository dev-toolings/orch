// The watchdog of orch serve workers (src/serve/engine.ts): stall, no
// progress for `stall_seconds`; drift, a touched file outside the declared
// FILES; loop, `max_turns_without_test` worker steps since VERIFY or a
// targeted test invocation. Recovery: kill the worker's process group (the
// step then fails and the ladder applies), then one signal to the caller. A
// group still alive `KILL_GRACE_MS` after SIGTERM gets SIGKILL.
import { processGroupAlive } from "../harness/proc.ts";
import { isHarnessOwned } from "../lanes/harness-files.ts";
import { inScope } from "../lanes/route.ts";
import type { KibaConfig } from "./rules.ts";

export interface LaneWatch {
  id: string;
  phase: string;
  // Changes whenever the lane makes progress (turns, tool calls, update time).
  progressKey: string;
  turns: number;
  lastTool: string | null;
  lastVerifyTurn?: number | null;
  stepsSinceVerify?: number;
  progressObservable?: boolean;
  declared: string[];
  touched: string[];
  pgid?: number;
  // The task the watched worker runs for.
  intent?: string;
}

export type FindingKind = "stall" | "drift" | "loop";
export interface Finding { lane: string; kind: FindingKind; summary: string }

type Cfg = KibaConfig["watchdog"];

export function assess(w: LaneWatch, quietMs: number, sawTest: boolean, cfg: Cfg): Finding | null {
  const out = w.declared.length ? w.touched.filter((f) => !inScope(f, w.declared) && !isHarnessOwned(f, w.declared)) : [];
  if (out.length) return { lane: w.id, kind: "drift", summary: `touched outside FILES: ${out.slice(0, 5).join(", ")}${out.length > 5 ? ` (+${out.length - 5})` : ""}` };
  if (w.progressObservable === false) return null; // Grok is opaque; its lane's hard timeout still applies.
  if (w.phase === "worker" && quietMs >= cfg.stall_seconds * 1000) return { lane: w.id, kind: "stall", summary: `no progress for ${Math.round(quietMs / 1000)} s (phase ${w.phase})` };
  const since = w.stepsSinceVerify ?? (w.lastVerifyTurn != null ? Math.max(0, w.turns - w.lastVerifyTurn) : sawTest ? 0 : w.turns);
  if (w.phase === "worker" && since >= cfg.max_turns_without_test) return { lane: w.id, kind: "loop", summary: `${since} steps since VERIFY or a targeted test` };
  return null;
}

export function killGroup(pgid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pgid || pgid <= 1) return false;
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

// Between the SIGTERM of a recovery and the SIGKILL of a group that ignored it.
export const KILL_GRACE_MS = 15_000;

export interface WatchDeps {
  observe: () => LaneWatch[] | Promise<LaneWatch[]>;
  kill?: (w: LaneWatch, signal?: NodeJS.Signals) => boolean;
  // Still running after a kill (default: its process group exists).
  alive?: (w: LaneWatch) => boolean;
  // Reaps what died without a record; run on every pass.
  reap?: () => unknown | Promise<unknown>;
  signal?: (f: Finding, action: string) => void;
  now?: () => number;
  // Only lanes this returns true for are acted on (default: all).
  owns?: (w: LaneWatch) => boolean | Promise<boolean>;
  // Code revision on disk; a change from the one at start makes the watchdog stale.
  revision?: () => string | null;
  staleSignal?: () => void;
}

export class Watchdog {
  private seen = new Map<string, { key: string; at: number }>();
  // Lanes recovered once: the group signalled, when, and whether SIGKILL followed.
  private handled = new Map<string, { pgid?: number; at: number; escalated: boolean }>();
  private startRev: string | null;
  private staleSent = false;
  constructor(private cfg: Cfg, private deps: WatchDeps) { this.startRev = deps.revision?.() ?? null; }

  // One pass: each lane is recovered at most once.
  async tick(): Promise<Finding[]> {
    try { await this.deps.reap?.(); } catch { /* a reaper pass never stops the watchdog */ }
    if (this.deps.revision && this.deps.revision() !== this.startRev) {
      if (!this.staleSent) { this.staleSent = true; this.deps.staleSignal?.(); }
      return [];
    }
    const now = this.deps.now?.() ?? Date.now();
    const found: Finding[] = [];
    const kill = this.deps.kill ?? ((x: LaneWatch, sig?: NodeJS.Signals) => killGroup(x.pgid, sig));
    for (const w of await this.deps.observe()) {
      const done = this.handled.get(w.id);
      if (done) {
        // The same group outlived its SIGTERM: SIGKILL, once.
        if (!done.escalated && done.pgid === w.pgid && now - done.at >= KILL_GRACE_MS
          && (this.deps.alive ?? ((x: LaneWatch) => processGroupAlive(x.pgid)))(w)) {
          done.escalated = true;
          kill(w, "SIGKILL");
        }
        continue;
      }
      if (this.deps.owns && !(await this.deps.owns(w))) continue;
      const prev = this.seen.get(w.id);
      const at = prev && prev.key === w.progressKey ? prev.at : now;
      this.seen.set(w.id, { key: w.progressKey, at });
      const f = assess(w, now - at, false, this.cfg);
      if (!f) continue;
      this.handled.set(w.id, { pgid: w.pgid, at: now, escalated: false });
      const killed = kill(w, "SIGTERM");
      const action = killed ? "worker killed; the step ends failed and the ladder applies" : "worker already gone";
      this.deps.signal?.(f, action);
      found.push(f);
    }
    return found;
  }
}
