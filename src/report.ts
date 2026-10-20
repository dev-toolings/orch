import type { Harness } from "./profile.ts";
import type { Status, Usage } from "./harness.ts";

export interface LaneReportFields {
  to: Harness;
  model: string;
  effort: string;
  channel: string;
  channelReason: string;
  status: Status;
  reason?: string;
  id: string;
  base: string;
  snapshotOf?: string;
  branch: string;
  setupLine: string;
  stat: string;
  verifyOut: string;
  message: string;
  usage: Usage;
  changed: boolean;
  logPath: string;
}

export interface ReviewReportFields {
  to: Harness;
  model?: string | null;
  effort?: string;
  risk: "normal" | "high";
  exitCode: number | null;
  timedOut: boolean;
  usage: Usage;
  logPath: string;
  message: string;
}

export function fmtUsage(u: Usage): string {
  const parts = Object.entries(u).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(", ") : "not reported";
}

export function laneReport(f: LaneReportFields): string {
  return [
    "LANE REPORT",
    `LANE: ${f.to} · ${f.model} · effort ${f.effort} · ${f.channel}`,
    f.channelReason ? `CHANNEL: ${f.channelReason}` : "",
    `STATUS: ${f.status}`,
    f.reason ? `REASON: ${f.reason}` : "",
    `ID: ${f.id}`,
    `BASE: ${f.base} (${f.snapshotOf ? `snapshot of dirty tree over HEAD ${f.snapshotOf}` : "HEAD"})`,
    `BRANCH: ${f.branch}`,
    f.setupLine,
    `CHANGES:\n${f.stat}`,
    `VERIFY: ${f.verifyOut}`,
    `WORKER SAID: ${f.message.replace(/\s+/g, " ").trim().slice(0, 400) || "(nothing)"}`,
    `USAGE: ${fmtUsage(f.usage)}`,
    f.changed && f.status === "complete"
      ? f.snapshotOf
        ? `INTEGRATE: git diff --binary --no-ext-diff --no-textconv ${f.base} ${f.branch} | git apply && lane gc --drop ${f.id}`
        : `INTEGRATE: git merge --squash ${f.branch}  then: lane gc`
      : "",
    `LOG: ${f.logPath}`,
  ].filter(Boolean).join("\n") + "\n";
}

export function reviewReport(f: ReviewReportFields): string {
  const head = `REVIEW REPORT\nREVIEWER: ${f.to} · ${f.model ?? "inherited"} · effort ${f.effort ?? "default"} · risk ${f.risk}\nEXIT: ${f.exitCode}${f.timedOut ? " (timeout)" : ""}\nUSAGE: ${fmtUsage(f.usage)}\nLOG: ${f.logPath}\n`;
  return `${head}${f.message.trim()}\n`;
}
