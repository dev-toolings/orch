// Embedding-only hook adapter. A supplied snapshot is authoritative: it never
// falls back to the live database, and hook reads use the read-only role.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../brain/db.ts";
import { loadBrainConfig, openDomain } from "../brain/db.ts";
import type { Memory } from "../brain/store.ts";
import { searchMemories } from "../brain/store.ts";
import { activeSpace, embed, loadConfig } from "../llm/llm.ts";
import type { MemoryDeps } from "../hooks/hook.ts";
import { formatRecall, type RecallHit } from "./hindsight.ts";
import { embeddingText } from "./privacy.ts";

export interface BrainSnapshot {
  schema_version: 1;
  space: string;
  dimensions: number;
  project: string;
  memories: Array<Memory & { embedding: number[] | null }>;
}

export async function writeBrainSnapshot(db: Db, file: string, opts: { space: string; dimensions: number; project: string; scopes?: string[] }): Promise<void> {
  const rows = await db.query<Memory & { embedding: string | number[] | null }>(
    `SELECT *, embedding::text AS embedding FROM memories WHERE superseded_by IS NULL AND forgotten_at IS NULL
     AND source = ANY($1) AND scope = ANY($2) AND (scope <> 'project' OR project = $3)
     ORDER BY id`,
    [["orch-mem", "claude-transcript"], opts.scopes ?? ["operator", "lead", "project"], opts.project]);
  const snapshot: BrainSnapshot = { schema_version: 1, ...opts, memories: rows.map((m) => ({ ...m,
    embedding: m.embed_space !== opts.space ? null : typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding })) };
  validateSnapshot(snapshot);
  writeFileSync(file, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
}

export function validateSnapshot(value: unknown): asserts value is BrainSnapshot {
  const s = value as BrainSnapshot | null;
  if (!s || s.schema_version !== 1 || !s.space || !Number.isSafeInteger(s.dimensions) || s.dimensions < 1 || !s.project || !Array.isArray(s.memories)) throw new Error("brain recall: invalid snapshot");
  for (const m of s.memories) {
    if (!m.id || !m.source_ref || typeof m.body !== "string" || !["orch-mem", "claude-transcript"].includes(m.source)
      || !["operator", "lead", "project"].includes(m.scope) || (m.scope === "project" && m.project !== s.project)
      || m.superseded_by || m.forgotten_at || (m.embedding !== null && (m.embed_space !== s.space || !validVector(m.embedding, s.dimensions)))) throw new Error("brain recall: invalid snapshot memory");
  }
}

const validVector = (v: unknown, dims: number): v is number[] => Array.isArray(v) && v.length === dims && v.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.hypot(...v) > 0;
const cosine = (a: number[], b: number[]) => a.reduce((n, v, i) => n + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

export function snapshotRecall(snapshot: BrainSnapshot, vector: number[], project: string, projectOnly: boolean, limit = 24): RecallHit[] {
  validateSnapshot(snapshot);
  if (snapshot.project !== project) throw new Error("brain recall: snapshot project mismatch");
  if (!validVector(vector, snapshot.dimensions)) throw new Error("brain recall: embedding dimensions mismatch");
  return snapshot.memories.filter((m) => m.embedding !== null && (projectOnly ? m.scope === "project" && m.project === project : m.scope !== "project"))
    .map((m) => ({ m, score: cosine(vector, m.embedding!) })).sort((a, b) => b.score - a.score)
    .slice(0, limit).map(({ m, score }) => hit(m, score));
}

function hit(m: Memory, score: number): RecallHit {
  return { id: m.id, type: m.source === "orch-mem" ? "world" : "experience",
    text: `[${m.source}:${m.source_ref}] ${m.body}`, mentioned_at: new Date(m.occurred_at).toISOString(), scores: { final: score, semantic: score } };
}

export function brainMemoryDeps(env: NodeJS.ProcessEnv = process.env, injected?: {
  space: string; dimensions: number; embed: (text: string) => Promise<number[]>; open?: () => Db;
}): MemoryDeps {
  const c = loadBrainConfig(env.ORCH_BRAIN_CONFIG);
  const space = injected?.space ?? activeSpace();
  const dimensions = injected?.dimensions ?? loadConfig().dimensions;
  const queries = new Map<string, Promise<number[]>>();
  const config = { ...c.hindsight, retain: false };
  const vectorFor = (text: string) => {
    const cleaned = embeddingText(text);
    let pending = queries.get(cleaned);
    if (!pending) {
      pending = injected ? injected.embed(cleaned) : embed([cleaned], "query", { timeoutMs: Math.min(c.hindsight.timeout_ms, 3500) }).then((r) => {
        if (r.space !== space) throw new Error("brain recall: embedding space changed");
        return r.vectors[0];
      });
      queries.set(cleaned, pending);
    }
    return pending;
  };
  return {
    config: () => config,
    format: (hits, max) => formatRecall(hits, max, { source: "brain", trust: "untrusted" }),
    retain: async () => ({ ok: true, value: { items_count: 0 } }),
    recall: async (_config, query, options) => {
      try {
        if (env.ORCH_LANE === "1" || env.ORCH_MEMORY === "off") return { ok: true, value: [] };
        const bank = options?.bank ?? config.bank;
        const projectOnly = bank !== config.bank;
        const project = projectOnly ? bank.slice(config.bank.length + 1) : (env.ORCH_BRAIN_PROJECT ?? "");
        const file = env.ORCH_BRAIN_SNAPSHOT;
        let snapshot: BrainSnapshot | undefined;
        if (file) {
          if (!existsSync(file)) throw new Error("brain recall: snapshot unavailable");
          const value: unknown = JSON.parse(readFileSync(file, "utf8")); validateSnapshot(value); snapshot = value;
          if (snapshot.space !== space || snapshot.dimensions !== dimensions) throw new Error("brain recall: snapshot embedding space mismatch");
        } else if (env.ORCH_BENCH_RUN) throw new Error("brain recall: benchmarks require a snapshot");
        if (snapshot) {
          const selectedProject = project || snapshot.project;
          if (snapshot.project !== selectedProject) throw new Error("brain recall: snapshot project mismatch");
          if (!snapshot.memories.some((m) => m.embedding !== null && (projectOnly ? m.scope === "project" : m.scope !== "project"))) return { ok: true, value: [] };
          const vector = await vectorFor(query);
          return { ok: true, value: snapshotRecall(snapshot, vector, selectedProject, projectOnly) };
        }
        const db = injected?.open?.() ?? openDomain(c, "projets", "ro");
        try {
          await db.exec("SET statement_timeout = '1500ms'");
          const available = await db.query(`SELECT 1 FROM memories WHERE superseded_by IS NULL AND forgotten_at IS NULL
            AND source = ANY($1) AND scope = ANY($2) AND (scope <> 'project' OR project = $3)
            AND embed_space = $4 AND embedding IS NOT NULL LIMIT 1`,
          [["orch-mem", "claude-transcript"], projectOnly ? ["project"] : ["operator", "lead"], projectOnly ? project : null, space]);
          if (!available.length) return { ok: true, value: [] };
          const vector = await vectorFor(query);
          if (!validVector(vector, dimensions)) throw new Error("brain recall: invalid query vector");
          const rows = await searchMemories(db, query, { vector, space, scopes: projectOnly ? ["project"] : ["operator", "lead"], project: projectOnly ? project : undefined, sources: ["orch-mem", "claude-transcript"], limit: 24 });
          return { ok: true, value: rows.map((r) => hit(r.memory, r.score)) };
        } finally { await db.close(); }
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 180);
        return { ok: false, error: `brain recall unavailable (embedding or store failure): ${detail}` };
      }
    },
  };
}
