// On-demand benchmark memory reads the same frozen corpus as automatic recall.
// The normal sandbox wrapper provides run-local writes over this read-only view.
import { readFileSync } from "node:fs";
import type { MemBackend } from "../mem/backend.ts";
import { readableScopes, type Caller, type Note, type Scope } from "../mem/mem.ts";
import { similar } from "../mem/similar.ts";
import { validateSnapshot } from "./brain-recall.ts";
import { embeddingText } from "./privacy.ts";

export function snapshotMem(file: string, opts: { includeTranscripts?: boolean; embedQuery?: (query: string) => Promise<number[]> } = {}): MemBackend {
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  validateSnapshot(data);
  const snapshotSpace = data.space;
  const notes: Note[] = data.memories.filter((m) => opts.includeTranscripts || m.source === "orch-mem").map((m) => ({
    id: m.source === "orch-mem" ? m.source_ref : `transcript:${m.source_ref}`,
    scope: m.scope as Scope, project: m.project ?? undefined, harness: m.harness ?? "unknown", session: "snapshot",
    date: new Date(m.occurred_at).toISOString(), tags: m.tags ?? [], body: m.body,
  })).sort((a, b) => b.date.localeCompare(a.date));
  const visible = (caller: Caller, scope?: Scope) => notes.filter((n) => readableScopes(caller, scope).includes(n.scope));
  const readonly = async (): Promise<never> => { throw new Error("snapshot memory is read-only; writes need a benchmark sandbox"); };
  return {
    add: readonly, supersede: readonly, forget: readonly,
    recent: async (caller, opts = {}) => visible(caller, opts.scope).slice(0, opts.limit ?? 10),
    search: async (query, caller, opts = {}) => {
      const candidates = visible(caller, opts.scope);
      if (!candidates.length || !query.trim()) return [];
      try {
        if (!data.memories.some((m) => m.embedding !== null && candidates.some((n) => n.id === (m.source === "orch-mem" ? m.source_ref : `transcript:${m.source_ref}`)))) throw new Error("no matching snapshot vectors");
        const vector = await queryVector(query);
        if (vector.length !== data.dimensions || !vector.every(Number.isFinite) || !Math.hypot(...vector)) throw new Error("invalid embedding");
        const ids = new Set(candidates.map((n) => n.id));
        return data.memories.map((m) => ({ m, id: m.source === "orch-mem" ? m.source_ref : `transcript:${m.source_ref}` }))
          .filter((m) => ids.has(m.id))
          .filter(({ m }) => m.embedding !== null)
          .map(({ m, id }) => ({ id, score: m.embedding!.reduce((s, n, i) => s + n * vector[i], 0) / (Math.hypot(...m.embedding!) * Math.hypot(...vector)) }))
          .sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10).map((m) => candidates.find((n) => n.id === m.id)!);
      } catch {
        console.error("mem: snapshot vector recall unavailable, text only");
      }
      const words = query.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (!words.length) return [];
      return visible(caller, opts.scope).map((n) => ({ n, score: words.filter((w) => `${n.body} ${n.tags.join(" ")}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().includes(w)).length }))
        .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10).map((r) => r.n);
    },
    inventory: async (caller, opts = {}) => ({ complete: true, scopes: readableScopes(caller, opts.scope), projects: [data.project], notes: visible(caller, opts.scope) }),
    show: async (id, caller) => visible(caller).find((n) => n.id === id),
    review: async (caller, opts = {}) => {
      const list = visible(caller, opts.scope);
      return list.flatMap((newer, i) => similar(newer.body, list.slice(i + 1), (n) => n.body).map((m) => ({ newer, older: m.item, score: m.score })))
        .sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
    },
    close: async () => {},
  };

  async function queryVector(query: string): Promise<number[]> {
    const text = embeddingText(query);
    if (opts.embedQuery) return opts.embedQuery(text);
    const { embed } = await import("../llm/llm.ts");
    const result = await embed([text], "query", { timeoutMs: 3500 });
    if (result.space !== snapshotSpace) throw new Error("snapshot embedding space mismatch");
    return result.vectors[0];
  }
}
