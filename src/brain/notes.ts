// orch mem on the memory brain: notes are memories of source `orch-mem` in
// the projets database, keyed by the same note ids as the Markdown files, so
// ids the lead already knows keep working after the switch. Scope rules are
// the files' rules; project notes belong to one repository.
import type { MemBackend, Pair } from "../mem/backend.ts";
import { type Caller, isActive, type Note, noteId, projectKey, readableScopes, type Scope } from "../mem/mem.ts";
import { similar } from "../mem/similar.ts";
import { type BrainConfig, type Db, openDomain } from "./db.ts";
import { NOTE_SOURCE } from "./import.ts";
import { addMemory, countUnembedded, embedText, findBySource, forgetMemory, getMemory, hasVectors, type Memory, recentMemories, searchMemories, setEmbedding, supersedeMemory } from "./store.ts";

export const MEM_DOMAIN = "projets";

export interface BrainMemOpts {
  project: string;
  // Recall by meaning when given: the active embedding space, a query
  // embedder and a document embedder (a note gets its vector as it is
  // written). A failing query embedder degrades to text search with a warning.
  space?: string;
  embedQuery?: (text: string) => Promise<number[]>;
  embedDocument?: (text: string) => Promise<number[]>;
  warn?: (message: string) => void;
  now?: () => Date;
}

function writable(caller: Caller, verb: string, scope?: Scope) {
  if (caller.lane) throw new Error(`mem ${verb}: workers never write memory, put it in the spec or the report`);
  if (scope === "lead" && !caller.lead) throw new Error(`mem ${verb}: the lead scope is written by lead sessions only`);
}

// The CLI's brain backend: read-write on projets, recall by meaning through
// the active embed provider, warnings on stderr.
export async function openBrainMem(c: BrainConfig): Promise<MemBackend> {
  const { activeSpace, embed } = await import("../llm/llm.ts");
  return brainMem(openDomain(c, MEM_DOMAIN, "rw"), {
    project: projectKey(),
    space: activeSpace(),
    embedQuery: async (text) => (await embed([text], "query")).vectors[0],
    embedDocument: async (text) => (await embed([text], "document")).vectors[0],
    warn: (m) => console.error(m),
  });
}

