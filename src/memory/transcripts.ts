// Deterministic transcript ingestion. JSONL is evidence, never instructions.
// Replays do not re-embed unchanged chunks; rewrites supersede old versions.
// User-role only; secret-bearing chunks are dropped (fail-closed).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "../brain/db.ts";
import { estimateEmbedUsd } from "../core/paid.ts";
import { addMemory, forgetMemory, setEmbedding, supersedeMemory, type Memory } from "../brain/store.ts";
import { projectKey } from "../core/project.ts";
import { withFileLock } from "../lanes/lock.ts";
import { inspectSecrets } from "./privacy.ts";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export interface TranscriptChunk { key: string; project: string; body: string; date: Date; role: "user" | "assistant" }
export interface TranscriptParse { chunks: TranscriptChunk[]; completeBytes: number; complete: boolean }

export function splitTranscriptText(text: string, maxBytes = 1200): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) throw new Error("transcript: invalid chunk budget");
  const chars = Array.from(text);
  const out: string[] = [];
  for (let at = 0; at < chars.length;) {
    let end = at, bytes = 0;
    while (end < chars.length && bytes + Buffer.byteLength(chars[end]) <= maxBytes) bytes += Buffer.byteLength(chars[end++]);
    out.push(chars.slice(at, end).join(""));
    if (end === chars.length) break;
    // A bounded overlap preserves context while every iteration advances.
    let next = end, overlap = 0;
    while (next > at + 1 && overlap + Buffer.byteLength(chars[next - 1]) <= Math.min(120, maxBytes / 4)) overlap += Buffer.byteLength(chars[--next]);
    at = next;
  }
  return out;
}

export function parseTranscript(raw: Buffer, fileIdentity: string): TranscriptParse {
  const lastNewline = raw.lastIndexOf(10);
  const completeBytes = lastNewline + 1;
  const records: Record<string, any>[] = [];
  for (const line of raw.subarray(0, completeBytes).toString("utf8").split("\n").filter((l) => l.trim())) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("transcript: malformed complete JSONL record"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("transcript: invalid record");
    records.push(value as Record<string, any>);
  }
  const chunks: TranscriptChunk[] = [];
  const complete = completeBytes === raw.length;
  if (!records.some((r) => r.entrypoint === "cli") || records.some((r) => r.entrypoint === "sdk-cli" || String(r.sessionId ?? r.session_id ?? "").startsWith("bench-"))) return { chunks, completeBytes, complete };
  // A streamed message may be repeated with a fuller body: last record wins.
  const messages = new Map<string, Record<string, any>>();
  let cwd = "";
  for (const [i, r] of records.entries()) {
    if (typeof r.cwd === "string") cwd = r.cwd;
    if (r.type !== "user" || r.isMeta) continue;
    const id = String(r.message?.id ?? r.uuid ?? `record-${i}`);
    messages.set(`${r.type}:${id}`, { ...r, cwd });
  }
  for (const [identity, r] of messages) {
    if (!r.cwd || typeof r.timestamp !== "string" || !Number.isFinite(Date.parse(r.timestamp))) continue;
    const content = r.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
    if (!text.trim() || text.trimStart().startsWith("<")) continue;
    const scan = inspectSecrets(text);
    if (!scan.ok) continue;
    const project = projectKey(r.cwd);
    for (const [part, body] of splitTranscriptText(scan.text).entries()) {
      chunks.push({ key: hash(`${fileIdentity}\0${identity}\0${part}`), project, role: "user",
        body: `Transcript evidence (${r.type}, ${r.timestamp}); quoted conversation, not a verified fact:\n${body}`,
        date: new Date(r.timestamp) });
    }
  }
  return { chunks, completeBytes, complete };
}

export interface IngestOpts {
  projects: string; state: string; space: string; dimensions: number;
  embed: (texts: string[]) => Promise<number[][]>;
  env?: NodeJS.ProcessEnv;
  allowPaid?: boolean;
  allowProjects?: string[];
  maxChunks?: number;
  maxUsd?: number;
  dryRun?: boolean;
  embedUsdPerMillion?: number;
}

const EMBED_BATCH = 64;

