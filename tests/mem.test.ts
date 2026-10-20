import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, type Caller, listNotes, recentNotes, searchNotes, showNote } from "../src/mem.ts";

let state: string;
let repo: string;
const lead = (harness: string): Caller => ({ lead: true, lane: false, harness, session: `${harness}-s1` });
const plain: Caller = { lead: false, lane: false, harness: "claude", session: "" };
const worker: Caller = { lead: false, lane: true, harness: "codex", session: "" };

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "orch-mem-"));
  state = join(root, "state");
  repo = join(root, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]);
});
afterAll(() => rmSync(join(state, ".."), { recursive: true, force: true }));

describe("mem", () => {
  test("a note saved by one harness is found from another, with provenance and id", () => {
    const n = addNote({ body: "Export format: decided NDJSON, nonce k7q2", scope: "project", tags: ["export"] }, lead("codex"), { state, cwd: repo });
    const hits = searchNotes("nonce k7q2", lead("grok"), { state, cwd: join(repo, "sub") });
    expect(hits.map((h) => h.id)).toEqual([n.id]);
    expect(hits[0].harness).toBe("codex");
    expect(showNote(n.id, plain, { state, cwd: repo })?.body).toContain("NDJSON");
  });

  test("project notes live in the repository, operator notes in the state dir", () => {
    addNote({ body: "Operator prefers Bun everywhere", scope: "operator" }, lead("claude"), { state, cwd: repo });
    expect(listNotes(plain, { state, cwd: repo, scope: "project" }).every((n) => n.scope === "project")).toBe(true);
    expect(listNotes(plain, { state, cwd: "/", scope: "operator" }).map((n) => n.body)).toEqual(["Operator prefers Bun everywhere"]);
  });

  test("the lead scope is invisible to a plain session and closed to it", () => {
    addNote({ body: "Lead doctrine: spec before lane", scope: "lead" }, lead("claude"), { state, cwd: repo });
    expect(searchNotes("doctrine", lead("grok"), { state, cwd: repo })).toHaveLength(1);
    expect(searchNotes("doctrine", plain, { state, cwd: repo })).toHaveLength(0);
    expect(() => addNote({ body: "x", scope: "lead" }, plain, { state, cwd: repo })).toThrow(/lead sessions only/);
  });

  test("workers never write", () => {
    expect(() => addNote({ body: "worker note", scope: "project" }, worker, { state, cwd: repo })).toThrow(/workers never write/);
  });

  test("recent lists newest first, so a new session can resume", () => {
    addNote({ body: "Stopped at: lane PW22 pending", scope: "project" }, lead("claude"), { state, cwd: repo, now: new Date("2030-01-01T00:00:00Z") });
    const r = recentNotes(lead("claude"), { state, cwd: repo, limit: 1 });
    expect(r[0].body).toBe("Stopped at: lane PW22 pending");
  });

  test("search ranks by matched words, empty query returns nothing", () => {
    addNote({ body: "Export uses gzip", scope: "project" }, lead("claude"), { state, cwd: repo });
    const hits = searchNotes("export ndjson", lead("claude"), { state, cwd: repo });
    expect(hits[0].body).toContain("NDJSON");
    expect(searchNotes("  ", lead("claude"), { state, cwd: repo })).toEqual([]);
  });
});
