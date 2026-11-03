import type { Harness } from "../core/profile.ts";
import type { HarnessId } from "../harness/registry.ts";
import type { Status, Usage } from "../harness/harness.ts";
import { formatTiming, type GateTiming } from "./timing.ts";

export interface LaneReportFields {
  to: Harness;
  model: string;
  effort: string;
  status: Status;
  reason?: string;
  id: string;
  base: string;
  snapshotOf?: string;
  branch: string;
  orca?: string;
  setupLine: string;
  stat: string;
  verifyOut: string;
  message: string;
  usage: Usage;
  peakRssMb?: { worker?: number; verify?: number };
  changed: boolean;
  logPath: string;
  outOfScope?: string[];
  gate?: GateTiming;
  verifyScope?: string;
}

export interface ReviewReportFields {
  kind?: "REVIEW" | "ASK" | "CONTEST" | "JUDGE";
  to: HarnessId;
  model?: string | null;
  effort?: string;
  risk: "normal" | "high";
  exitCode: number | null;
  timedOut: boolean;
  usage: Usage;
  logPath: string;
  message: string;
  note?: string;
}

export function fmtUsage(u: Usage): string {
  const parts = Object.entries(u).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(", ") : "not reported";
}

export function laneReport(f: LaneReportFields): string {
  const peak = [
    f.peakRssMb?.worker === undefined ? "" : `worker ${f.peakRssMb.worker} MB`,
    f.peakRssMb?.verify === undefined ? "" : `verify ${f.peakRssMb.verify} MB`,
  ].filter(Boolean);
  return [
    "LANE REPORT",
    `LANE: ${f.to} · ${f.model} · effort ${f.effort}`,
    `STATUS: ${f.status}`,
    f.reason ? `REASON: ${f.reason}` : "",
    `ID: ${f.id}`,
    `BASE: ${f.base} (${f.snapshotOf ? `snapshot of dirty tree over HEAD ${f.snapshotOf}` : "HEAD"})`,
    `BRANCH: ${f.branch}`,
    f.orca ? `ORCA: ${f.orca}` : "",
    f.setupLine,
    `CHANGES:\n${f.stat}`,
    f.outOfScope?.length ? `SCOPE: ${f.outOfScope.length} file(s) outside FILES: ${f.outOfScope.slice(0, 8).join(", ")}` : "",
    `VERIFY: ${f.verifyOut}`,
    f.verifyScope ? `VERIFY SCOPE: ${f.verifyScope}` : "",
    f.gate ? formatTiming(f.gate) : "",
    peak.length ? `PEAK RSS: ${peak.join(", ")}` : "",
    `WORKER SAID: ${f.message.replace(/\s+/g, " ").trim().slice(0, 400) || "(nothing)"}`,
    `USAGE: ${fmtUsage(f.usage)}`,
    `PROVENANCE: source=lane id=${f.id} harness=${f.to} trust=worker`,
    f.changed && f.status === "complete"
      ? f.snapshotOf
        ? `INTEGRATE: git diff --binary --no-ext-diff --no-textconv ${f.base} ${f.branch} | git apply && lane gc --drop ${f.id}`
        : `INTEGRATE: git merge --squash ${f.branch}  then: lane gc`
      : "",
    f.changed && f.status === "complete" ? `GATE: lane integrate ${f.id}  (checks VERIFY, scope, risk and branch, then applies and drops)` : "",
    `LOG: ${f.logPath}`,
  ].filter(Boolean).join("\n") + "\n";
}

export function reviewReport(f: ReviewReportFields): string {
  const head = `${f.kind ?? "REVIEW"} REPORT\nREVIEWER: ${f.to} · ${f.model ?? "inherited"} · effort ${f.effort ?? "default"} · risk ${f.risk}${f.note ? ` (${f.note})` : ""}\nEXIT: ${f.exitCode}${f.timedOut ? " (timeout)" : ""}\nUSAGE: ${fmtUsage(f.usage)}\nPROVENANCE: source=lane-consult kind=${f.kind ?? "REVIEW"} harness=${f.to} trust=advisor\nLOG: ${f.logPath}\n`;
  return `${head}${f.message.trim()}\n`;
}
