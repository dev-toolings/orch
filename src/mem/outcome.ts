// outcome: how a recalled note held up in use, one signal per use, so
// `orch mem reflect` tells trusted notes from dead ends. Signals live in one
// append-only file under the state dir, never in the notes: a versioned project
// note gets no churn from being used. No model call. Scoring adapted from
// graphify's reflect (Graphify-Labs/graphify, Apache-2.0): each signal is
// signed and halves in weight every 30 days, and one session cannot make a
// note trusted on its own.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { type Caller, formatLine, listNotes, type Note, type Scope } from "./mem.ts";

export type Outcome = "useful" | "dead_end";
export const OUTCOMES: Outcome[] = ["useful", "dead_end"];
export const HALF_LIFE_DAYS = 30;
const MIN_SESSIONS = 2;

export interface Signal {
  note: string;
  outcome: Outcome;
  why?: string;
  date: string;
  harness: string;
  session: string;
}

type Kind = "trusted" | "tentative" | "contested" | "dead_end";

export interface Standing {
  note: Note;
  kind: Kind;
  score: number;
  useful: number;
  deadEnds: number;
  why?: string; // the latest dead end's reason
}

type Opts = { state?: string; cwd?: string; scope?: Scope; now?: Date; halfLifeDays?: number };

const signalsPath = (state?: string) => join(state ?? stateDir(), "mem", "outcomes.jsonl");

export function recordOutcome(id: string, outcome: string, why: string | undefined, caller: Caller, opts: Opts = {}): Signal {
  if (caller.lane) throw new Error("mem outcome: workers never write memory, put it in the report");
  if (!(OUTCOMES as string[]).includes(outcome)) throw new Error(`mem outcome: ${outcome || "(none)"} is not ${OUTCOMES.join(" or ")}`);
  const note = listNotes(caller, { ...opts, scope: undefined, all: true }).find((n) => n.id === id);
  if (!note) throw new Error(`mem: no readable note ${id}`);
  if (note.status && note.status !== "active") throw new Error(`mem outcome: note ${id} is not active`);
  const reason = why?.replace(/\s+/g, " ").trim();
  const signal: Signal = {
    note: id,
    outcome: outcome as Outcome,
    ...(reason ? { why: reason } : {}),
    date: (opts.now ?? new Date()).toISOString(),
    harness: caller.harness,
    session: caller.session,
  };
  const path = signalsPath(opts.state);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(signal)}\n`);
  return signal;
}

// A torn or foreign line is skipped, never fatal: the file is append-only.
export function readSignals(state?: string): Signal[] {
  const path = signalsPath(state);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const s = JSON.parse(line) as Signal;
      return typeof s?.note === "string" && (OUTCOMES as string[]).includes(s.outcome) && typeof s.date === "string" ? [s] : [];
    } catch {
      return [];
    }
  });
}

// Weight in (0, 1]: halves every halfLifeDays, so a fresh dead end outweighs an old use.
function decay(date: string, now: Date, halfLifeDays: number): number {
  const age = (now.getTime() - Date.parse(date)) / 86_400_000;
  return Number.isFinite(age) ? 0.5 ** (Math.max(0, age) / halfLifeDays) : 0;
}

const ORDER: Kind[] = ["trusted", "tentative", "contested", "dead_end"];

// Active readable notes that received a signal, best first within each kind.
export function standings(caller: Caller, opts: Opts = {}): Standing[] {
  const now = opts.now ?? new Date();
  const halfLife = opts.halfLifeDays ?? HALF_LIFE_DAYS;
  const notes = new Map(listNotes(caller, opts).map((n) => [n.id, n]));
  const byNote = new Map<string, Signal[]>();
  for (const s of readSignals(opts.state)) {
    if (notes.has(s.note)) byNote.set(s.note, [...(byNote.get(s.note) ?? []), s]);
  }
  const out = [...byNote].map(([id, signals]): Standing => {
    const useful = signals.filter((s) => s.outcome === "useful");
    const deadEnds = signals.filter((s) => s.outcome === "dead_end").sort((a, b) => a.date.localeCompare(b.date));
    const score = signals.reduce((sum, s) => sum + (s.outcome === "useful" ? 1 : -1) * decay(s.date, now, halfLife), 0);
    // a session without an id counts once per signal: it cannot be told apart
    const sessions = new Set(useful.map((s) => `${s.harness}:${s.session || s.date}`)).size;
    const kind: Kind = useful.length && deadEnds.length ? "contested" : deadEnds.length ? "dead_end" : sessions >= MIN_SESSIONS ? "trusted" : "tentative";
    return { note: notes.get(id)!, kind, score, useful: useful.length, deadEnds: deadEnds.length, why: deadEnds.at(-1)?.why };
  });
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.score - a.score || a.note.id.localeCompare(b.note.id));
}

export function badge(s: Standing): string {
  if (s.kind === "trusted") return `[trusted x${s.useful}]`;
  if (s.kind === "tentative") return `[useful x${s.useful}]`;
  if (s.kind === "dead_end") return `[dead end x${s.deadEnds}]`;
  return `[contested +${s.useful}/-${s.deadEnds}]`;
}

export function badges(caller: Caller, opts: Opts = {}): Map<string, string> {
  return new Map(standings(caller, opts).map((s) => [s.note.id, badge(s)]));
}

const HEADINGS: Record<Kind, string> = {
  trusted: "trusted (useful in 2 or more sessions)",
  tentative: "tentative (useful in one session)",
  contested: "contested (useful and dead end: the score, recent signals first, decides)",
  dead_end: "dead ends (check before following again)",
};

// The lessons view: trusted notes, dead ends and the latest corrections.
export function reflect(caller: Caller, opts: Opts & { limit?: number } = {}): string {
  const limit = opts.limit ?? 10;
  const all = standings(caller, opts);
  const sections = ORDER.flatMap((kind) => {
    const rows = all.filter((s) => s.kind === kind).slice(0, limit);
    if (!rows.length) return [];
    const lines = rows.map((s) => `  ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}  ${formatLine(s.note, badge(s))}${s.why ? `\n         why: ${s.why}` : ""}`);
    return [`${HEADINGS[kind]}\n${lines.join("\n")}`];
  });
  const corrections = listNotes(caller, opts).filter((n) => n.supersedes).slice(0, limit);
  if (corrections.length) {
    sections.push(`corrections (latest supersedes)\n${corrections.map((n) => `  ${formatLine(n)}\n         replaces ${n.supersedes}`).join("\n")}`);
  }
  return sections.length ? sections.join("\n\n") : "no outcome yet: after using a recalled note, orch mem outcome <id> useful|dead_end";
}
