// Pure mappings from orch state onto the dashboard vocabulary.
// No I/O. Tests drive every branch with constructed rows.
import type { LaneState } from "../lane.ts";
import { inspectSecrets } from "../memory/privacy.ts";
import type { DashEvent, DashHeatCell, DashLane, DashLaneProgress, DashLead, DashLogLine, DashRuntime, DashSkill, DashWorking, LaneLife } from "./types.ts";

function projectOf(repoOrCwd: string): string {
  const trimmed = repoOrCwd.replace(/\/+$/, "") || repoOrCwd;
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export const LANE_LIVES: LaneLife[] = ["queued", "claimed", "running", "verify", "done", "failed", "blocked"];

export function laneLife(input: {
  status: string;
  verifyOk?: boolean | null;
  ended?: string | null;
  pid?: number;
}): LaneLife {
  if (input.status === "blocked") return "blocked";
  if (input.status === "running") {
    if (input.verifyOk === false) return "failed";
    if (input.verifyOk === true) return "verify";
    return "running";
  }
  if (input.status === "complete" || input.status === "noop" || input.status === "integrated") return "done";
  if (input.status === "failed" || input.status === "refused" || input.status === "timeout" || input.status === "unavailable") {
    return "failed";
  }
  if (!input.ended && input.pid == null) return "queued";
  if (!input.ended && input.pid != null) return "claimed";
  return "done";
}

export function durationSec(started: string, ended: string | null, now: Date): number | null {
  const from = Date.parse(started);
  const to = ended ? Date.parse(ended) : now.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / 1000);
}

/** Short public text: progress snippets and bus subjects stay one glance long. */
export const PUBLIC_TEXT_MAX = 160;
/** A Kiba note is read in full in the atelier thread (notes run to ~400 characters). */
export const NOTE_TEXT_MAX = 1200;

export function publicLogText(text: string, max = PUBLIC_TEXT_MAX): string | null {
  const scan = inspectSecrets(text.replace(/[\r\n\t]+/g, " ").trim());
  if (!scan.ok) return null;
  const cut = scan.text.slice(0, max);
  return cut || null;
}

export function enrichLane(lane: LaneState, now: Date): Omit<DashLane, "model" | "effort" | "costUsd" | "progress"> {
  const ended = lane.ended && lane.status !== "running" ? lane.ended : lane.status === "running" ? null : lane.ended || null;
  const life = laneLife({ status: lane.status, verifyOk: lane.verifyOk, ended, pid: lane.pid });
  const usage = lane.usage ?? {};
  return {
    id: lane.id,
    project: projectOf(lane.repo),
    status: lane.status,
    harness: lane.to,
    started: lane.started,
    ended,
    life,
    blocked: life === "blocked",
    verifyOk: lane.verifyOk ?? null,
    worktree: lane.worktree,
    durationSec: durationSec(lane.started, ended, now),
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? usage.cached ?? 0,
      cacheWrite: usage.cacheCreation ?? 0,
    },
    pid: lane.pid ?? null,
  };
}

export function estimateToolCalls(tokens: { input: number; output: number }): number | null {
  const n = tokens.input + tokens.output;
  if (n <= 0) return null;
  return Math.max(1, Math.round(n / 4000));
}

// The last step a running lane reported, for the dash: tool and file, then
// the assistant snippet, then the counters.
export function lastStepOf(p: DashLaneProgress): string {
  if (p.phase === "setup") return "SETUP en cours";
  if (p.phase === "verify") return "VERIFY en cours";
  if (p.lastTool) return p.lastFile ? `${p.lastTool} · ${p.lastFile}` : p.lastTool;
  return "Worker en cours";
}

function progressLines(p: DashLaneProgress): string[] {
  return [
    `Dernière étape : ${lastStepOf(p)}`,
    ...(p.lastText ? [`« ${p.lastText} »`] : []),
    `${p.turns} tours · ${p.toolCalls} appels d'outils · ${p.filesTouched} fichier${p.filesTouched > 1 ? "s" : ""} modifié${p.filesTouched > 1 ? "s" : ""}`,
  ];
}

export function workingOf(lanes: DashLane[], now: Date): DashWorking[] {
  return lanes
    .filter((lane) => lane.life === "running" || lane.life === "verify")
    .map((lane) => {
      const elapsed = lane.durationSec ?? durationSec(lane.started, lane.ended, now) ?? 0;
      const p = lane.progress;
      const stream = p
        ? progressLines(p)
        : lane.life === "verify"
          ? ["VERIFY en cours. Dernier état connu : worker terminé."]
          : ["Lane en cours. Pas de flux d'outils en direct : dernier état connu."];
      if (lane.blocked) stream.unshift("Bloquée.");
      const steps = [
        { label: "Démarrage", durationSec: Math.min(elapsed, 30) },
        ...(elapsed > 30 ? [{ label: "Travail", durationSec: elapsed - 30 }] : []),
        ...(lane.life === "verify" || p?.phase === "verify" ? [{ label: "VERIFY", durationSec: 0 }] : []),
      ];
      return {
        laneId: lane.id,
        project: lane.project,
        harness: lane.harness,
        model: lane.model,
        effort: lane.effort,
        elapsedSec: elapsed,
        lastStep: p ? lastStepOf(p) : null,
        lastText: p?.lastText ?? null,
        live: Boolean(p),
        toolCalls: p ? p.toolCalls : estimateToolCalls(lane.tokens),
        stream,
        steps,
      };
    });
}

