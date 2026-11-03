// Shared model of the atelier room: which projects get a desk, who sits
// there, and the conversation derived from the snapshot activity feed.
// Every line comes from a real event; nothing is invented.
import type { DashEvent, DashLane, DashTask, DashLead, DashSnapshot, LeadActivity } from "../types";
import { activeLanes, harnessLabel, statusLabel } from "./format";

export type LineTone = "say" | "decision" | "next" | "error" | "done" | "fail";

export interface Speaker {
  kind: "lead" | "lane";
  /** Lead or lane id when known, so a line can select its author. */
  id: string | null;
  harness: string | null;
  name: string;
}

export interface RoomLine {
  key: string;
  at: string;
  project: string | null;
  speaker: Speaker;
  text: string;
  tone: LineTone;
  /** Lane lines only: the step this line marks, so a thread can merge a lane's start and end. */
  step?: string;
  /** Lane lines only: the model announced at the start. */
  model?: string;
}

export interface RoomDesk {
  project: string;
  leads: DashLead[];
  lanes: DashLane[];
  col: number;
  row: number;
}

export interface RoomLink {
  id: string;
  from: string;
  to: string;
}

export interface Room {
  desks: RoomDesk[];
  idle: string[];
  cols: number;
  rows: number;
  lines: RoomLine[];
  links: RoomLink[];
}

/** A word older than this no longer shows as a bubble in the room. */
export const BUBBLE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function buildRoom(snap: DashSnapshot): Room {
  const pendingBus = snap.bus.pending ?? [];
  const present = new Set<string>();
  for (const lead of snap.leads) present.add(lead.project);
  for (const lane of activeLanes(snap.lanes)) present.add(lane.project);
  for (const msg of pendingBus) {
    present.add(msg.from);
    present.add(msg.to);
  }
  const known = new Set(snap.projects.map((p) => p.name));
  const names = [...present].filter((name) => known.has(name) || snap.leads.some((l) => l.project === name)).sort();
  const cols = names.length <= 1 ? 1 : names.length <= 4 ? 2 : names.length <= 9 ? 3 : 4;
  const desks = names.map((project, i) => ({
    project,
    leads: snap.leads.filter((lead) => lead.project === project),
    lanes: activeLanes(snap.lanes.filter((lane) => lane.project === project)),
    col: i % cols,
    row: Math.floor(i / cols),
  }));
  const idle = snap.projects.map((p) => p.name).filter((name) => !present.has(name)).sort();
  const links = pendingBus
    .filter((msg) => present.has(msg.from) && present.has(msg.to) && msg.from !== msg.to)
    .map((msg) => ({ id: msg.id, from: msg.from, to: msg.to }));
  return {
    desks,
    idle,
    cols,
    rows: Math.max(1, Math.ceil(desks.length / cols)),
    lines: conversation(snap),
    links,
  };
}

