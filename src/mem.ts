// mem: the lead's memory across sessions and harnesses, as Markdown notes on
// disk. Recall is on demand (search, recent, show) so the lead prompt stays a
// stable cached prefix. No model call, no index: notes are read on demand.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "./git.ts";
import { stateDir } from "./paths.ts";

export type Scope = "operator" | "project" | "lead";
export const SCOPES: Scope[] = ["operator", "project", "lead"];
type NoteStatus = "active" | "superseded" | "forgotten";

export interface Note {
  id: string;
  scope: Scope;
  harness: string;
  session: string;
  date: string;
  tags: string[];
  body: string;
  status?: NoteStatus;
  supersedes?: string;
  supersededBy?: string;
  reason?: string;
  warning?: string;
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
// in the main worktree so they travel with it across linked worktrees.
export function scopeDir(scope: Scope, opts: { state?: string; cwd?: string } = {}): string {
  const state = opts.state ?? stateDir();
  if (scope === "project") return join(repoRoot(opts.cwd ?? process.cwd()), ".orch", "mem");
  return join(state, "mem", scope);
}

function repoRoot(cwd: string): string {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const commonDir = common.ok ? common.out : "";
  if (commonDir && basename(commonDir) === ".git") return dirname(commonDir);
  const root = git(cwd, "rev-parse", "--show-toplevel");
  return root.ok ? root.out : cwd;
}

// Scopes a caller may read: the lead scope is private to lead sessions.
export function readableScopes(caller: Caller, only?: Scope): Scope[] {
  const all = caller.lead ? SCOPES : SCOPES.filter((s) => s !== "lead");
  return only ? all.filter((s) => s === only) : all;
}

const slug = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note";
const PROJECT_IGNORE_WARNING = "note: .orch/mem is gitignored in this repository, project notes stay local";

function projectWarning(scope: Scope, id: string, opts: { cwd?: string }): string | undefined {
  if (scope !== "project") return undefined;
  const root = repoRoot(opts.cwd ?? process.cwd());
  const ignored = git(root, "check-ignore", "-q", `.orch/mem/${id}.md`);
  return ignored.ok ? PROJECT_IGNORE_WARNING : undefined;
}

function isActive(note: Note): boolean {
  return !note.status || note.status === "active";
}

function saveNote(note: Note, opts: { state?: string; cwd?: string }): Note {
  const dir = scopeDir(note.scope, opts);
  mkdirSync(dir, { recursive: true });
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? note : { ...note, id: `${note.id}-${suffix}` };
    try {
      writeFileSync(join(dir, `${candidate.id}.md`), render(candidate), { flag: "wx" });
      const warning = projectWarning(candidate.scope, candidate.id, opts);
      return warning ? { ...candidate, warning } : candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function noteFrom(body: string, scope: Scope, tags: string[], caller: Caller, now: Date, extra: Partial<Note> = {}): Note {
  return {
    id: `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${slug(body.split("\n")[0])}`,
    scope,
    harness: caller.harness,
    session: caller.session,
    date: now.toISOString(),
    tags,
    body,
    ...extra,
  };
}

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
  return saveNote(noteFrom(body, input.scope, input.tags ?? [], caller, now), opts);
}

function render(n: Note): string {
  const head = [`id: ${n.id}`, `scope: ${n.scope}`, `harness: ${n.harness}`, `session: ${n.session}`, `date: ${n.date}`, `tags: ${n.tags.join(", ")}`];
  if (n.status) head.push(`status: ${n.status}`);
  if (n.supersedes) head.push(`supersedes: ${n.supersedes}`);
  if (n.supersededBy) head.push(`superseded_by: ${n.supersededBy}`);
  if (n.reason) head.push(`reason: ${n.reason}`);
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
  const note: Note = {
    id: f.id,
    scope: f.scope as Scope,
    harness: f.harness ?? "unknown",
    session: f.session ?? "",
    date: f.date ?? "",
    tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    body: m[2].trimEnd(),
  };
  if (f.status && ["active", "superseded", "forgotten"].includes(f.status)) note.status = f.status as NoteStatus;
  if (f.supersedes) note.supersedes = f.supersedes;
  if (f.superseded_by) note.supersededBy = f.superseded_by;
  if (f.reason) note.reason = f.reason;
  return note;
}

export function listNotes(caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope; all?: boolean } = {}): Note[] {
  const notes: Note[] = [];
  for (const s of readableScopes(caller, opts.scope)) {
    const dir = scopeDir(s, opts);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const n = parse(readFileSync(join(dir, f), "utf8"));
      if (n && (opts.all || isActive(n))) notes.push(n);
    }
  }
  return notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function tokenize(value: string): string[] {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function matches(queryToken: string, noteToken: string): boolean {
  return queryToken === noteToken || (queryToken.length >= 4 && noteToken.startsWith(queryToken));
}

// Rank note tokens with BM25, then recency.
export function searchNotes(query: string, caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope; limit?: number; all?: boolean } = {}): Note[] {
  const words = [...new Set(tokenize(query))];
  if (!words.length) return [];
  const notes = listNotes(caller, opts);
  if (!notes.length) return [];
  const documents = notes.map((n) => ({ n, tokens: tokenize(`${n.body}\n${n.tags.join(" ")}`) }));
  const averageLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / documents.length;
  const df = new Map(words.map((w) => [w, documents.filter((d) => d.tokens.some((t) => matches(w, t))).length]));
  const scored = documents.map((doc) => {
    let score = 0;
    for (const word of words) {
      const matching = df.get(word)!;
      if (!matching) continue;
      const termFrequency = doc.tokens.filter((token) => matches(word, token)).length;
      if (!termFrequency) continue;
      const idf = Math.log(1 + (documents.length - matching + 0.5) / (matching + 0.5));
      const lengthNorm = 1 - 0.75 + 0.75 * (doc.tokens.length / averageLength);
      score += idf * ((termFrequency * (1.2 + 1)) / (termFrequency + 1.2 * lengthNorm));
    }
    return { n: doc.n, score };
  });
  const ranked = scored.filter((x) => x.score > 0);
  ranked.sort((a, b) => b.score - a.score || (a.n.date < b.n.date ? 1 : a.n.date > b.n.date ? -1 : 0));
  return ranked.slice(0, opts.limit ?? 10).map((x) => x.n);
}

export function recentNotes(caller: Caller, opts: { state?: string; cwd?: string; scope?: Scope; limit?: number; all?: boolean } = {}): Note[] {
  return listNotes(caller, opts).slice(0, opts.limit ?? 10);
}

export function showNote(id: string, caller: Caller, opts: { state?: string; cwd?: string } = {}): Note | undefined {
  return listNotes(caller, { ...opts, all: true }).find((n) => n.id === id);
}

function findNote(id: string, caller: Caller, opts: { state?: string; cwd?: string }): Note {
  const note = listNotes(caller, { ...opts, all: true }).find((n) => n.id === id);
  if (!note) throw new Error(`mem: no readable note ${id}`);
  return note;
}

export function supersedeNote(
  oldId: string,
  input: { body: string; tags?: string[] },
  caller: Caller,
  opts: { state?: string; cwd?: string; now?: Date } = {},
): Note {
  if (caller.lane) throw new Error("mem supersede: workers never write memory, put it in the spec or the report");
  const old = findNote(oldId, caller, opts);
  if (!isActive(old)) throw new Error(`mem supersede: note ${oldId} is not active`);
  const body = input.body.trim();
  if (!body) throw new Error("mem supersede: empty note");
  const now = opts.now ?? new Date();
  const replacement = saveNote(noteFrom(body, old.scope, input.tags ?? [], caller, now, { supersedes: old.id }), opts);
  const rewritten: Note = { ...old, status: "superseded", supersededBy: replacement.id };
  writeFileSync(join(scopeDir(old.scope, opts), `${old.id}.md`), render(rewritten));
  return replacement;
}

export function forgetNote(id: string, reason: string, caller: Caller, opts: { state?: string; cwd?: string } = {}): Note {
  if (caller.lane) throw new Error("mem forget: workers never write memory, put it in the spec or the report");
  const old = findNote(id, caller, opts);
  if (!isActive(old)) throw new Error(`mem forget: note ${id} is not active`);
  const rewritten: Note = { ...old, status: "forgotten" };
  const trimmedReason = reason.replace(/\s+/g, " ").trim(); // one frontmatter line
  if (trimmedReason) rewritten.reason = trimmedReason;
  writeFileSync(join(scopeDir(old.scope, opts), `${old.id}.md`), render(rewritten));
  return rewritten;
}

// One line per note: enough to decide whether to `show` it.
export function formatLine(n: Note): string {
  const first = n.body.split("\n")[0];
  const status = !isActive(n) ? (n.status === "superseded" ? ` [superseded by ${n.supersededBy ?? "unknown"}]` : " [forgotten]") : "";
  return `${n.id}  ${n.date.slice(0, 10)}  ${n.scope.padEnd(8)}  ${n.harness.padEnd(7)}  ${first.length > 80 ? `${first.slice(0, 77)}...` : first}${status}`;
}

export function formatNote(n: Note): string {
  const fields = [
    n.status ? `status: ${n.status}` : "",
    n.supersedes ? `supersedes: ${n.supersedes}` : "",
    n.supersededBy ? `superseded_by: ${n.supersededBy}` : "",
    n.reason ? `reason: ${n.reason}` : "",
  ].filter(Boolean);
  return `${formatLine(n)}\n${n.tags.length ? `tags: ${n.tags.join(", ")}\n` : ""}${fields.length ? `${fields.join("\n")}\n` : ""}\n${n.body}\n`;
}

export const MEM_USAGE =
  "usage: orch mem add [--scope operator|project|lead] [--tags a,b] <text|-> | search <words> [--scope s] [--limit n] [--all] | recent [--scope s] [--limit n] [--all] | show <id> | supersede <id> <text|-> | forget <id> [--reason text]";