export function activityOf(opts: {
  leads: DashLead[];
  lanes: DashLane[];
  ledger: { id: string; at: string; kind: string; project?: string; harness?: string; status?: string; model?: string }[];
  logs?: DashLogLine[];
  now?: Date;
}): DashEvent[] {
  const events: DashEvent[] = [];
  for (const lead of opts.leads) {
    if (!lead.started) continue;
    events.push({
      at: lead.started,
      actor: { kind: "lead", id: lead.id, harness: lead.harness, project: lead.project },
      verb: lead.activity === "working" ? "travaille" : lead.activity === "blocked" ? "est bloqué" : lead.activity === "busy" ? "est occupé" : "est au repos",
      text: `${lead.harness} · ${lead.model}`,
    });
  }
  for (const lane of opts.lanes) {
    events.push({
      at: lane.started,
      actor: { kind: "lane", id: lane.id, harness: lane.harness, project: lane.project },
      verb: lane.life === "blocked" ? "signale un blocage" : lane.life === "running" ? "prend la lane" : "enregistre la lane",
      text: `${lane.life} · ${lane.model}`,
    });
    if (lane.ended) {
      events.push({
        at: lane.ended,
        actor: { kind: "lane", id: lane.id, harness: lane.harness, project: lane.project },
        verb: lane.life === "failed" ? "échoue" : lane.life === "blocked" ? "reste bloquée" : "termine",
        text: lane.status,
      });
    }
  }
  for (const row of opts.ledger) {
    events.push({
      at: row.at,
      actor: { kind: "lane", id: row.id, project: row.project, ...(row.harness ? { harness: row.harness } : {}) },
      verb: row.kind === "run" ? "journalise un run" : row.kind,
      text: [row.status, row.model, row.kind === "outcome" ? row.id : undefined].filter(Boolean).join(" · "),
    });
  }
  for (const log of opts.logs ?? []) {
    events.push({
      at: log.at,
      actor: { kind: "log", id: log.kind, project: log.project },
      verb: log.kind === "next" ? "note NEXT" : log.kind === "state" ? "note RESUME" : log.kind,
      text: log.text,
    });
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 80);
}

export function sanitizeLogs(rows: { at: string; kind: string; text: string; project: string }[]): DashLogLine[] {
  const keep = new Set(["next", "state", "decision", "error"]);
  const out: DashLogLine[] = [];
  for (const row of rows) {
    if (!keep.has(row.kind)) continue;
    const text = publicLogText(row.text, NOTE_TEXT_MAX);
    if (!text) continue;
    out.push({ at: row.at, kind: row.kind, project: row.project, text });
  }
  return out.slice(-40);
}

export function runtimesOf(opts: {
  hostName: string;
  cores: number;
  ramGib: number;
  installed: string[];
  leads: DashLead[];
  lanes: DashLane[];
  ledger: { at: string; kind: string; costUsd?: number; model?: string; project?: string; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number } }[];
}): { runtimes: DashRuntime[]; heat: DashHeatCell[]; daily: DashHeatCell[] } {
  const tokenSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byHarness = new Map<string, { tokens: typeof tokenSum; cost: number }>();
  for (const h of ["claude", "codex", "grok"]) {
    byHarness.set(h, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  }
  const byDay = new Map<string, DashHeatCell>();
  for (const lane of opts.lanes) {
    const bucket = byHarness.get(lane.harness) ?? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
    bucket.tokens.input += lane.tokens.input;
    bucket.tokens.output += lane.tokens.output;
    bucket.tokens.cacheRead += lane.tokens.cacheRead;
    bucket.tokens.cacheWrite += lane.tokens.cacheWrite;
    bucket.cost += lane.costUsd;
    byHarness.set(lane.harness, bucket);
    tokenSum.input += lane.tokens.input;
    tokenSum.output += lane.tokens.output;
    tokenSum.cacheRead += lane.tokens.cacheRead;
    tokenSum.cacheWrite += lane.tokens.cacheWrite;
    const day = lane.started.slice(0, 10);
    const cell = byDay.get(day) ?? { day, costUsd: 0, runs: 0 };
    cell.costUsd += lane.costUsd;
    cell.runs += 1;
    byDay.set(day, cell);
  }
  for (const row of opts.ledger) {
    if (row.kind !== "run" || !row.at) continue;
    const day = row.at.slice(0, 10);
    const cell = byDay.get(day) ?? { day, costUsd: 0, runs: 0 };
    cell.costUsd += row.costUsd ?? 0;
    cell.runs += 1;
    byDay.set(day, cell);
  }
  const runtimes: DashRuntime[] = [
    {
      id: "host",
      kind: "host",
      name: opts.hostName,
      online: true,
      live: true,
      detail: `${opts.cores} cœurs · ${opts.ramGib.toFixed(0)} Gio`,
      tokens: tokenSum,
      costUsd: [...byHarness.values()].reduce((n, b) => n + b.cost, 0),
    },
    ...["claude", "codex", "grok"].map((id) => {
      const bucket = byHarness.get(id)!;
      const live = opts.leads.some((l) => l.harness === id) || opts.lanes.some((l) => l.harness === id && (l.life === "running" || l.life === "verify"));
      return {
        id,
        kind: "harness" as const,
        name: id,
        online: opts.installed.includes(id),
        live,
        detail: live ? "session ouverte" : opts.installed.includes(id) ? "installé" : "absent",
        tokens: bucket.tokens,
        costUsd: bucket.cost,
      };
    }),
  ];
  const heat = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return { runtimes, heat, daily: heat };
}

export function parseSkillFront(raw: string): { name: string; description: string } | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return null;
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  if (!name) return null;
  return { name, description: (description ?? "").slice(0, 220) };
}

export function skillsFromFiles(files: { id: string; text: string }[]): DashSkill[] {
  return files.flatMap((file) => {
    const meta = parseSkillFront(file.text);
    if (!meta) return [];
    return [{ id: file.id, name: meta.name, description: meta.description }];
  });
}
