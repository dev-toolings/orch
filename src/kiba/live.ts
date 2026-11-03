// Live view of running lanes for `orch lane watch` and the dash task view.
// Reads small files only (lane state.json, progress.json): no git, no model,
// no lane.ts import.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLaneProgress, type LaneProgress } from "../lanes/progress.ts";

export interface LiveLane {
  id: string; status: string; intent?: string; model: string | null; effort: string | null;
  phase: string | null; turns: number | null; lastTool: string | null; lastFile: string | null; lastText: string | null; elapsedS: number | null;
}

interface LaneFile { id: string; status: string; intent?: string; model?: string; effort?: string; started?: string }

export function runningLanes(root: string): LiveLane[] {
  const dir = join(root, "lanes");
  if (!existsSync(dir)) return [];
  const out: LiveLane[] = [];
  for (const id of readdirSync(dir)) {
    let s: LaneFile;
    try { s = JSON.parse(readFileSync(join(dir, id, "state.json"), "utf8")) as LaneFile; } catch { continue; }
    if (s.status !== "running") continue;
    const p: LaneProgress | null = readLaneProgress(join(dir, id));
    out.push({
      id: s.id ?? id, status: s.status, ...(s.intent ? { intent: s.intent } : {}),
      model: p?.model ?? s.model ?? null, effort: p?.effort ?? s.effort ?? null, phase: p?.phase ?? "setup",
      turns: p?.turns ?? null, lastTool: p?.lastTool ?? null, lastFile: p?.lastFile ?? null, lastText: p?.lastText ?? null, elapsedS: p?.elapsedS ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// `orch lane watch`: one table, refreshed by the caller.
export function watchTable(root: string, only?: string): string {
  const lanes = runningLanes(root).filter((l) => !only || l.id === only);
  if (!lanes.length) return only ? `lane ${only}: not running` : "no running lane";
  const rows = [["LANE", "MODEL", "PHASE", "TURNS", "LAST"]];
  for (const l of lanes) {
    rows.push([l.id,
      l.model ? `${l.model}${l.effort ? `/${l.effort}` : ""}` : "-", l.phase ?? "-", l.turns == null ? "-" : String(l.turns),
      clip(l.lastFile ? `${l.lastTool ?? ""} ${l.lastFile}` : (l.lastText ?? "").replace(/\s+/g, " "), 60) || "-"]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((v, c) => v.padEnd(w[c])).join("  ").trimEnd()).join("\n");
}
