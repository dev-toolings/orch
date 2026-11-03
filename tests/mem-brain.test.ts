import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { type Db, migrate } from "../src/brain/db.ts";
import { importNotes } from "../src/brain/import.ts";
import { brainMem, type BrainMemOpts } from "../src/brain/notes.ts";
import { embedPending } from "../src/brain/store.ts";
import type { Caller, Note } from "../src/mem/mem.ts";

// orch mem's rules, on the brain backend (PGlite, no server, no model call).
let pg: PGlite;
let db: Db;
const lead = (harness: string): Caller => ({ lead: true, lane: false, harness, session: `${harness}-s1` });
const plain: Caller = { lead: false, lane: false, harness: "claude", session: "" };
const worker: Caller = { lead: false, lane: true, harness: "codex", session: "" };
const axis = (i: number) => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));

let clock = Date.parse("2026-10-24T08:00:00Z");
const mem = (o: Partial<BrainMemOpts> = {}) => brainMem(db, { project: "orch", now: () => new Date((clock += 60_000)), ...o });

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  db = { query: async <T>(t: string, p: unknown[] = []) => (await pg.query(t, p)).rows as T[], exec: async (t) => { await pg.exec(t); }, close: async () => {} };
  await migrate(db);
});
afterAll(() => pg.close());
beforeEach(async () => { await db.exec("TRUNCATE memories"); });

