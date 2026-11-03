// Memories of one domain database: add (idempotent), search (pgvector when
// the query has a vector, full text otherwise), supersede, forget,
// embeddings. Nothing is ever deleted.
import { createHash } from "node:crypto";
import { STOP } from "../mem/similar.ts";
import type { Db } from "./db.ts";

export interface Memory {
  id: string;
  source: string;
  source_ref: string;
  scope: string;
  project: string | null;
  title: string | null;
  body: string;
  tags: string[];
  harness: string | null;
  occurred_at: Date;
  supersedes: string | null;
  superseded_by: string | null;
  forgotten_at: Date | null;
  forgotten_reason: string | null;
  embed_space: string | null;
}

export interface AddInput {
  source: string;
  source_ref: string;
  body: string;
  scope?: string;
  project?: string;
  title?: string;
  tags?: string[];
  harness?: string;
  occurred_at?: Date;
}

const COLUMNS = "id, source, source_ref, scope, project, title, body, tags, harness, occurred_at, supersedes, superseded_by, forgotten_at, forgotten_reason, embed_space";
const ACTIVE = "superseded_by IS NULL AND forgotten_at IS NULL";

// Accent-free lower case: "modèle" and "modele" index and match alike.
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export const contentHash = (i: AddInput) => createHash("sha256").update(`${i.source}\0${i.source_ref}\0${i.body}`).digest("hex");

const ftsText = (i: AddInput) => fold([i.title ?? "", i.body, ...(i.tags ?? [])].join(" "));

// The same source, reference and text twice is one memory: an ingestion can
// be replayed after an interruption without duplicates.
export async function addMemory(db: Db, i: AddInput, opts: { supersedes?: string; deduplicate?: boolean } = {}): Promise<{ id: string; created: boolean }> {
  if (!i.body.trim()) throw new Error("brain: empty memory");
  const hash = contentHash(i);
  const rows = await db.query<{ id: string }>(
    `INSERT INTO memories (source, source_ref, scope, title, body, tags, harness, occurred_at, content_hash, supersedes, fts, project)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_tsvector('simple', $11), $12)
     ${opts.deduplicate === false ? "" : "ON CONFLICT (content_hash) DO NOTHING"} RETURNING id`,
    [i.source, i.source_ref, i.scope ?? "project", i.title ?? null, i.body, i.tags ?? [], i.harness ?? null,
      i.occurred_at ?? new Date(), hash, opts.supersedes ?? null, ftsText(i), i.project ?? null],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await db.query<{ id: string }>("SELECT id FROM memories WHERE content_hash = $1", [hash]);
  return { id: existing[0].id, created: false };
}

// One statement, so the new memory and the old one's link land together.
export async function supersedeMemory(db: Db, oldId: string, i: AddInput): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `WITH old AS (SELECT id FROM memories WHERE id = $10 AND ${ACTIVE}),
          n AS (INSERT INTO memories (source, source_ref, scope, title, body, tags, harness, occurred_at, content_hash, supersedes, fts, project)
                SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, id, to_tsvector('simple', $11), $12 FROM old RETURNING id)
     UPDATE memories SET superseded_by = (SELECT id FROM n) WHERE id = (SELECT id FROM old) AND EXISTS (SELECT 1 FROM n)
     RETURNING (SELECT id FROM n) AS id`,
    [i.source, i.source_ref, i.scope ?? "project", i.title ?? null, i.body, i.tags ?? [], i.harness ?? null,
      i.occurred_at ?? new Date(), contentHash(i), oldId, ftsText(i), i.project ?? null],
  );
  if (!rows[0]?.id) throw new Error(`brain: no active memory ${oldId} to supersede`);
  return rows[0].id;
}

export async function forgetMemory(db: Db, id: string, reason: string): Promise<void> {
  const rows = await db.query("UPDATE memories SET forgotten_at = now(), forgotten_reason = $2 WHERE id = $1 AND forgotten_at IS NULL RETURNING id", [id, reason || "no reason given"]);
  if (!rows.length) throw new Error(`brain: no memory ${id} to forget`);
}

export async function getMemory(db: Db, id: string): Promise<Memory | undefined> {
  return (await db.query<Memory>(`SELECT ${COLUMNS} FROM memories WHERE id = $1`, [id]))[0];
}

export async function findBySource(db: Db, source: string, ref: string): Promise<Memory | undefined> {
  return (await db.query<Memory>(`SELECT ${COLUMNS} FROM memories WHERE source = $1 AND source_ref = $2 ORDER BY created_at LIMIT 1`, [source, ref]))[0];
}

