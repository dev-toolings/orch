import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type Db } from "../src/brain/db.ts";
import { ingestTranscripts, parseTranscript, splitTranscriptText } from "../src/memory/transcripts.ts";
import { embeddingText } from "../src/memory/privacy.ts";

let root: string, pg: PGlite, db: Db;
const axis = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
const record = (body: string, extra: object = {}) => JSON.stringify({ type: "user", uuid: "message-one", entrypoint: "cli", cwd: "/tmp/project-alpha", timestamp: "2026-10-29T00:00:00Z", message: { content: body }, ...extra });
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orch-transcripts-"));
  pg = new PGlite({ extensions: { vector } });
  db = { query: async <T>(s: string, p: unknown[] = []) => (await pg.query(s, p)).rows as T[], exec: async (s) => { await pg.exec(s); }, close: async () => {} };
  await migrate(db);
});
beforeEach(async () => { await db.exec("TRUNCATE memories"); });
afterAll(async () => { await pg.close(); rmSync(root, { recursive: true, force: true }); });

function world() {
  const dir = mkdtempSync(join(root, "world-")), projects = join(dir, "projects"), state = join(dir, "state");
  mkdirSync(join(projects, "fixture"), { recursive: true });
  const file = join(projects, "fixture", "session.jsonl");
  const calls: string[][] = [];
  const opts = { projects, state, space: "fake", dimensions: 1024, env: {}, allowPaid: true, allowProjects: ["project-alpha"], embed: async (texts: string[]) => { calls.push(texts); return texts.map(() => axis); } };
  return { file, opts, calls };
}

test("transcript parser bounds UTF-8 chunks, labels roles and waits for a complete record", () => {
  const raw = Buffer.from(record("🙂".repeat(400)) + "\n" + record("unfinished"));
  const parsed = parseTranscript(raw, "fixture");
  expect(parsed.complete).toBe(false);
  expect(parsed.completeBytes).toBe(Buffer.byteLength(record("🙂".repeat(400)) + "\n"));
  expect(parsed.chunks.length).toBeGreaterThan(1);
  expect(parsed.chunks.every((c) => c.project === "project-alpha" && c.role === "user" && c.body.includes("not a verified fact"))).toBe(true);
  expect(splitTranscriptText("🙂".repeat(400)).every((c) => Buffer.byteLength(c) <= 1200 && !c.includes("�"))).toBe(true);
  expect(() => parseTranscript(Buffer.from("broken\n"), "fixture")).toThrow("malformed");
});

test("transcript ingestion is replayable, scrubs embedding input, and supersedes rewrites including a reverted body", async () => {
  const w = world();
  writeFileSync(w.file, record("Contact demo@example.invalid /home/example/project") + "\n");
  expect((await ingestTranscripts(db, w.opts)).added).toBe(1);
  expect(w.calls[0][0]).not.toContain("demo@example.invalid");
  expect(w.calls[0][0]).toContain("[email]");
  expect((await ingestTranscripts(db, w.opts)).added).toBe(0);
  expect(w.calls.length).toBe(1);
  writeFileSync(w.file, record("Corrected decision") + "\n");
  expect((await ingestTranscripts(db, w.opts)).added).toBe(1);
  writeFileSync(w.file, record("Contact demo@example.invalid /home/example/project") + "\n");
  expect((await ingestTranscripts(db, w.opts)).added).toBe(1);
  const rows = await db.query<{ body: string }>("SELECT body FROM memories WHERE superseded_by IS NULL AND forgotten_at IS NULL");
  expect(rows).toHaveLength(1);
  expect(rows[0].body).toContain("[email]");
});

