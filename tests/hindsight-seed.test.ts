import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesAt } from "../src/mem/sandbox.ts";
import type { MemBackend } from "../src/mem/backend.ts";
import type { Caller, Note } from "../src/mem/mem.ts";
import { seedHindsight } from "../src/memory/seed.ts";
import type { HindsightConfig, RetainItem } from "../src/memory/hindsight.ts";

let root: string;
let alpha: string;
let store: MemBackend;
let server: ReturnType<typeof Bun.serve>;
let status = 200;
let acceptedCount: number | undefined;
let retainGate: { entered: () => void; wait: Promise<void> } | undefined;
const savedOrchHome = process.env.ORCH_HOME;
const seen: { bank: string; items: RetainItem[] }[] = [];
const deletedDocs: { bank: string; documentId: string }[] = [];
const serverDocs = new Set<string>();
const lead: Caller = { lead: true, lane: false, harness: "claude", session: "seed-test" };
let notes: Note[] = [];

const config = (url = `http://127.0.0.1:${server.port}`): HindsightConfig => ({ url, bank: "base", recall_max_tokens: 10, recall_budget: "low", timeout_ms: 1000 });
const docKey = (bank: string, id: string) => `${bank}\0${id}`;
const namespaceId = (url: string, base: string) => createHash("sha256").update(JSON.stringify([url, base])).digest("hex");
const readManifest = (state = root) => JSON.parse(readFileSync(join(state, "hindsight-seed.json"), "utf8")) as {
  version: number;
  namespaces: Record<string, { server: string; base: string; hashes: Record<string, Record<string, string>> }>;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-seed-"));
  alpha = join(root, "work", "alpha");
  mkdirSync(alpha, { recursive: true });
  process.env.ORCH_HOME = root;
  store = filesAt(join(root, "source"), { cwd: alpha });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "PUT") return Response.json({});
    if (req.method === "DELETE") {
      const parts = path.split("/");
      const bank = decodeURIComponent(parts[4]);
      const documentId = decodeURIComponent(parts[6]);
      deletedDocs.push({ bank, documentId });
      serverDocs.delete(docKey(bank, documentId));
      return new Response(null, { status: 204 });
    }
    if (status !== 200) return new Response("failure", { status });
    const body = await req.json() as { items: RetainItem[] };
    const bank = decodeURIComponent(path.split("/")[4]);
    seen.push({ bank, items: body.items });
    const count = acceptedCount ?? body.items.length;
    for (const item of body.items.slice(0, Math.max(0, count))) {
      if (item.document_id) serverDocs.add(docKey(bank, item.document_id));
    }
    if (retainGate) {
      const gate = retainGate;
      retainGate = undefined;
      gate.entered();
      await gate.wait;
    }
    return Response.json({ items_count: count });
  } });
});

