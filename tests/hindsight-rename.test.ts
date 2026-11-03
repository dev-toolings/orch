import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HindsightConfig } from "../src/memory/hindsight.ts";
import { renameBanks, renamedBank, renameSeedBase } from "../src/memory/rename-banks.ts";
import { namespaceId } from "../src/memory/seed.ts";

// A fake Hindsight: banks with node/document counts, an async clone.
const banks = new Map<string, { nodes: number; documents: number }>();
const calls: string[] = [];
let breakClone = "";
let server: ReturnType<typeof Bun.serve>;
const root = mkdtempSync(join(tmpdir(), "orch-rename-"));
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url);
    const m = /^\/v1\/default\/banks(?:\/([^/]+))?(?:\/(stats|clone|operations)(?:\/([^/]+))?)?$/.exec(url.pathname);
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (!m) return new Response("no", { status: 404 });
    const bank = m[1] ? decodeURIComponent(m[1]) : "";
    if (!bank) return Response.json({ banks: [...banks.keys()].map((bank_id) => ({ bank_id })) });
    if (req.method === "DELETE") { banks.delete(bank); return Response.json({}); }
    if (m[2] === "stats") return banks.has(bank) ? Response.json({ bank_id: bank, total_nodes: banks.get(bank)!.nodes, total_documents: banks.get(bank)!.documents, pending_operations: 0 }) : new Response("missing", { status: 404 });
    if (m[2] === "clone") {
      const to = url.searchParams.get("target_bank_id")!;
      const src = banks.get(bank)!;
      banks.set(to, bank === breakClone ? { nodes: src.nodes - 1, documents: src.documents } : { ...src });
      return Response.json({ operation_id: `op-${bank}` });
    }
    if (m[2] === "operations") return Response.json({ status: "completed" });
    return new Response("no", { status: 404 });
  } });
});
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });
const config = (): HindsightConfig => ({ url: `http://127.0.0.1:${server.port}`, bank: "kiba", recall_max_tokens: 100, recall_budget: "low", timeout_ms: 2000 } as HindsightConfig);
const fast = { sleep: async () => {}, pollMs: 1 };

test("names: the base and its project banks only", () => {
  expect(renamedBank("old", "old", "new")).toBe("new");
  expect(renamedBank("old-orch", "old", "new")).toBe("new-orch");
  expect(renamedBank("oldz", "old", "new")).toBeNull();
  expect(renamedBank("bench-old", "old", "new")).toBeNull();
});

test("each bank is cloned, checked, then dropped; a mismatch or an existing target keeps the source", async () => {
  banks.clear();
  for (const [b, n] of [["old", 10], ["old-orch", 20], ["old-scratch", 2], ["old-bad", 5], ["old-taken", 3], ["new-taken", 1], ["oldz", 4]] as const) banks.set(b, { nodes: n, documents: 1 });
  breakClone = "old-bad";
  const r = await renameBanks(config(), "old", "new", { ...fast, drop: ["old-scratch"] });
  expect(r.moved.sort()).toEqual(["old", "old-orch"]);
  expect(r.dropped).toEqual(["old-scratch"]);
  expect(r.kept.sort()).toEqual(["old-bad", "old-taken"]);
  expect([...banks.keys()].sort()).toEqual(["new", "new-bad", "new-orch", "new-taken", "old-bad", "old-taken", "oldz"]);
  expect(banks.get("new-orch")).toEqual({ nodes: 20, documents: 1 });
  expect(calls.some((c) => c.includes("/clone?target_bank_id=new-orch&include_data=true"))).toBe(true);
});

test("the seed manifest follows the moved banks, so nothing is sent twice", async () => {
  const file = join(root, "hindsight-seed.json");
  const server = "http://127.0.0.1:8899";
  writeFileSync(file, JSON.stringify({ version: 2, namespaces: { [namespaceId(server, "old")]: { server, base: "old", hashes: { old: { a: "1" }, "old-orch": { b: "2" }, "old-scratch": { c: "3" } } } } }));
  expect(await renameSeedBase("old", "new", { dropped: ["old-scratch"] }, root)).toBe(1);
  const m = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(m.namespaces)).toEqual([namespaceId(server, "new")]);
  expect(m.namespaces[namespaceId(server, "new")]).toEqual({ server, base: "new", hashes: { new: { a: "1" }, "new-orch": { b: "2" } } });
});

test("a run resuming an interrupted one still renames the keys left under the old name", async () => {
  const file = join(root, "hindsight-seed.json");
  const server = "http://127.0.0.1:8899";
  writeFileSync(file, JSON.stringify({ version: 2, namespaces: { [namespaceId(server, "new")]: { server, base: "new", hashes: { old: { a: "1" }, "new-api": { b: "2" } } } } }));
  expect(await renameSeedBase("old", "new", { dropped: [] }, root)).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8")).namespaces[namespaceId(server, "new")].hashes).toEqual({ new: { a: "1" }, "new-api": { b: "2" } });
});
