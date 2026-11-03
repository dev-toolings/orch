// A bench's orch mem (ORCH_MEM_SANDBOX=<dir>): reads see the real memory,
// writes land in <dir> only. A note the sandbox supersedes or forgets is
// patched in <dir>/overrides.json and hidden from the sandbox's reads; the
// real store is never written. Benches set it for every configuration, so a
// learning case still writes and reads back what it learned.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemBackend } from "./backend.ts";
import { projectKey } from "../core/project.ts";
import { addNote, type Caller, closePairs, forgetNote, isActive, type Note, listNotes, readableScopes, recentNotes, searchNotes, showNote, supersedeNote } from "./mem.ts";

type Override = Pick<Note, "status" | "supersededBy" | "reason">;

// The Markdown store rooted at <dir>: operator and lead notes under state/,
// project notes under projects/<project>/mem.
export function filesAt(dir: string, opts: { cwd?: string } = {}): MemBackend {
  const at = { state: join(dir, "state"), projects: join(dir, "projects"), cwd: opts.cwd };
  return {
    add: async (input, caller) => addNote(input, caller, at),
    search: async (query, caller, opts = {}) => searchNotes(query, caller, { ...at, ...opts }),
    recent: async (caller, opts = {}) => recentNotes(caller, { ...at, ...opts }),
    inventory: async (caller, opts = {}) => {
      const scopes = readableScopes(caller, opts.scope);
      return { complete: true, scopes, projects: scopes.includes("project") ? [projectKey(at.cwd)] : [], notes: listNotes(caller, { ...at, ...opts, all: true }) };
    },
    review: async (caller, opts = {}) => closePairs(caller, { ...at, ...opts }),
    show: async (id, caller) => showNote(id, caller, at),
    supersede: async (id, input, caller) => supersedeNote(id, input, caller, at),
    forget: async (id, reason, caller) => forgetNote(id, reason, caller, at),
    close: async () => {},
  };
}

export function sandboxMem(real: MemBackend, dir: string): MemBackend {
  const local = filesAt(dir);
  const file = join(dir, "overrides.json");
  const overrides = (): Record<string, Override> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const override = (id: string, o: Override) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...overrides(), [id]: o }, null, 2)}\n`);
  };
  const patch = (n: Note): Note => ({ ...n, ...overrides()[n.id] });
  const visible = (notes: Note[], all?: boolean) => notes.map(patch).filter((n) => all || isActive(n));
  // the real store is asked for more, so hidden notes do not shorten the list
  const wider = (limit = 10) => limit + Object.keys(overrides()).length;
  const realNote = async (id: string, caller: Caller, verb: string): Promise<Note> => {
    const found = await real.show(id, caller);
    if (!found) throw new Error(`mem: no readable note ${id}`);
    const n = patch(found);
    if (!isActive(n)) throw new Error(`mem ${verb}: note ${id} is not active`);
    return n;
  };

  return {
    add: (input, caller) => local.add(input, caller),
    search: async (query, caller, opts = {}) =>
      [...await local.search(query, caller, opts), ...visible(await real.search(query, caller, { ...opts, limit: wider(opts.limit) }), opts.all)].slice(0, opts.limit ?? 10),
    recent: async (caller, opts = {}) =>
      [...await local.recent(caller, opts), ...visible(await real.recent(caller, { ...opts, limit: wider(opts.limit) }), opts.all)]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, opts.limit ?? 10),
    inventory: async (caller, opts = {}) => {
      const mine = await local.inventory(caller, opts);
      const theirs = await real.inventory(caller, opts);
      if (!mine.complete || !theirs.complete) throw new Error("mem inventory: source is incomplete");
      const localIds = new Set(mine.notes.map((n) => n.id));
      return {
        complete: true,
        scopes: [...new Set([...mine.scopes, ...theirs.scopes])],
        projects: [...new Set([...mine.projects, ...theirs.projects])],
        notes: [...mine.notes, ...theirs.notes.filter((n) => !localIds.has(n.id)).map(patch)],
      };
    },
    review: async (caller, opts = {}) =>
      [...await local.review(caller, opts), ...(await real.review(caller, opts)).filter((p) => isActive(patch(p.newer)) && isActive(patch(p.older)))].slice(0, opts.limit ?? 10),
    show: async (id, caller) => {
      const mine = await local.show(id, caller);
      if (mine) return mine;
      const theirs = await real.show(id, caller);
      return theirs && patch(theirs);
    },
    supersede: async (id, input, caller) => {
      if (await local.show(id, caller)) return local.supersede(id, input, caller);
      const old = await realNote(id, caller, "supersede");
      const replacement = await local.add({ body: input.body, scope: old.scope, tags: input.tags?.length ? input.tags : old.tags }, caller);
      override(id, { status: "superseded", supersededBy: replacement.id });
      return { ...replacement, supersedes: id };
    },
    forget: async (id, reason, caller) => {
      if (await local.show(id, caller)) return local.forget(id, reason, caller);
      const old = await realNote(id, caller, "forget");
      if (caller.lane) throw new Error("mem forget: workers never write memory, put it in the spec or the report");
      const o: Override = { status: "forgotten" };
      const why = reason.replace(/\s+/g, " ").trim();
      if (why) o.reason = why;
      override(id, o);
      return { ...old, ...o };
    },
    close: () => real.close(),
  };
}

// What a bench wrote, per sandbox: notes added and real notes patched.
export function sandboxSummary(dirs: Record<string, string>): string {
  const count = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md")).length : 0);
  const patched = (dir: string) => (existsSync(join(dir, "overrides.json")) ? Object.keys(JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8"))).length : 0);
  return Object.entries(dirs).map(([name, dir]) => `${name} ${count(dir)} écrite(s), ${patched(dir)} réelle(s) masquée(s)`).join(" ; ");
}