export async function countMemories(db: Db): Promise<{ total: number; active: number; unembedded: number }> {
  const [r] = await db.query<{ total: string | number; active: string | number; unembedded: string | number }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE ${ACTIVE}) AS active, count(*) FILTER (WHERE embedding IS NULL) AS unembedded FROM memories`,
  );
  return { total: Number(r.total), active: Number(r.active), unembedded: Number(r.unembedded) };
}

// Words become prefix terms joined by OR, so recall does not need every word;
// only letters and digits reach to_tsquery, and stop words (de, les, the) are
// dropped: as prefixes they match nearly every memory.
export function tsQuery(query: string): string | null {
  const words = [...new Set(fold(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)))].slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : null;
}

export interface Hit { memory: Memory; score: number; via: "text" | "vector" }

// Narrows a search: one source, some scopes, and project memories of one
// project only (memories of other scopes have no project).
export interface Filter { all?: boolean; source?: string; sources?: string[]; scopes?: string[]; project?: string }

function filterSql(f: Filter, params: unknown[]): string {
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = [f.all ? "TRUE" : ACTIVE];
  if (f.source) where.push(`source = ${p(f.source)}`);
  if (f.sources) where.push(`source = ANY(${p(f.sources)})`);
  if (f.scopes) where.push(`scope = ANY(${p(f.scopes)})`);
  if (f.project !== undefined) where.push(`(scope <> 'project' OR project = ${p(f.project)})`);
  return where.join(" AND ");
}

// With a query vector, recall is by meaning alone: the nearest memories of
// the query's embedding space, score = cosine similarity. Measured on
// 2026-10-24 with the `recall` cases of catalog/brain.yaml: 9 of 10 in the
// top 3, against 6 for the former fusion with the text ranking. Full text is
// the offline path: --text, restore-check, a query embedding that failed.
export async function searchMemories(db: Db, query: string, opts: Filter & { limit?: number; vector?: number[]; space?: string } = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 5;
  if (opts.vector && opts.space) {
    const params: unknown[] = [toVector(opts.vector), opts.space];
    const rows = await db.query<Memory & { distance: number }>(
      `SELECT ${COLUMNS}, embedding <=> $1::vector AS distance FROM memories
       WHERE ${filterSql(opts, params)} AND embedding IS NOT NULL AND embed_space = $2
       ORDER BY distance, occurred_at DESC LIMIT $${params.push(limit)}`, params);
    return rows.map(({ distance, ...memory }) => ({ memory, score: 1 - Number(distance), via: "vector" }));
  }
  const q = tsQuery(query);
  if (!q) return [];
  const params: unknown[] = [q];
  const rows = await db.query<Memory & { rank: number }>(
    `SELECT ${COLUMNS}, ts_rank_cd(fts, to_tsquery('simple', $1)) AS rank FROM memories
     WHERE ${filterSql(opts, params)} AND fts @@ to_tsquery('simple', $1)
     ORDER BY rank DESC, occurred_at DESC LIMIT $${params.push(limit)}`, params);
  return rows.map(({ rank, ...memory }) => ({ memory, score: Number(rank), via: "text" }));
}

// Memories recall by meaning cannot see: no vector of this space.
export async function countUnembedded(db: Db, space: string, f: Filter = {}): Promise<number> {
  const params: unknown[] = [space];
  const [r] = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM memories WHERE ${filterSql(f, params)} AND (embedding IS NULL OR embed_space IS DISTINCT FROM $1)`, params);
  return Number(r.n);
}

// The text a memory is embedded from, the same at write time and in batches.
export const embedText = (m: { title: string | null; body: string }) => (m.title ? `${m.title}\n${m.body}` : m.body);

export async function recentMemories(db: Db, opts: Filter & { limit?: number } = {}): Promise<Memory[]> {
  const params: unknown[] = [];
  const where = filterSql(opts, params);
  return db.query<Memory>(`SELECT ${COLUMNS} FROM memories WHERE ${where} ORDER BY occurred_at DESC, created_at DESC LIMIT $${params.push(opts.limit ?? 10)}`, params);
}

// Whether any memory has a vector of this space: no query vector is worth
// paying for otherwise.
export async function hasVectors(db: Db, space: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM memories WHERE embed_space = $1 AND embedding IS NOT NULL LIMIT 1", [space])).length > 0;
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;

// Memories whose vector is missing or from another space, oldest first.
export async function pendingEmbeddings(db: Db, space: string, limit = 64): Promise<{ id: string; text: string }[]> {
  const rows = await db.query<{ id: string; title: string | null; body: string }>(
    `SELECT id, title, body FROM memories WHERE embedding IS NULL OR embed_space IS DISTINCT FROM $1 ORDER BY created_at LIMIT $2`, [space, limit]);
  return rows.map((r) => ({ id: r.id, text: embedText(r) }));
}

export async function setEmbedding(db: Db, id: string, vector: number[], space: string): Promise<void> {
  await db.query("UPDATE memories SET embedding = $2::vector, embed_space = $3 WHERE id = $1", [id, toVector(vector), space]);
}

// Fills missing vectors in batches through `embed`; a failing batch stops the
// run with what was done so far kept, so a rerun resumes where it stopped.
export async function embedPending(db: Db, space: string, embed: (texts: string[]) => Promise<number[][]>, batch = 64): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await pendingEmbeddings(db, space, batch);
    if (!rows.length) return done;
    const vectors = await embed(rows.map((r) => r.text));
    if (vectors.length !== rows.length) throw new Error(`brain: ${vectors.length} vectors for ${rows.length} memories`);
    for (let i = 0; i < rows.length; i++) await setEmbedding(db, rows[i].id, vectors[i], space);
    done += rows.length;
  }
}