export function brainMem(db: Db, o: BrainMemOpts): MemBackend {
  const now = o.now ?? (() => new Date());
  const filter = (caller: Caller, scope?: Scope, all?: boolean) =>
    ({ source: NOTE_SOURCE, scopes: readableScopes(caller, scope), project: o.project, all });

  // Note ids of the linked memories, which store uuids.
  async function toNotes(rows: Memory[]): Promise<Note[]> {
    const linked = [...new Set(rows.flatMap((m) => [m.supersedes, m.superseded_by]).filter((x): x is string => !!x))];
    const refs = new Map((linked.length
      ? await db.query<{ id: string; source_ref: string }>("SELECT id, source_ref FROM memories WHERE id = ANY($1)", [linked])
      : []).map((r) => [r.id, r.source_ref]));
    return rows.map((m) => {
      const n: Note = {
        id: m.source_ref, scope: m.scope as Scope, harness: m.harness ?? "unknown", session: "",
        date: new Date(m.occurred_at).toISOString(), tags: m.tags ?? [], body: m.body,
      };
      if (m.scope === "project" && m.project) n.project = m.project;
      if (m.forgotten_at) n.status = "forgotten";
      else if (m.superseded_by) n.status = "superseded";
      if (m.supersedes) n.supersedes = refs.get(m.supersedes);
      if (m.superseded_by) n.supersededBy = refs.get(m.superseded_by);
      if (m.forgotten_reason) n.reason = m.forgotten_reason;
      return n;
    });
  }

  async function find(id: string, caller: Caller): Promise<Memory | undefined> {
    const m = await findBySource(db, NOTE_SOURCE, id);
    if (!m || !readableScopes(caller).includes(m.scope as Scope) || (m.scope === "project" && m.project !== o.project)) return undefined;
    return m;
  }

  async function readable(id: string, caller: Caller): Promise<Memory> {
    const m = await find(id, caller);
    if (!m) throw new Error(`mem: no readable note ${id}`);
    return m;
  }

  // Same second, same first line: suffixed like the files are.
  async function insertNote(body: string, insert: (id: string) => Promise<string>): Promise<Memory> {
    const base = noteId(body, now());
    for (let suffix = 1; ; suffix++) {
      const id = suffix === 1 ? base : `${base}-${suffix}`;
      let uuid: string;
      try {
        uuid = await insert(id);
      } catch (e) {
        const error = e as { code?: string; errno?: string; constraint?: string };
        if ((error.code === "23505" || error.errno === "23505") &&
            (error.constraint === "memories_note_identity" || error.constraint === "memories_content_hash_key")) continue;
        throw e;
      }
      return (await getMemory(db, uuid))!;
    }
  }

  async function queryVector(query: string): Promise<number[] | undefined> {
    if (!o.space || !o.embedQuery || !(await hasVectors(db, o.space))) return undefined;
    try {
      return await o.embedQuery(query);
    } catch (e) {
      o.warn?.(`mem: vector recall skipped, text only: ${(e as Error).message}`);
      return undefined;
    }
  }

  // Written notes are embedded at once; when the provider fails the note is
  // kept without a vector and `orch brain embed` (routine brain-embed) fills it.
  async function vectorize(m: Memory) {
    if (!o.space || !o.embedDocument) return;
    try {
      await setEmbedding(db, m.id, await o.embedDocument(embedText(m)), o.space);
    } catch (e) {
      o.warn?.(`mem: note saved without vector (${(e as Error).message}); orch brain embed fills it`);
    }
  }

  async function warnUnembedded(caller: Caller, scope?: Scope) {
    const n = await countUnembedded(db, o.space!, filter(caller, scope));
    if (n) o.warn?.(`mem: ${n} note${n > 1 ? "s" : ""} without a vector ${n > 1 ? "are" : "is"} not searched by meaning: orch brain embed`);
  }

  return {
    async add(input, caller) {
      writable(caller, "add", input.scope);
      const body = input.body.trim();
      if (!body) throw new Error("mem add: empty note");
      const saved = await insertNote(body, async (id) => (await addMemory(db, {
        source: NOTE_SOURCE, source_ref: id, scope: input.scope, project: input.scope === "project" ? o.project : undefined,
        body, tags: input.tags ?? [], harness: caller.harness, occurred_at: now(),
      }, { deduplicate: false })).id);
      await vectorize(saved);
      return (await toNotes([saved]))[0];
    },
    async search(query, caller, opts = {}) {
      const vector = await queryVector(query);
      if (vector) await warnUnembedded(caller, opts.scope);
      const hits = await searchMemories(db, query, { ...filter(caller, opts.scope, opts.all), limit: opts.limit ?? 10, vector, space: o.space });
      return toNotes(hits.map((h) => h.memory));
    },
    async recent(caller, opts = {}) {
      return toNotes(await recentMemories(db, { ...filter(caller, opts.scope, opts.all), limit: opts.limit ?? 10 }));
    },
    async inventory(caller, opts = {}) {
      const scopes = readableScopes(caller, opts.scope);
      const rows = await db.query<Memory>(
        `SELECT id, source, source_ref, scope, project, title, body, tags, harness, occurred_at, supersedes, superseded_by, forgotten_at, forgotten_reason, embed_space
         FROM memories
         WHERE source = $1 AND scope = ANY($2) AND (scope <> 'project' OR project = $3)
         ORDER BY occurred_at DESC, created_at DESC`,
        [NOTE_SOURCE, scopes, o.project],
      );
      return { complete: true as const, scopes, projects: scopes.includes("project") ? [o.project] : [], notes: await toNotes(rows) };
    },
    async review(caller, opts = {}) {
      const notes = (await toNotes(await recentMemories(db, { ...filter(caller, opts.scope), limit: 100_000 }))).reverse();
      const pairs: Pair[] = notes.flatMap((newer, i) => similar(newer.body, notes.slice(0, i), (n) => n.body).map((m) => ({ newer, older: m.item, score: m.score })));
      return pairs.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
    },
    async show(id, caller) {
      const m = await find(id, caller);
      return m ? (await toNotes([m]))[0] : undefined;
    },
    async supersede(id, input, caller) {
      writable(caller, "supersede");
      const old = await readable(id, caller);
      if (!isActive((await toNotes([old]))[0])) throw new Error(`mem supersede: note ${id} is not active`);
      const body = input.body.trim();
      if (!body) throw new Error("mem supersede: empty note");
      const saved = await insertNote(body, (newId) => supersedeMemory(db, old.id, {
        source: NOTE_SOURCE, source_ref: newId, scope: old.scope, project: old.project ?? undefined, body,
        // no tags given: keep the old note's, so a correction stays as findable
        tags: input.tags?.length ? input.tags : old.tags, harness: caller.harness, occurred_at: now(),
      }));
      await vectorize(saved);
      return (await toNotes([saved]))[0];
    },
    async forget(id, reason, caller) {
      writable(caller, "forget");
      const old = await readable(id, caller);
      if (old.forgotten_at || old.superseded_by) throw new Error(`mem forget: note ${id} is not active`);
      await forgetMemory(db, old.id, reason.replace(/\s+/g, " ").trim());
      return (await toNotes([(await findBySource(db, NOTE_SOURCE, id))!]))[0];
    },
    close: () => db.close(),
  };
}
