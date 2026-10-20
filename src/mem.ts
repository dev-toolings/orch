// mem: the lead's memory across sessions and harnesses, as Markdown notes on
// disk. Recall is on demand (search, recent, show) so the lead prompt stays a
// stable cached prefix. No model call, no index: v1 is plain text matching.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Scope = "operator" | "project" | "lead";
export const SCOPES: Scope[] = ["operator", "project", "lead"];

export interface Note {
  id: string;
  scope: Scope;
  harness: string;
  session: string;
  date: string;
  tags: string[];
  body: string;
}

// Who is calling: `lead` sets ORCH_LEAD and ORCH_HARNESS at launch; lane sets
// ORCH_LANE in the worker environment.
export interface Caller {
  lead: boolean;
  lane: boolean;
  harness: string;
  session: string;
}

export function callerFromEnv(env: NodeJS.ProcessEnv = process.env): Caller {
  return {
    lead: env.ORCH_LEAD === "1",
    lane: env.ORCH_LANE === "1",
    harness: env.ORCH_HARNESS ?? "unknown",
    session: env.ORCH_SESSION ?? "",
  };
}

// operator and lead notes live under the orch state dir; project notes live
// in the repository so they travel with it.
export function scopeDir(scope: Scope, opts: { state?: string; cwd?: string } = {}): string {
  const state = opts.state ?? process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");
  if (scope === "project") return join(repoRoot(opts.cwd ?? process.cwd()), ".orch", "mem");
  return join(state, "mem", scope);
}

function repoRoot(cwd: string): string {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

// Scopes a caller may read: the lead scope is private to lead sessions.
export function readableScopes(caller: Caller, only?: Scope): Scope[] {
  const all = caller.lead ? SCOPES : SCOPES.filter((s) => s !== "lead");
  return only ? all.filter((s) => s === only) : all;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note";

export function addNote(
  input: { body: string; scope: Scope; tags?: string[] },
  caller: Caller,
  opts: { state?: string; cwd?: string; now?: Date } = {},
): Note {
  if (caller.lane) throw new Error("mem add: workers never write memory, put it in the spec or the report");
  if (input.scope === "lead" && !caller.lead) throw new Error("mem add: the lead scope is written by lead sessions only");
  const body = input.body.trim();
  if (!body) throw new Error("mem add: empty note");
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const note: Note = {
    id: `${stamp}-${slug(body.split("\n")[0])}`,
    scope: input.scope,
    harness: caller.harness,
    session: caller.session,
    date: now.toISOString(),
    tags: input.tags ?? [],
    body,
  };
  const dir = scopeDir(input.scope, opts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${note.id}.md`), render(note));
  return note;
}

function render(n: Note): string {
  const head = [`id: ${n.id}`, `scope: ${n.scope}`, `harness: ${n.harness}`, `session: ${n.session}`, `date: ${n.date}`, `tags: ${n.tags.join(", ")}`];
  return `---\n${head.join("\n")}\n---\n\n${n.body}\n`;
}

function parse(text: string): Note | null {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const f: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) f[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  if (!f.id || !SCOPES.includes(f.scope as Scope)) return null;
  return {
    id: f.id,
    scope: f.scope as Scope,
    harness: f.harness ?? "unknown",
    session: f.session ?? "",
    date: f.date ?? "",
    tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    body: m[2].trimEnd(),
  };
}

export function listNotes(caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope } = {}): Note[] {
  const notes: Note[] = [];
  for (const s of readableScopes(caller, opts.scope)) {
    const dir = scopeDir(s, opts);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const n = parse(readFileSync(join(dir, f), "utf8"));
      if (n) notes.push(n);
    }
  }
  return notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Rank by matched query words (body and tags), then recency.
export function searchNotes(query: string, caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope; limit?: number } = {}): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = listNotes(caller, opts)
    .map((n) => {
      const hay = `${n.body}\n${n.tags.join(" ")}`.toLowerCase();
      return { n, hits: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, opts.limit ?? 10).map((x) => x.n);
}

export function recentNotes(caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope; limit?: number } = {}): Note[] {
  return listNotes(caller, opts).slice(0, opts.limit ?? 10);
}

export function showNote(id: string, caller: Caller, opts: { state?: string; cwd?: string } = {}): Note | undefined {
  return listNotes(caller, opts).find((n) => n.id === id);
}

// One line per note: enough to decide whether to `show` it.
export function formatLine(n: Note): string {
  const first = n.body.split("\n")[0];
  return `${n.id}  ${n.date.slice(0, 10)}  ${n.scope.padEnd(8)}  ${n.harness.padEnd(7)}  ${first.length > 80 ? `${first.slice(0, 77)}...` : first}`;
}

export function formatNote(n: Note): string {
  return `${formatLine(n)}\n${n.tags.length ? `tags: ${n.tags.join(", ")}\n` : ""}\n${n.body}\n`;
}

export const MEM_USAGE =
  "usage: orch mem add [--scope operator|project|lead] [--tags a,b] <text|-> | search <words> [--scope s] [--limit n] | recent [--scope s] [--limit n] | show <id>";