describe("orch mem on the brain", () => {
  test("a note saved by one harness is found from another, with its note id and provenance", async () => {
    const n = await mem().add({ body: "Export format: decided NDJSON, nonce k7q2", scope: "project", tags: ["export"] }, lead("codex"));
    expect(n.id).toMatch(/^\d{8}T\d{6}Z-export-format-decided-ndjson-nonce-k7q2$/);
    const hits = await mem().search("nonce k7q2", lead("grok"));
    expect(hits.map((h) => h.id)).toEqual([n.id]);
    expect(hits[0].harness).toBe("codex");
    expect((await mem().show(n.id, plain))?.tags).toEqual(["export"]);
  });

  test("the lead scope is private to lead sessions, and workers never write", async () => {
    await mem().add({ body: "lead doctrine", scope: "lead" }, lead("claude"));
    expect(await mem().search("doctrine", plain)).toEqual([]);
    expect((await mem().search("doctrine", lead("grok"))).length).toBe(1);
    await expect(mem().add({ body: "x", scope: "lead" }, plain)).rejects.toThrow(/lead sessions only/);
    await expect(mem().add({ body: "x", scope: "project" }, worker)).rejects.toThrow(/workers never write/);
    await expect(mem().add({ body: "   ", scope: "project" }, plain)).rejects.toThrow(/empty note/);
  });

  test("project notes stay in their project; operator notes follow everywhere", async () => {
    await mem({ project: "orch" }).add({ body: "orch port 4817", scope: "project" }, plain);
    const op = await mem({ project: "orch" }).add({ body: "operator port preference", scope: "operator" }, plain);
    const other = mem({ project: "acme" });
    expect((await other.search("port", plain)).map((n) => n.id)).toEqual([op.id]);
    expect((await other.recent(plain)).map((n) => n.id)).toEqual([op.id]);
    const inventory = await mem({ project: "orch" }).inventory(plain);
    expect(inventory.complete).toBe(true);
    expect(inventory.notes.find((n) => n.id === op.id)?.scope).toBe("operator");
    expect(inventory.notes.find((n) => n.body === "orch port 4817")?.project).toBe("orch");
  });

  test("supersede hides the old note, keeps its tags and links both ways", async () => {
    const old = await mem().add({ body: "API port 4817", scope: "project", tags: ["api", "port"] }, lead("claude"));
    const next = await mem().supersede(old.id, { body: "API port 4818" }, lead("codex"));
    expect(next.supersedes).toBe(old.id);
    expect(next.tags).toEqual(["api", "port"]);
    expect((await mem().search("API port", plain)).map((n) => n.id)).toEqual([next.id]);
    const shown = await mem().show(old.id, plain);
    expect([shown?.status, shown?.supersededBy]).toEqual(["superseded", next.id]);
    await expect(mem().supersede(old.id, { body: "API port 4819" }, plain)).rejects.toThrow(/is not active/);
    await expect(mem().supersede("nope", { body: "x" }, plain)).rejects.toThrow(/no readable note nope/);
  });

  test("forget keeps the note with its reason, out of default recall", async () => {
    const n = await mem().add({ body: "old staging host", scope: "operator" }, plain);
    const f = await mem().forget(n.id, "  host\nretired ", plain);
    expect([f.status, f.reason]).toEqual(["forgotten", "host retired"]);
    expect(await mem().search("staging", plain)).toEqual([]);
    expect((await mem().search("staging", plain, { all: true })).map((x) => x.status)).toEqual(["forgotten"]);
    await expect(mem().forget(n.id, "again", plain)).rejects.toThrow(/is not active/);
  });

  test("recent puts the stopping point first", async () => {
    await mem().add({ body: "old", scope: "project" }, plain);
    await mem().add({ body: "stopped at step 3", scope: "project" }, plain);
    expect((await mem().recent(plain, { limit: 1 }))[0].body).toBe("stopped at step 3");
  });

  test.each(["two", "one"])("concurrent notes with the same first line and second stay independently addressable (%s)", async (second) => {
    const fixed = mem({ now: () => new Date("2026-10-24T09:00:00Z") });
    const bodies = ["same line\none", `same line\n${second}`];
    const notes = await Promise.all(bodies.map((body) => fixed.add({ body, scope: "project" }, plain)));
    expect(notes.map((n) => n.id).sort()).toEqual(["20261024T090000Z-same-line", "20261024T090000Z-same-line-2"]);
    expect(notes.map((n) => n.body)).toEqual(bodies);
    expect(await Promise.all(notes.map(async (n) => (await fixed.show(n.id, plain))?.body))).toEqual(bodies);
    const next = await fixed.supersede(notes[0].id, { body: "same line\ncorrected" }, plain);
    expect(next.id).toBe("20261024T090000Z-same-line-3");
    expect(next.body).toBe("same line\ncorrected");
    expect((await fixed.show(notes[0].id, plain))?.supersededBy).toBe(next.id);
    expect((await fixed.show(notes[1].id, plain))?.status).toBeUndefined();
    expect((await fixed.recent(plain)).map((n) => n.id).sort()).toEqual([notes[1].id, next.id].sort());
  });

  test("the query is embedded only once vectors exist, and a failing embedder falls back to text with a warning", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const hybrid = mem({ space: "voyage-4", embedQuery: async () => { calls++; return axis(1); }, warn: (m) => warnings.push(m) });
    await hybrid.add({ body: "train Zurich booked", scope: "project" }, plain);
    const ticket = await hybrid.add({ body: "billet acheté", scope: "project" }, plain);
    expect((await hybrid.search("train", plain)).length).toBe(1);
    expect(calls).toBe(0);
    await embedPending(db, "voyage-4", async (t) => t.map((x) => axis(x.includes("billet") ? 1 : 0)));
    expect((await hybrid.search("train", plain)).map((n) => n.id)[0]).toBe(ticket.id);
    expect(calls).toBe(1);
    const down = mem({ space: "voyage-4", embedQuery: async () => { throw new Error("VOYAGE_API_KEY missing"); }, warn: (m) => warnings.push(m) });
    expect((await down.search("train", plain)).map((n) => n.body)).toEqual(["train Zurich booked"]);
    expect(warnings).toEqual(["mem: vector recall skipped, text only: VOYAGE_API_KEY missing"]);
  });

  test("a note is embedded as it is written; one the provider failed is kept without vector and flagged on recall", async () => {
    const warnings: string[] = [];
    const docs: string[] = [];
    const ok = mem({ space: "s", embedQuery: async () => axis(1), embedDocument: async (t) => { docs.push(t); return axis(1); }, warn: (w) => warnings.push(w) });
    const n = await ok.add({ body: "billet acheté", scope: "project" }, plain);
    expect(docs).toEqual(["billet acheté"]);
    expect((await ok.search("voyage en train", plain)).map((x) => x.id)).toEqual([n.id]);
    expect(warnings).toEqual([]);
    const down = mem({ space: "s", embedQuery: async () => axis(1), embedDocument: async () => { throw new Error("provider down"); }, warn: (w) => warnings.push(w) });
    const later = await down.add({ body: "second billet", scope: "project" }, plain);
    expect(warnings).toEqual(["mem: note saved without vector (provider down); orch brain embed fills it"]);
    expect((await down.search("voyage", plain)).map((x) => x.id)).toEqual([n.id]);
    expect(warnings.at(-1)).toBe("mem: 1 note without a vector is not searched by meaning: orch brain embed");
    await ok.supersede(later.id, { body: "second billet, remboursé" }, plain);
    expect(docs.at(-1)).toBe("second billet, remboursé");
    expect((await ok.search("voyage", plain)).length).toBe(2);
    expect(warnings).toHaveLength(2);
  });

  test("review pairs a note with the one it restates", async () => {
    await mem().add({ body: "deploy target is the homelab, port 4817", scope: "project" }, plain);
    await mem().add({ body: "deploy target is the homelab, port 4818", scope: "project" }, plain);
    await mem().add({ body: "unrelated decision about fonts", scope: "project" }, plain);
    const pairs = await mem().review(plain);
    expect(pairs.length).toBe(1);
    expect(pairs[0].newer.body).toContain("4818");
  });

  test("ids of imported notes keep working after the switch", async () => {
    const note: Note = { id: "20261020T155719Z-git-workflow", scope: "project", harness: "claude", session: "", date: "2026-10-20T15:57:19.000Z", tags: ["git"], body: "git workflow: squash on merge" };
    await importNotes(db, [note], "orch");
    expect((await mem().search("squash", plain)).map((n) => n.id)).toEqual([note.id]);
    const next = await mem().supersede(note.id, { body: "git workflow: squash on merge, never push unasked" }, lead("claude"));
    expect((await mem().show(note.id, plain))?.supersededBy).toBe(next.id);
    expect(await mem({ project: "acme" }).show(note.id, plain)).toBeUndefined();
  });
});
