import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "../src/mem/mem.ts";
import { filesAt, sandboxMem } from "../src/mem/sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "orch-mem-sandbox-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const lead: Caller = { lead: true, lane: false, harness: "claude", session: "bench" };
const realFiles = () => readdirSync(join(root, "real", "state", "mem", "operator")).map((f) => readFileSync(join(root, "real", "state", "mem", "operator", f), "utf8")).join("\n");

describe("orch mem sandbox", () => {
  test("a bench reads the real notes, writes and reads back its own, and never touches the real store", async () => {
    const real = filesAt(join(root, "real"));
    const kept = await real.add({ body: "Les CR vont dans docs/cr", scope: "operator" }, lead);
    const dropped = await real.add({ body: "Notifications par Telegram", scope: "operator" }, lead);
    const before = realFiles();
    const bench = sandboxMem(real, join(root, "bench"));

    const learned = await bench.add({ body: "Notifications par Discord tant que les clés Telegram manquent", scope: "operator" }, lead);
    const fixed = await bench.supersede(dropped.id, { body: "Notifications par Discord" }, lead);
    expect(fixed.supersedes).toBe(dropped.id);
    await bench.forget(kept.id, "test", lead);

    expect(realFiles()).toBe(before);
    expect((await real.recent(lead)).map((n) => n.id).sort()).toEqual([kept.id, dropped.id].sort());
    expect((await bench.search("notifications", lead)).map((n) => n.id).sort()).toEqual([learned.id, fixed.id].sort());
    expect((await bench.recent(lead)).map((n) => n.id)).not.toContain(kept.id);
    expect((await bench.show(dropped.id, lead))?.status).toBe("superseded");
    await expect(bench.forget(dropped.id, "", lead)).rejects.toThrow("not active");
    await expect(bench.add({ body: "x", scope: "operator" }, { ...lead, lane: true })).rejects.toThrow("workers never write");
  });
});