function conversation(snap: DashSnapshot): RoomLine[] {
  const seen = new Set<string>();
  const out: RoomLine[] = [];
  for (const event of snap.activity) {
    const line = lineOf(event, snap);
    if (!line) continue;
    const dedupe = `${line.speaker.id ?? line.speaker.name}|${line.project}|${line.text}|${line.at.slice(0, 16)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(line);
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  // Keep the last day; a quiet day still shows the latest exchanges.
  const since = Date.parse(snap.at) - THREAD_WINDOW_MS;
  const recent = out.filter((line) => Date.parse(line.at) >= since);
  return recent.length >= 8 ? recent : out.slice(-24);
}

const THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

function leadSpeaker(project: string | undefined, snap: DashSnapshot): Speaker {
  const lead = project ? snap.leads.find((row) => row.project === project) : undefined;
  return { kind: "lead", id: lead?.id ?? null, harness: lead?.harness ?? null, name: "Kiba" };
}

function lineOf(event: DashEvent, snap: DashSnapshot): RoomLine | null {
  const { actor, verb } = event;
  const text = event.text.trim();
  const key = `${event.at}|${actor.kind}|${actor.id}|${verb}`;
  if (actor.kind === "log") {
    // Notes often open with their own clock ("18:05 ..."); the line already carries the time.
    const said = text.replace(/^\d{1,2}[:h]\d{2}\s+/, "");
    const project = actor.project ?? null;
    const speaker = leadSpeaker(actor.project, snap);
    if (verb === "decision") return { key, at: event.at, project, speaker, text: said, tone: "decision" };
    if (verb === "error") return { key, at: event.at, project, speaker, text: said, tone: "error" };
    if (verb === "note NEXT") return { key, at: event.at, project, speaker, text: said, tone: "next" };
    // RESUME snapshots ("branch develop @ ...") are state, not speech.
    if (!text || /^branch\s/.test(text)) return null;
    return { key, at: event.at, project, speaker, text: said, tone: "say" };
  }
  if (actor.kind === "lead") return null; // activity changes show as halos, not words
  const lane = snap.lanes.find((row) => row.id === actor.id);
  const harness = actor.harness ?? lane?.harness ?? null;
  const project = actor.project ?? lane?.project ?? null;
  if (!project) return null; // ledger outcome of a lane no longer on disk: nobody to place it on
  const speaker: Speaker = {
    kind: "lane",
    id: actor.id,
    harness,
    name: harness ? `Lane ${harnessLabel(harness)}` : "Lane",
  };
  const first = text.split(" · ")[0]?.trim() ?? "";
  switch (verb) {
    case "journalise un run":
      return null; // duplicate of the outcome line
    case "prend la lane":
      return { key, at: event.at, project, speaker, text: "Lane prise, au travail.", tone: "say", step: "prise" };
    case "enregistre la lane": {
      // Stamped at the lane's start: its final status belongs to the end line.
      const model = text.split(" · ")[1]?.trim();
      const known = model && model !== "—" ? model : undefined;
      return { key, at: event.at, project, speaker, text: `Lane lancée${known ? ` (${known})` : ""}.`, tone: "say", step: "lancée", model: known };
    }
    case "échoue": {
      const why = first && first !== "failed" ? statusLabel(first).toLowerCase() : "";
      return { key, at: event.at, project, speaker, text: why ? `Échec : ${why}.` : "Échec.", tone: "fail", step: why ? `échec (${why})` : "échec" };
    }
    case "outcome": {
      const ok = first === "integrated" || first === "complete" || first === "done";
      const bad = first === "failed" || first === "refused" || first === "timeout";
      return { key, at: event.at, project, speaker, text: `${statusLabel(first)}.`, tone: ok ? "done" : bad ? "fail" : "say", step: statusLabel(first).toLowerCase() };
    }
    default: {
      const said = `${verb} ${text}`.trim();
      return { key, at: event.at, project, speaker, text: said, tone: "say", step: said };
    }
  }
}

/** Latest recent line spoken at a desk, or null when the desk is quiet. */
export function lastWord(room: Room, project: string, now = Date.now()): RoomLine | null {
  for (let i = room.lines.length - 1; i >= 0; i--) {
    const line = room.lines[i];
    if (line.project !== project) continue;
    return now - Date.parse(line.at) <= BUBBLE_MAX_AGE_MS ? line : null;
  }
  return null;
}

export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 60) return "à l'instant";
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export const HARNESS_HEX: Record<string, string> = {
  claude: "#c9714b",
  codex: "#3e8e83",
  grok: "#5a5fcf",
};

export const ACTIVITY_HEX: Record<LeadActivity, string> = {
  working: "#22a35a",
  busy: "#d29a12",
  blocked: "#e11d48",
  idle: "#8c877e",
};

export function harnessHex(harness: string | null | undefined): string {
  return (harness && HARNESS_HEX[harness]) || "#8c877e";
}

export function laneActivity(lane: DashLane): LeadActivity {
  return lane.life === "blocked" || lane.blocked ? "blocked" : "working";
}

/** Open orch serve tasks of a desk's project, with the lane running each one. */
export function deskTasks(snap: DashSnapshot, desk: RoomDesk): DashTask[] {
  const ids = new Set(desk.lanes.map((l) => l.id));
  return (snap.tasks ?? []).filter((t) => (t.project === desk.project && t.state !== "ended") || (t.progress && ids.has(t.progress.id)));
}

export function taskLine(t: DashTask): string {
  const p = t.progress;
  const doing = p?.lastFile ? `${p.lastTool ?? ""} ${p.lastFile.split("/").pop()}`.trim() : (p?.lastText ?? "").replace(/\s+/g, " ").slice(0, 60);
  return [
    `${t.state} r${t.revision}`,
    t.job ? `${t.job.kind} ${t.job.status}` : t.next !== "none" ? `ensuite ${t.next}` : null,
    p?.phase ?? null,
    p?.turns != null ? `${p.turns} tours` : null,
    doing || null,
  ].filter(Boolean).join(" · ");
}

// Screen-space overlays of the 3D atelier (bubbles, lane tags): a greedy pass
// keeps them from covering each other. Higher priority is placed first and
// never moves for a lower one; a lower one is nudged up, or hidden.
export interface OverlayBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  prio: number;
}

export interface OverlayPlacement {
  dy: number;
  hidden: boolean;
}

export function resolveOverlays(boxes: OverlayBox[], gap = 4, maxSteps = 2): Map<string, OverlayPlacement> {
  const out = new Map<string, OverlayPlacement>();
  const kept: OverlayBox[] = [];
  const hits = (a: OverlayBox, dy: number, b: OverlayBox) =>
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y + dy < b.y + b.h + gap && b.y < a.y + dy + a.h + gap;
  const order = [...boxes].sort((a, b) => b.prio - a.prio || b.y - a.y);
  for (const box of order) {
    let placed = false;
    for (let step = 0; step <= maxSteps && !placed; step++) {
      const dy = -step * (box.h + gap);
      if (kept.some((other) => hits(box, dy, other))) continue;
      kept.push({ ...box, y: box.y + dy });
      out.set(box.id, { dy, hidden: false });
      placed = true;
    }
    if (!placed) out.set(box.id, { dy: 0, hidden: true });
  }
  return out;
}
