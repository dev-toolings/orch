import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type Db } from "../src/brain/db.ts";
import { addMemory, setEmbedding } from "../src/brain/store.ts";
import { brainMemoryDeps, snapshotRecall, writeBrainSnapshot, type BrainSnapshot } from "../src/memory/brain-recall.ts";
import { snapshotMem } from "../src/memory/snapshot-mem.ts";
let root: string, pg: PGlite, db: Db;
const axis = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orch-brain-recall-")); pg = new PGlite({ extensions: { vector } });
  db = { query: async <T>(s: string, p: unknown[] = []) => (await pg.query(s, p)).rows as T[], exec: async (s) => { await pg.exec(s); }, close: async () => {} };
  await migrate(db);
  for (const [scope, project, source, ref] of [["project", "alpha", "orch-mem", "alpha"], ["project", "beta", "orch-mem", "beta"], ["operator", undefined, "orch-mem", "operator"], ["project", "alpha", "private-source", "private"]] as const) {
    const m = await addMemory(db, { source, source_ref: ref, scope, project, body: `${ref} decision` });
    await setEmbedding(db, m.id, axis, "fake");
  }
});
afterAll(async () => { await pg.close(); rmSync(root, { recursive: true, force: true }); });

test("frozen snapshot exports only active allowed sources and the selected project, without overwrite", async () => {
  const file = join(root, "snapshot.json");
  await writeBrainSnapshot(db, file, { space: "fake", dimensions: 1024, project: "alpha" });
  const snapshot: BrainSnapshot = JSON.parse(readFileSync(file, "utf8"));
  expect(snapshot.memories.map((m) => m.source_ref).sort()).toEqual(["alpha", "operator"]);
  expect(snapshotRecall(snapshot, axis, "alpha", true).map((h) => h.text)).toEqual(["[orch-mem:alpha] alpha decision"]);
  expect(() => snapshotRecall(snapshot, axis, "beta", true)).toThrow("project mismatch");
  await expect(writeBrainSnapshot(db, file, { space: "fake", dimensions: 1024, project: "alpha" })).rejects.toThrow();
});

test("brain hook adapter caches one scrubbed embedding per prompt and never retains or opens a live DB for snapshots", async () => {
  const file = join(root, "adapter.json");
  await writeBrainSnapshot(db, file, { space: "fake", dimensions: 1024, project: "alpha" });
  const calls: string[] = [];
  const deps = brainMemoryDeps({ ORCH_BRAIN_SNAPSHOT: file, ORCH_BENCH_RUN: "fixture" }, { space: "fake", dimensions: 1024,
    embed: async (q) => { calls.push(q); return axis; }, open: () => { throw new Error("live DB forbidden"); } });
  const config = deps.config();
  const query = "demo@example.invalid decision";
  const [op, project] = await Promise.all([deps.recall(config, query, { bank: config.bank }), deps.recall(config, query, { bank: `${config.bank}-alpha` })]);
  expect(op.ok && op.value.map((h) => h.text)).toEqual(["[orch-mem:operator] operator decision"]);
  expect(project.ok && project.value).toHaveLength(1);
  expect(calls).toEqual(["[email] decision"]);
  expect(config.retain).toBe(false);
  expect(await deps.retain(config, [{ content: "unused" }])).toEqual({ ok: true, value: { items_count: 0 } });
});

test("a missing or incompatible snapshot fails open without falling back to production", async () => {
  const deps = brainMemoryDeps({ ORCH_BRAIN_SNAPSHOT: join(root, "missing.json"), ORCH_BENCH_RUN: "fixture" }, { space: "fake", dimensions: 1024, embed: async () => { throw new Error("must not embed"); } });
  expect((await deps.recall(deps.config(), "query")).ok).toBe(false);
  const file = join(root, "bad.json"); writeFileSync(file, JSON.stringify({ schema_version: 1, space: "wrong", dimensions: 1024, project: "alpha", memories: [] }));
  const bad = brainMemoryDeps({ ORCH_BRAIN_SNAPSHOT: file }, { space: "fake", dimensions: 1024, embed: async () => axis });
  expect((await bad.recall(bad.config(), "query")).ok).toBe(false);
});

test("on-demand benchmark memory uses frozen vectors and note identities, with no live store", async () => {
  const file = join(root, "on-demand.json");
  await writeBrainSnapshot(db, file, { space: "fake", dimensions: 1024, project: "alpha" });
  const calls: string[] = [];
  const store = snapshotMem(file, { embedQuery: async (q) => { calls.push(q); return axis; } });
  const caller = { lead: true, lane: false, harness: "claude", session: "fixture" };
  const hits = await store.search("demo@example.invalid query", caller, { scope: "project" });
  expect(hits.map((n) => n.id)).toEqual(["alpha"]);
  expect(calls).toEqual(["[email] query"]);
  expect((await store.inventory(caller)).projects).toEqual(["alpha"]);
  await expect(store.add({ scope: "project", body: "mutation" }, caller)).rejects.toThrow("read-only");
});

test("snapshot corpus retains unembedded notes so a C/D comparison cannot silently drop them", async () => {
  await addMemory(db, { source: "orch-mem", source_ref: "not-embedded", scope: "project", project: "alpha", body: "pending embedding decision" });
  const file = join(root, "pending.json");
  await writeBrainSnapshot(db, file, { space: "fake", dimensions: 1024, project: "alpha" });
  const snapshot: BrainSnapshot = JSON.parse(readFileSync(file, "utf8"));
  expect(snapshot.memories.find((m) => m.source_ref === "not-embedded")?.embedding).toBeNull();
  expect((await snapshotMem(file).inventory({ lead: true, lane: false, harness: "claude", session: "fixture" })).notes.map((n) => n.id)).toContain("not-embedded");
  expect(snapshotRecall(snapshot, axis, "alpha", true).some((h) => h.text.includes("pending embedding"))).toBe(false);
});