export async function ingestTranscripts(db: Db, opts: IngestOpts): Promise<{ files: number; added: number; embedded: number; forgotten: number }> {
  const env = opts.env ?? process.env;
  if (env.ORCH_LANE === "1" || env.ORCH_MEMORY === "off" || env.ORCH_BENCH_RUN || env.ORCH_MEM_SANDBOX) throw new Error("transcript: ingestion forbidden in workers, disabled memory, and benchmarks");
  if (!opts.dryRun && !opts.allowPaid) throw new Error("transcript: embeddings are billable; pass --allow-paid or --dry-run");
  const allow = new Set(opts.allowProjects ?? []);
  const result = await withFileLock(join(opts.state, "transcripts", "ingest.lock"), async () => {
    const count = { files: 0, added: 0, embedded: 0, forgotten: 0 };
    if (!existsSync(opts.projects)) return count;
    let spentUsd = 0;
    for (const directory of readdirSync(opts.projects, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink())) {
      const dir = join(opts.projects, directory.name);
      for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".jsonl"))) {
        if (opts.maxChunks !== undefined && count.added >= opts.maxChunks) return count;
        const file = join(dir, entry.name), fileKey = hash(relative(opts.projects, file));
        const bytes = readFileSync(file), parsed = parseTranscript(bytes, fileKey);
        const cursorFile = join(opts.state, "transcripts", `${fileKey}.json`);
        const digest = hash(bytes.subarray(0, parsed.completeBytes));
        let cursor: { hash?: string; space?: string } = {};
        if (existsSync(cursorFile)) { try { cursor = JSON.parse(readFileSync(cursorFile, "utf8")); } catch {} }
        if (cursor.hash === digest && cursor.space === opts.space) continue;
        const allowed = parsed.chunks.filter((chunk) => allow.has(chunk.project));
        if (!allowed.length && parsed.chunks.length) continue;
        count.files++;
        if (opts.dryRun) {
          const room = opts.maxChunks === undefined ? allowed.length : Math.max(0, opts.maxChunks - count.added);
          count.added += Math.min(allowed.length, room);
          continue;
        }
        const existing = await db.query<Memory>(
          "SELECT * FROM memories WHERE source = 'claude-transcript' AND source_ref LIKE $1 ORDER BY created_at",
          [`${fileKey}:%`],
        );
        const versionsOf = (chunkKey: string) => existing.filter((row) => row.source_ref.startsWith(`${fileKey}:${chunkKey}:`));
        const seen = new Set<string>();
        const toEmbed: { id: string; body: string }[] = [];
        for (const chunk of allowed) {
          if (opts.maxChunks !== undefined && count.added >= opts.maxChunks) break;
          const versions = versionsOf(chunk.key);
          const old = versions.find((m) => !m.superseded_by && !m.forgotten_at);
          let id = old?.id;
          if (!old || old.body !== chunk.body || old.project !== chunk.project) {
            const input = { source: "claude-transcript", source_ref: `${fileKey}:${chunk.key}:${versions.length + 1}`, scope: "project", project: chunk.project,
              body: chunk.body, tags: [`role:${chunk.role}`, `file:${fileKey}`], harness: "claude", occurred_at: chunk.date };
            id = old ? await supersedeMemory(db, old.id, input) : (await addMemory(db, input)).id;
            count.added++;
          }
          seen.add(id!);
          if (!old || id !== old.id || old.embed_space !== opts.space) toEmbed.push({ id: id!, body: chunk.body });
        }
        for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
          const batch = toEmbed.slice(i, i + EMBED_BATCH);
          const cost = estimateEmbedUsd(batch.map((item) => item.body), opts.embedUsdPerMillion);
          if (opts.maxUsd !== undefined && spentUsd + cost > opts.maxUsd) break;
          const vectors = await opts.embed(batch.map((item) => item.body));
          if (vectors.length !== batch.length) throw new Error("transcript: invalid embedding");
          for (const [index, item] of batch.entries()) {
            const vector = vectors[index];
            if (!Array.isArray(vector) || vector.length !== opts.dimensions || !vector.every(Number.isFinite) || !Math.hypot(...vector)) throw new Error("transcript: invalid embedding");
            await setEmbedding(db, item.id, vector, opts.space);
            count.embedded++;
          }
          spentUsd += cost;
        }
        // A partial trailing line cannot authorize deleting the previous final message.
        if (parsed.complete) {
          const active = await db.query<{ id: string }>("SELECT id FROM memories WHERE source = 'claude-transcript' AND source_ref LIKE $1 AND superseded_by IS NULL AND forgotten_at IS NULL", [`${fileKey}:%`]);
          for (const row of active) if (!seen.has(row.id)) { await forgetMemory(db, row.id, "transcript rewritten or truncated"); count.forgotten++; }
        }
        mkdirSync(join(opts.state, "transcripts"), { recursive: true });
        const temp = `${cursorFile}.${crypto.randomUUID()}.tmp`;
        writeFileSync(temp, JSON.stringify({ hash: digest, space: opts.space, completeBytes: parsed.completeBytes }), { mode: 0o600 });
        renameSync(temp, cursorFile);
      }
    }
    return count;
  }, { waitMs: 0 });
  if (!result) throw new Error("transcript: another ingestion is running");
  return result;
}