test("partial append and failed embeddings resume without duplicating chunks or losing old final messages", async () => {
  const w = world();
  writeFileSync(w.file, record("first") + "\n");
  await ingestTranscripts(db, w.opts);
  const second = record("second", { uuid: "message-two" });
  writeFileSync(w.file, record("first") + "\n" + second);
  expect((await ingestTranscripts(db, w.opts)).added).toBe(0);
  writeFileSync(w.file, record("first") + "\n" + second + "\n");
  await expect(ingestTranscripts(db, { ...w.opts, embed: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
  const recovered = await ingestTranscripts(db, w.opts);
  expect(recovered.added).toBe(0);
  expect(recovered.embedded).toBe(1);
  const rows = await db.query("SELECT id FROM memories WHERE superseded_by IS NULL AND forgotten_at IS NULL");
  expect(rows).toHaveLength(2);
  writeFileSync(w.file, record("first") + "\n");
  expect((await ingestTranscripts(db, w.opts)).forgotten).toBe(1);
});

test("headless transcripts and benchmark ingestion are excluded", async () => {
  expect(parseTranscript(Buffer.from(record("headless", { entrypoint: "sdk-cli" }) + "\n"), "x").chunks).toEqual([]);
  const w = world(); writeFileSync(w.file, record("interactive") + "\n");
  for (const env of [{ ORCH_LANE: "1" }, { ORCH_MEMORY: "off" }, { ORCH_BENCH_RUN: "fixture" }, { ORCH_MEM_SANDBOX: "fixture" }]) {
    await expect(ingestTranscripts(db, { ...w.opts, env })).rejects.toThrow("forbidden");
  }
  expect(w.calls).toHaveLength(0);
  expect(() => embeddingText("Bearer abcdef demo@example.invalid")).toThrow(/secret: rejected/);
});

test("assistant turns and secret-bearing user turns are dropped", () => {
  const assistant = JSON.stringify({ type: "assistant", uuid: "a1", entrypoint: "cli", cwd: "/tmp/project-alpha", timestamp: "2026-10-29T00:00:00Z", message: { content: "I will remember OPENAI_API_KEY=sk-secret" } });
  const secret = record("OPENAI_API_KEY=sk-secretvalue1234567890");
  expect(parseTranscript(Buffer.from(assistant + "\n" + secret + "\n"), "fixture").chunks).toEqual([]);
});

test("ingest_projects is deny-by-default and cannot be bypassed by the Claude projects dir", async () => {
  const w = world();
  writeFileSync(w.file, record("a durable routing decision") + "\n");
  expect((await ingestTranscripts(db, { ...w.opts, allowProjects: [] })).added).toBe(0);
  expect((await ingestTranscripts(db, { ...w.opts, allowProjects: ["compta"] })).added).toBe(0);
  expect((await ingestTranscripts(db, { ...w.opts, allowProjects: ["project-alpha"] })).added).toBe(1);
  expect(w.calls).toHaveLength(1);
});

test("ingestTranscripts itself requires --allow-paid unless dry-run, and batches embeddings", async () => {
  const w = world();
  writeFileSync(w.file, record("first durable decision") + "\n" + record("second durable decision", { uuid: "message-two" }) + "\n");
  await expect(ingestTranscripts(db, { ...w.opts, allowPaid: false })).rejects.toThrow("billable");
  const dry = await ingestTranscripts(db, { ...w.opts, allowPaid: false, dryRun: true });
  expect(dry.added).toBe(2);
  expect(w.calls).toHaveLength(0);
  expect(await db.query("SELECT id FROM memories")).toHaveLength(0);
  expect((await ingestTranscripts(db, w.opts)).embedded).toBe(2);
  expect(w.calls).toHaveLength(1);
  expect(w.calls[0]).toHaveLength(2);
});

test("max-chunks and max-usd bound an ingest run", async () => {
  const w = world();
  writeFileSync(w.file, record("first durable decision") + "\n" + record("second durable decision", { uuid: "message-two" }) + "\n");
  expect((await ingestTranscripts(db, { ...w.opts, maxChunks: 1 })).added).toBe(1);
  const limited = world();
  writeFileSync(limited.file, record("first durable decision") + "\n");
  expect((await ingestTranscripts(db, { ...limited.opts, maxUsd: 0 })).embedded).toBe(0);
});