afterAll(() => {
  server.stop(true);
  if (savedOrchHome === undefined) delete process.env.ORCH_HOME;
  else process.env.ORCH_HOME = savedOrchHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  seen.length = 0;
  deletedDocs.length = 0;
  serverDocs.clear();
  status = 200;
  acceptedCount = undefined;
  retainGate = undefined;
  rmSync(join(root, "hindsight-seed.json"), { force: true });
  rmSync(join(root, "source"), { recursive: true, force: true });
  rmSync(join(root, "improve"), { recursive: true, force: true });
  rmSync(join(root, "asks"), { recursive: true, force: true });
  rmSync(join(root, ".orch"), { recursive: true, force: true });
  rmSync(join(root, "lanes.jsonl"), { force: true });
  mkdirSync(join(root, ".orch", "deploy-shuttle"), { recursive: true });
  store = filesAt(join(root, "source"), { cwd: alpha });
  notes = [
    await store.add({ body: "body-operator", scope: "operator" }, lead),
    await store.add({ body: "body-lead", scope: "lead" }, lead),
    await store.add({ body: "body-project", scope: "project" }, lead),
  ];
  writeFileSync(join(root, "lanes.jsonl"), [
    { id: "lane1", kind: "run", repo: "alpha", at: "2026-10-27T00:00:00.000Z" },
    { id: "lane2", kind: "run", repo: "deploy-shuttle", at: "2026-10-27T01:00:00.000Z" },
    { id: "without-repo", kind: "run", at: "2026-10-27T02:00:00.000Z" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
});

describe("incremental Hindsight seed", () => {
  test("invalid concurrency fails before any retain", async () => {
    await expect(seedHindsight(config(), "base", { state: root, store, concurrency: Number.NaN })).rejects.toThrow("positive integer");
    expect(seen).toHaveLength(0);
  });
  test("colliding document identities fail before any retain", async () => {
    const inventory = await store.inventory(lead);
    const duplicate = { ...store, inventory: async () => ({ ...inventory, notes: [...inventory.notes, inventory.notes[0]] }) };
    await expect(seedHindsight(config(), "base", { state: root, store: duplicate })).rejects.toThrow("duplicate document identity");
    expect(seen).toHaveLength(0);
    expect(deletedDocs).toHaveLength(0);
  });
  test("routes complete file inventory and exhaust, skips stable hashes, and full resends", async () => {
    mkdirSync(join(root, "improve"), { recursive: true });
    writeFileSync(join(root, "improve", "2026-10-28.md"), "global brief");
    mkdirSync(join(root, ".orch", "deploy-shuttle", "asks", "research"), { recursive: true });
    writeFileSync(join(root, ".orch", "deploy-shuttle", "asks", "research", "answer.md"), "deploy research synthesis");

    const first = await seedHindsight(config(), "base", { state: root, store, now: new Date("2026-10-28T00:00:00Z") });
    expect(first.sent).toBe(notes.length + first.exhaust);
    const flat = seen.flatMap((batch) => batch.items.map((item) => ({ bank: batch.bank, item })));
    expect(flat.find((x) => x.item.document_id === `mem:${notes[0].id}`)?.bank).toBe("base");
    expect(flat.find((x) => x.item.document_id === `mem:${notes[1].id}`)?.bank).toBe("base");
    expect(flat.find((x) => x.item.document_id === `mem:${notes[2].id}`)?.bank).toBe("base-alpha");
    expect(flat.find((x) => x.item.document_id === "lane:lane1:run:2026-10-27T00:00:00.000Z")?.bank).toBe("base-alpha");
    expect(flat.find((x) => x.item.document_id === "lane:lane2:run:2026-10-27T01:00:00.000Z")?.bank).toBe("base-deploy-shuttle");
    expect(flat.some((x) => x.item.document_id?.includes("without-repo"))).toBe(false);
    expect(flat.find((x) => x.item.document_id === "improve:2026-10-28")?.bank).toBe("base");
    expect(flat.find((x) => x.item.document_id === "synthese:research")?.bank).toBe("base-deploy-shuttle");

    const manifest = readManifest();
    const namespace = manifest.namespaces[namespaceId(config().url, "base")];
    expect(manifest.version).toBe(2);
    expect(namespace.server).toBe(config().url);
    expect(namespace.hashes.base[`mem:${notes[0].id}`]).toMatch(/^[a-f0-9]{64}$/);
    expect(namespace.hashes["base-alpha"][`mem:${notes[2].id}`]).toMatch(/^[a-f0-9]{64}$/);

    const again = await seedHindsight(config(), "base", { state: root, store, now: new Date("2026-10-28T00:00:00Z") });
    expect(again.sent).toBe(0);
    expect(again.skipped).toBe(notes.length + again.exhaust);
    const full = await seedHindsight(config(), "base", { state: root, store, full: true, now: new Date("2026-10-28T00:00:00Z") });
    expect(full.sent).toBe(notes.length + full.exhaust);
  });

  test("inventories more than 1000 notes from the real backend", async () => {
    store = filesAt(join(root, "many"), { cwd: alpha });
    for (let i = 0; i < 1001; i++) await store.add({ body: `inventory-${i}`, scope: "operator" }, lead);

    const result = await seedHindsight(config(), "large", { state: root, store, concurrency: 12 });

    expect(result.notes).toBe(1001);
    expect(result.sent).toBe(1001 + result.exhaust);
    const all = seen.flatMap((batch) => batch.items);
    const ids = new Set(all.map((item) => item.document_id).filter((id): id is string => !!id));
    expect(all.some((item) => item.document_id?.startsWith("mem:") && item.content.includes("inventory-1000"))).toBe(true);
    expect([...ids].filter((id) => id.startsWith("mem:")).length).toBe(1001);
  });

  test("a project inventory cannot prune another project bank for the same base", async () => {
    const shared = join(root, "multi-project-source");
    const beta = join(root, "work", "beta");
    mkdirSync(beta, { recursive: true });
    const alphaStore = filesAt(shared, { cwd: alpha });
    const betaStore = filesAt(shared, { cwd: beta });
    const alphaNote = await alphaStore.add({ body: "alpha-only project memory", scope: "project" }, lead);
    await betaStore.add({ body: "beta-only project memory", scope: "project" }, lead);

    await seedHindsight(config(), "shared", { state: root, store: alphaStore });
    const alphaDocument = docKey("shared-alpha", `mem:${alphaNote.id}`);
    expect(serverDocs.has(alphaDocument)).toBe(true);

    await seedHindsight(config(), "shared", { state: root, store: betaStore });

    expect(deletedDocs).toEqual([]);
    expect(serverDocs.has(alphaDocument)).toBe(true);
    const namespace = readManifest().namespaces[namespaceId(config().url, "shared")];
    expect(namespace.hashes["shared-alpha"][`mem:${alphaNote.id}`]).toBeDefined();
  });

  test("a bench namespace cannot delete production documents in either direction", async () => {
    await seedHindsight(config(), "kiba", { state: root, store });
    await seedHindsight(config(), "bench-kiba", { state: root, store });
    const productionDocs = [...serverDocs].filter((key) => key.startsWith("kiba\0") || key.startsWith("kiba-"));
    expect(productionDocs.length).toBeGreaterThan(0);

    await store.forget(notes[0].id, "inactive", lead);
    await seedHindsight(config(), "bench-kiba", { state: root, store });
    expect(deletedDocs).toContainEqual({ bank: "bench-kiba", documentId: `mem:${notes[0].id}` });
    expect(deletedDocs.some((row) => row.bank.startsWith("kiba") && row.documentId === `mem:${notes[0].id}`)).toBe(false);
    expect(serverDocs.has(docKey("kiba", `mem:${notes[0].id}`))).toBe(true);

    deletedDocs.length = 0;
    await seedHindsight(config(), "kiba", { state: root, store });
    expect(deletedDocs).toContainEqual({ bank: "kiba", documentId: `mem:${notes[0].id}` });
    expect(deletedDocs.some((row) => row.bank.startsWith("bench-kiba") && row.documentId === `mem:${notes[0].id}`)).toBe(false);
  });

  test("server identity is part of the manifest namespace", async () => {
    await seedHindsight(config(), "base", { state: root, store });
    const otherServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      if (req.method === "PUT") return Response.json({});
      const body = await req.json() as { items: RetainItem[] };
      return Response.json({ items_count: body.items.length });
    } });
    try {
      await seedHindsight(config(`http://127.0.0.1:${otherServer.port}`), "base", { state: root, store });
    } finally { otherServer.stop(true); }

    const manifest = readManifest();
    expect(Object.keys(manifest.namespaces)).toHaveLength(2);
    expect(deletedDocs).toEqual([]);
  });

  test("a legacy flat manifest never authorizes deletion", async () => {
    writeFileSync(join(root, "hindsight-seed.json"), JSON.stringify({ "other-bank:mem:legacy": "old-hash" }));

    const result = await seedHindsight(config(), "base", { state: root, store });

    expect(result.deleted).toBe(0);
    expect(deletedDocs).toEqual([]);
    expect(serverDocs.has(docKey("other-bank", "mem:legacy"))).toBe(false);
  });

  test("failed and short retains keep the previous manifest and all old documents", async () => {
    await seedHindsight(config(), "base", { state: root, store });
    const oldManifest = readFileSync(join(root, "hindsight-seed.json"), "utf8");
    const oldDocs = new Set(serverDocs);
    await store.forget(notes[0].id, "replace", lead);
    await store.add({ body: "replacement operator note", scope: "operator" }, lead);

    status = 503;
    const failed = await seedHindsight(config(), "base", { state: root, store });
    expect(failed.failed).toBeGreaterThan(0);
    expect(deletedDocs).toEqual([]);
    expect(readFileSync(join(root, "hindsight-seed.json"), "utf8")).toBe(oldManifest);
    expect(serverDocs).toEqual(oldDocs);

    status = 200;
    acceptedCount = 0;
    const short = await seedHindsight(config(), "base", { state: root, store });
    expect(short.failed).toBeGreaterThan(0);
    expect(deletedDocs).toEqual([]);
    expect(readFileSync(join(root, "hindsight-seed.json"), "utf8")).toBe(oldManifest);
    expect(serverDocs).toEqual(oldDocs);
  });

  test("concurrent runs cannot overwrite a manifest namespace loaded by another run", async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredRequest = new Promise<void>((resolve) => { entered = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
    retainGate = { entered, wait: waitForRelease };

    const first = seedHindsight(config(), "base", { state: root, store });
    await enteredRequest;
    await expect(seedHindsight(config(), "other", { state: root, store })).rejects.toThrow("another run is active");
    release();
    await first;

    const manifest = readManifest();
    expect(Object.keys(manifest.namespaces)).toEqual([namespaceId(config().url, "base")]);
  });

  test("deletes inactive notes and moved lanes, but keeps aged-out ledger documents", async () => {
    await seedHindsight(config(), "base", { state: root, store, now: new Date("2026-10-28T00:00:00Z") });
    const state = readManifest();
    const namespace = state.namespaces[namespaceId(config().url, "base")];
    namespace.hashes["base-acme"] = { "lane:aged:run:2026-10-01T00:00:00.000Z": "old-hash" };
    writeFileSync(join(root, "hindsight-seed.json"), `${JSON.stringify(state, null, 2)}\n`);
    serverDocs.add(docKey("base-acme", "lane:aged:run:2026-10-01T00:00:00.000Z"));
    mkdirSync(join(root, ".orch", "new-repo"), { recursive: true });

    writeFileSync(join(root, "lanes.jsonl"), [
      { id: "lane2", kind: "run", repo: "new-repo", at: "2026-10-27T01:00:00.000Z" },
      { id: "aged", kind: "run", repo: "acme", at: "2026-10-01T00:00:00.000Z" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await store.forget(notes[1].id, "inactive", lead);

    const result = await seedHindsight(config(), "base", { state: root, store, now: new Date("2026-10-28T00:00:00Z") });

    expect(deletedDocs).toContainEqual({ bank: "base-deploy-shuttle", documentId: "lane:lane2:run:2026-10-27T01:00:00.000Z" });
    expect(deletedDocs).toContainEqual({ bank: "base", documentId: `mem:${notes[1].id}` });
    expect(deletedDocs.some((row) => row.documentId === "lane:aged:run:2026-10-01T00:00:00.000Z")).toBe(false);
    expect(serverDocs.has(docKey("base-acme", "lane:aged:run:2026-10-01T00:00:00.000Z"))).toBe(true);
    expect(result.deleted).toBe(2);
  });

  test("a ledger row from an unknown repo (old worktree name) creates no bank", async () => {
    const created: string[] = [];
    const recorder = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const bank = decodeURIComponent(new URL(req.url).pathname.split("/")[4]);
      if (req.method === "PUT") { created.push(bank); return Response.json({}); }
      const body = await req.json() as { items: RetainItem[] };
      return Response.json({ items_count: body.items.length });
    } });
    writeFileSync(join(root, "lanes.jsonl"), [
      { id: "lane1", kind: "run", repo: "alpha", at: "2026-10-27T00:00:00.000Z" },
      { id: "stray", kind: "run", repo: "dev-depl-55", at: "2026-10-27T01:00:00.000Z" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    try {
      await seedHindsight(config(`http://127.0.0.1:${recorder.port}`), "base", { state: root, store, now: new Date("2026-10-28T00:00:00Z") });
    } finally { recorder.stop(true); }
    expect(created).toContain("base-alpha");
    expect(created).not.toContain("base-dev-depl-55");
  });

  test("source and manifest state can be separated", async () => {
    const source = join(root, "source-corpus");
    const manifest = join(root, "isolated-run");
    mkdirSync(join(source, "improve"), { recursive: true });
    writeFileSync(join(source, "improve", "2026-10-28.md"), "read-only corpus");

    await seedHindsight(config(), "isolated", { sourceState: source, manifestState: manifest, store });

    expect(existsSync(join(source, "hindsight-seed.json"))).toBe(false);
    expect(existsSync(join(manifest, "hindsight-seed.json"))).toBe(true);
    expect(seen.flatMap((batch) => batch.items).some((item) => item.document_id === "improve:2026-10-28")).toBe(true);
  });
});
