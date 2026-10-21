import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, forgetNote, type Caller, listNotes, recentNotes, searchNotes, showNote, supersedeNote } from "../src/mem/mem.ts";
import { similar } from "../src/mem/similar.ts";

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

  test("a project note from a linked worktree is stored and found in the main worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mem-worktree-"));
    const main = join(root, "main");
    const linked = join(root, "linked");
    mkdirSync(main, { recursive: true });
    try {
      expect(spawnSync("git", ["-C", main, "init", "-q"]).status).toBe(0);
      expect(spawnSync("git", ["-C", main, "config", "user.name", "orch-test"]).status).toBe(0);
      expect(spawnSync("git", ["-C", main, "config", "user.email", "orch-test@example.invalid"]).status).toBe(0);
      writeFileSync(join(main, "README.md"), "test\n");
      expect(spawnSync("git", ["-C", main, "add", "README.md"]).status).toBe(0);
      expect(spawnSync("git", ["-C", main, "commit", "-qm", "initial"]).status).toBe(0);
      expect(spawnSync("git", ["-C", main, "worktree", "add", "-q", linked, "HEAD"]).status).toBe(0);

      const n = addNote({ body: "Main worktree memory", scope: "project" }, lead("codex"), { state, cwd: linked });
      expect(listNotes(plain, { state, cwd: main, scope: "project" }).map((note) => note.id)).toContain(n.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("project notes warn only when the repository ignores them", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mem-ignore-"));
    const ignoredRepo = join(root, "ignored");
    const cleanRepo = join(root, "clean");
    mkdirSync(ignoredRepo, { recursive: true });
    mkdirSync(cleanRepo, { recursive: true });
    try {
      expect(spawnSync("git", ["-C", ignoredRepo, "init", "-q"]).status).toBe(0);
      expect(spawnSync("git", ["-C", cleanRepo, "init", "-q"]).status).toBe(0);
      writeFileSync(join(ignoredRepo, ".gitignore"), ".orch/\n");
      const ignored = addNote({ body: "Local project note", scope: "project" }, lead("claude"), { state, cwd: ignoredRepo });
      const clean = addNote({ body: "Versioned project note", scope: "project" }, lead("claude"), { state, cwd: cleanRepo });
      expect(ignored.warning).toBe("note: .orch/mem is gitignored in this repository, project notes stay local");
      expect(clean.warning).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(() => supersedeNote("missing", { body: "worker note" }, worker, { state, cwd: repo })).toThrow(/workers never write/);
    expect(() => forgetNote("missing", "worker reason", worker, { state, cwd: repo })).toThrow(/workers never write/);
  });

  test("supersede links notes and hides the old note unless all is requested", () => {
    const localState = mkdtempSync(join(tmpdir(), "orch-mem-supersede-"));
    const localRepo = join(localState, "repo");
    mkdirSync(localRepo, { recursive: true });
    spawnSync("git", ["-C", localRepo, "init", "-q"]);
    try {
      const old = addNote({ body: "Decision before the change", scope: "project" }, lead("claude"), { state: localState, cwd: localRepo, now: new Date("2030-01-01T00:00:00Z") });
      const next = supersedeNote(old.id, { body: "Decision after the change", tags: ["updated"] }, lead("grok"), { state: localState, cwd: localRepo, now: new Date("2030-01-02T00:00:00Z") });
      const oldShown = showNote(old.id, plain, { state: localState, cwd: localRepo });
      expect(oldShown?.status).toBe("superseded");
      expect(oldShown?.supersededBy).toBe(next.id);
      expect(oldShown?.supersededBy).toBe(next.id);
      expect(showNote(next.id, plain, { state: localState, cwd: localRepo })?.supersedes).toBe(old.id);
      expect(listNotes(plain, { state: localState, cwd: localRepo, scope: "project" }).map((note) => note.id)).toEqual([next.id]);
      expect(searchNotes("decision", plain, { state: localState, cwd: localRepo, scope: "project" }).map((note) => note.id)).toEqual([next.id]);
      expect(recentNotes(plain, { state: localState, cwd: localRepo })).toHaveLength(1);
      expect(searchNotes("decision", plain, { state: localState, cwd: localRepo, all: true }).map((note) => note.id)).toEqual(expect.arrayContaining([old.id, next.id]));
      expect(recentNotes(plain, { state: localState, cwd: localRepo, all: true })).toHaveLength(2);
      // a correction without tags keeps the tags of the note it replaces
      const third = supersedeNote(next.id, { body: "Decision after a second change" }, lead("codex"), { state: localState, cwd: localRepo, now: new Date("2030-01-03T00:00:00Z") });
      expect(third.tags).toEqual(["updated"]);
    } finally {
      rmSync(localState, { recursive: true, force: true });
    }
  });

  test("forget hides a note from default recall while show still returns its reason", () => {
    const localState = mkdtempSync(join(tmpdir(), "orch-mem-forget-"));
    try {
      const note = addNote({ body: "A decision that no longer holds", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      forgetNote(note.id, "The service was retired", lead("claude"), { state: localState, cwd: repo });
      expect(searchNotes("retired", plain, { state: localState, cwd: repo, scope: "operator" })).toEqual([]);
      expect(recentNotes(plain, { state: localState, cwd: repo, scope: "operator" })).toEqual([]);
      expect(showNote(note.id, plain, { state: localState, cwd: repo })).toMatchObject({ status: "forgotten", reason: "The service was retired" });
    } finally {
      rmSync(localState, { recursive: true, force: true });
    }
  });

  test("ids keep accented words readable: modèle gives modele", () => {
    const n = addNote({ body: "Reviewer : modèle élevé", scope: "operator" }, { lead: true, lane: false, harness: "claude", session: "" }, { state: mkdtempSync(join(tmpdir(), "mem-slug-")) });
    expect(n.id).toEndWith("-reviewer-modele-eleve");
  });

  test("same timestamp and first line still create distinct notes", () => {
    const localState = mkdtempSync(join(tmpdir(), "orch-mem-collision-"));
    const now = new Date("2030-02-03T04:05:06Z");
    const first = addNote({ body: "Same heading\nfirst body", scope: "operator" }, lead("claude"), { state: localState, cwd: repo, now });
    const second = addNote({ body: "Same heading\nsecond body", scope: "operator" }, lead("claude"), { state: localState, cwd: repo, now });

    expect(second.id).toBe(`${first.id}-2`);
    expect(listNotes(lead("claude"), { state: localState, cwd: repo, scope: "operator" }).map((n) => n.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    rmSync(localState, { recursive: true, force: true });
  });

  test("recent lists newest first, so a new session can resume", () => {
    addNote({ body: "Stopped at: lane PW22 pending", scope: "project" }, lead("claude"), { state, cwd: repo, now: new Date("2030-01-01T00:00:00Z") });
    const r = recentNotes(lead("claude"), { state, cwd: repo, limit: 1 });
    expect(r[0].body).toBe("Stopped at: lane PW22 pending");
  });

  test("BM25 normalizes accents, matches prefixes, and gives rare terms more weight", () => {
    const localState = mkdtempSync(join(tmpdir(), "orch-mem-bm25-"));
    try {
      const frequentOne = addNote({ body: "frequent", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      addNote({ body: "frequent", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      addNote({ body: "frequent", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      const rare = addNote({ body: "rareterm", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      const accent = addNote({ body: "modèle", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });
      const review = addNote({ body: "reviews", scope: "operator" }, lead("claude"), { state: localState, cwd: repo });

      expect(searchNotes("modele", plain, { state: localState, cwd: repo }).map((note) => note.id)).toContain(accent.id);
      expect(searchNotes("review", plain, { state: localState, cwd: repo }).map((note) => note.id)).toContain(review.id);
      expect(searchNotes("frequent rareterm", plain, { state: localState, cwd: repo })[0]?.id).toBe(rare.id);
      expect(searchNotes("empty", plain, { state: localState, cwd: repo })).toEqual([]);
      expect(frequentOne.id).not.toBe(rare.id);
    } finally {
      rmSync(localState, { recursive: true, force: true });
    }
  });

  test("empty query returns nothing", () => {
    addNote({ body: "Export uses gzip", scope: "project" }, lead("claude"), { state, cwd: repo });
    expect(searchNotes("  ", lead("claude"), { state, cwd: repo })).toEqual([]);
  });
});

describe("mem recall", () => {
  // Notes written by Grok in the mem-bench with the tag rule (2026-10-20), and
  // the 20 bench questions. Tags carry the words a question uses but the note
  // lacks: without them F14 ("outil d'accès à la base" vs "ORM, Kysely") is lost.
  const fixture = join(import.meta.dir, "fixtures", "mem-recall");
  const questions = JSON.parse(readFileSync(join(fixture, "questions.json"), "utf8")) as { id: string; q: string; a: string }[];
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const missed = (stripTags: boolean): string[] => {
    const root = mkdtempSync(join(tmpdir(), "orch-mem-recall-"));
    const localRepo = join(root, "repo");
    mkdirSync(join(localRepo, ".orch", "mem"), { recursive: true });
    spawnSync("git", ["-C", localRepo, "init", "-q"]);
    for (const f of readdirSync(join(fixture, "notes"))) {
      const text = readFileSync(join(fixture, "notes", f), "utf8");
      writeFileSync(join(localRepo, ".orch", "mem", f), stripTags ? text.replace(/^tags: .*$/m, "tags: ") : text);
    }
    try {
      return questions
        .filter((x) => !searchNotes(x.q, plain, { state: join(root, "state"), cwd: localRepo, limit: 3 }).some((n) => norm(n.body).includes(norm(x.a))))
        .map((x) => x.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("every bench question finds its note in the top 3, and tags are what make it so", () => {
    expect(missed(false)).toEqual([]);
    expect(missed(true)).toContain("F14");
  });
});

describe("mem close notes", () => {
  // The 20 active bench notes (Grok, 2026-10-20) and 60 labeled candidates:
  // per fact a restatement, a changed value, and a different fact on the same
  // subject. The detector only lists pairs for the lead to judge, so recall
  // on the first two classes is the contract; the third is measured, capped.
  const fixture = join(import.meta.dir, "fixtures");
  const candidates = JSON.parse(readFileSync(join(fixture, "mem-dedup", "candidates.json"), "utf8")) as { target: string; kind: string; body: string }[];

  test("restatements and changed values list their note; same-subject facts stay capped", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mem-close-"));
    const localRepo = join(root, "repo");
    mkdirSync(join(localRepo, ".orch", "mem"), { recursive: true });
    spawnSync("git", ["-C", localRepo, "init", "-q"]);
    for (const f of readdirSync(join(fixture, "mem-recall", "notes"))) {
      writeFileSync(join(localRepo, ".orch", "mem", f), readFileSync(join(fixture, "mem-recall", "notes", f), "utf8"));
    }
    try {
      const notes = listNotes(plain, { state: join(root, "state"), cwd: localRepo });
      const flagged = (c: { target: string; body: string }) => similar(c.body, notes, (n) => n.body).slice(0, 3).some((m) => m.item.body.includes(c.target));
      const missed = (kind: string) => candidates.filter((c) => c.kind === kind && !flagged(c)).map((c) => c.body);
      expect(missed("duplicate")).toEqual([]);
      // Known lexical limit: a change named only by a new word (Drizzle).
      expect(missed("update")).toEqual(["Pour Atlas on autorise désormais Drizzle à la place de Kysely."]);
      expect(candidates.filter((c) => c.kind === "distinct" && flagged(c)).length).toBeLessThanOrEqual(15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("orch mem add always saves; orch mem review lists the close pair after the fact", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mem-cli-"));
    const localRepo = join(root, "repo");
    mkdirSync(localRepo);
    spawnSync("git", ["-C", localRepo, "init", "-q"]);
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "orch.ts"), "mem", ...args], {
      cwd: localRepo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(root, "home"), ORCH_STATE: join(root, "state") },
    });
    try {
      expect(cli("review").stdout).toContain("no close pair");
      expect(cli("add", "Le port local de l'API Atlas est 4817.").status).toBe(0);
      expect(cli("add", "Le port local de l'API Atlas passe à 5100.").status).toBe(0);
      expect(cli("add", "Les migrations de base se lancent le jeudi.").status).toBe(0);
      expect(readdirSync(join(localRepo, ".orch", "mem")).length).toBe(3);
      const review = cli("review").stdout;
      expect(review).toMatch(/newer \S+-le-port-local-de-l-api-atlas-passe/);
      expect(review).toMatch(/older \S+-le-port-local-de-l-api-atlas-est-4817/);
      expect(review).not.toContain("migrations");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
