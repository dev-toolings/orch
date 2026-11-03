import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCandidate, applyMemory, guardMemory, MEMORY_CAP, parseReflection, readCandidates, reflectionMaterials, rejectCandidate, runReflect, USER_CAP, writeCandidates } from "../src/reflect/reflect.ts";
import type { Notice } from "../src/presence/notify.ts";

let root: string;
const savedPath = process.env.PATH;
const savedLane = process.env.ORCH_LANE;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-reflect-")); delete process.env.ORCH_LANE; });
afterAll(() => {
  process.env.PATH = savedPath;
  if (savedLane !== undefined) process.env.ORCH_LANE = savedLane;
  else delete process.env.ORCH_LANE;
  rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-10-25T08:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const line = (value: object) => JSON.stringify(value);
const choice = { model: "opus", effort: "high" };

function world() {
  const dir = mkdtempSync(join(root, "world-"));
  const projects = join(dir, "projects");
  const state = join(dir, "state");
  const project = join(projects, "fixture-project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(state, "routines"), { recursive: true });
  const transcript = join(project, "session.jsonl");
  writeFileSync(transcript, line({
    entrypoint: "cli", cwd: "/tmp/fixture-project", type: "user", timestamp: at(2),
    message: { content: "Non, vérifie l'effet avant de lancer cette commande." },
  }) + "\n");
  utimesSync(transcript, NOW, NOW);
  writeFileSync(join(state, "routines", "journal.jsonl"), line({
    id: "fixture", start: at(3), end: at(3), ok: false,
    steps: [{ command: "fixture command", exit: 1, timed_out: false, ms: 1, tail: "missing input" }],
  }) + "\n");
  return { projects, state };
}

function fakeClaude(message: string) {
  const bin = mkdtempSync(join(root, "bin-"));
  const argv = join(bin, "argv");
  const stdin = join(bin, "stdin");
  const output = JSON.stringify({ result: message });
  const shellOutput = output.replace(/'/g, "'\\''");
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"$@\" > " + argv + "\ncat > " + stdin + "\nprintf '%s\\n' '" + shellOutput + "'\n");
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = bin + ":/usr/bin:/bin";
  return { argv, stdin };
}

describe("reflect", () => {
  test("parses full sections and the RIEN response", () => {
    expect(parseReflection("## MEMORY\n- 25-10-2026 : Le problème a été réparé.\n## USER\n- Vérifier les effets || « vérifie l'effet avant »\n## SKILLS\n### revue-commandes\nLire la commande, puis vérifier son effet.\n")).toEqual({
      memory: "- 25-10-2026 : Le problème a été réparé.",
      user: [{ text: "Vérifier les effets", evidence: "« vérifie l'effet avant »", kind: "add" }],
      skills: [{ name: "revue-commandes", body: "Lire la commande, puis vérifier son effet." }],
      nothing: false,
    });
    expect(parseReflection("RIEN\n")).toEqual({ memory: null, user: [], skills: [], nothing: true });
    expect(parseReflection("## MEMORY\n(rien)\n## USER\n(aucune)").memory).toBeNull();
    expect(parseReflection("## MEMORY\n(nothing)\n## USER\n(none)").memory).toBeNull();
  });

  test("guards memory against empty, oversized, truncated, and dropped rewrites", () => {
    expect(guardMemory("- old note", "").ok).toBe(false);
    expect(guardMemory("", "x".repeat(MEMORY_CAP + 1)).reason).toContain("above the 2200 character cap");
    expect(guardMemory("x".repeat(100), "x".repeat(49)).reason).toContain("shorter than half");
    const bullets = Array.from({ length: 4 }, (_, i) => "- old line " + i + " " + "detail ".repeat(5));
    const previous = bullets.concat(["padding ".repeat(100)]).join("\n");
    const next = "padding ".repeat(100);
    expect(guardMemory(previous, next).reason).toContain("drops 4 previous lines");
    const old = "- keep this durable line as evidence\n" + "x".repeat(100);
    const kept = "- keep this durable line as evidence\n- add one new lesson\n" + "x".repeat(100);
    expect(guardMemory(old, kept)).toEqual({ ok: true });
  });

  test("run updates guarded memory, journals candidates and skill drafts, and notifies once", async () => {
    const w = world();
    mkdirSync(join(w.state, "kiba-memory"), { recursive: true });
    const previous = "- 2026-10-20 : Preserve this durable note about the operator workflow and evidence.\n- 2026-10-21 : Old routine details are no longer useful in this context.\n";
    writeFileSync(join(w.state, "kiba-memory", "MEMORY.md"), previous);
    writeFileSync(join(w.state, "kiba-memory", "USER.md"), "- 2026-10-20 : Prefer concise reports.\n");
    writeCandidates([{ n: 3, text: "Older rejected rule", date: "2026-10-24", evidence: "old", status: "rejected" }], w.state);
    const answer = [
      "## MEMORY",
      "x 2026-10-21 : Old routine details are no longer useful in this context.",
      "+ 25-10-2026 : The operator corrected an unsafe command proposal.",
      "## USER",
      "- Check command effects before running || « vérifie l'effet avant »",
      "- Keep concise reports || « préfère des rapports concis »",
      "## SKILLS",
      "### revue-commandes",
      "Read the command, identify side effects, and verify the result.",
    ].join("\n");
    const fake = fakeClaude(answer);
    const sent: Notice[] = [];
    const result = await runReflect({
      projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root,
      notify: async (notice) => { sent.push(notice); },
    });

    expect(result.memoryUpdated).toBe(true);
    expect(readFileSync(join(w.state, "kiba-memory", "MEMORY.md"), "utf8")).toEndWith("\n");
    expect(readFileSync(join(w.state, "kiba-memory", "MEMORY.md"), "utf8")).toContain("The operator corrected an unsafe command proposal.");
    expect(result.candidates.map(({ n, status }) => [n, status])).toEqual([[4, "pending"], [5, "pending"]]);
    expect(readCandidates(w.state).map(({ n, status }) => [n, status])).toEqual([[3, "rejected"], [4, "pending"], [5, "pending"]]);
    expect(result.skills).toEqual(["revue-commandes"]);
    expect(readFileSync(join(w.state, "reflect", "skills", "revue-commandes.md"), "utf8")).toContain("# revue-commandes (brouillon du 2026-10-25, à valider)");
    const dayFile = readFileSync(result.path!, "utf8");
    expect(dayFile).toContain("# Réflexion du 2026-10-25");
    expect(dayFile).toContain("+ - 25-10-2026 : The operator corrected an unsafe command proposal.");
    expect(dayFile).toContain("- - 2026-10-21 : Old routine details");
    expect(readFileSync(fake.argv, "utf8")).toContain("--allowedTools");
    expect(readFileSync(fake.argv, "utf8")).not.toContain("--permission-mode plan");
    expect(readFileSync(fake.stdin, "utf8")).toContain("« Non, vérifie l'effet avant de lancer cette commande. »");
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Réflexion du 2026-10-25");
  });

  test("applyMemory applies strict add, replace, and remove deltas by exact old line", () => {
    const previous = "# Notes\n\n- 20-10-2026 : première leçon, à garder.\n- 21-10-2026 : ancienne version.\n- 22-10-2026 : dépassée.\n";
    const next = applyMemory(previous, "~ 21-10-2026 : ancienne version. => 28-10-2026 : nouvelle version.\nx 22-10-2026 : dépassée.\n+ 28-10-2026 : leçon du jour.\n");
    expect(next).toBe("# Notes\n\n- 20-10-2026 : première leçon, à garder.\n- 28-10-2026 : nouvelle version.\n- 28-10-2026 : leçon du jour.");
    expect(guardMemory(previous, next).ok).toBe(true);
    expect(applyMemory(previous, "(rien)")).toBe(previous.trimEnd());
    expect(() => applyMemory(previous, "- 20-10-2026 : corps complet.")).toThrow("not an explicit +, ~, or x operation");
  });

  test("applyMemory rejects unknown, ambiguous, repeated, and excessive old-line changes", () => {
    const previous = "- repeated line\n- repeated line\n- third line\n- fourth line\n- fifth line\n";
    expect(() => applyMemory(previous, "x missing line")).toThrow("target not found");
    expect(() => applyMemory(previous, "x repeated line")).toThrow("target is ambiguous");
    expect(() => applyMemory(previous, "x third line\nx third line")).toThrow("targets the same old line more than once");
    expect(() => applyMemory(previous, "x third line\nx fourth line\nx fifth line\n~ repeated line => replaced"))
      .toThrow("changes 4 old lines, above the limit of 3");
  });

  test("materials show the room left in MEMORY.md and the rules already proposed", () => {
    const state = join(mkdtempSync(join(root, "mat-")), "state");
    mkdirSync(join(state, "kiba-memory"), { recursive: true });
    writeFileSync(join(state, "kiba-memory", "MEMORY.md"), "- 28-10-2026 : une ligne.\n");
    writeCandidates([{ n: 1, text: "règle déjà vue", date: "2026-10-28", evidence: "", status: "pending" }], state);
    const text = reflectionMaterials(state, "");
    expect(text).toContain(`## MEMORY.md (25 / ${MEMORY_CAP} caractères, place restante : ${MEMORY_CAP - 25})`);
    expect(text).toContain("- règle déjà vue (pending)");
  });

  test("a removal candidate (x line) is parsed, and accepting it moves the USER.md line to the history", () => {
    const parsed = parseReflection("## MEMORY\n(rien)\n## USER\nx Pas de docker login || « on se logge sur le hub maintenant »\n- Nouvelle règle || « preuve »\n");
    expect(parsed.user).toEqual([
      { text: "Pas de docker login", evidence: "« on se logge sur le hub maintenant »", kind: "remove" },
      { text: "Nouvelle règle", evidence: "« preuve »", kind: "add" },
    ]);
    const state = join(mkdtempSync(join(root, "rm-")), "state");
    mkdirSync(join(state, "kiba-memory"), { recursive: true });
    writeFileSync(join(state, "kiba-memory", "USER.md"), "# Op\n\n- Bun seulement.\n- Pas de docker login Docker Hub (26-10).\n");
    writeCandidates([{ n: 1, text: "Pas de docker login", date: "2026-10-28", evidence: "e", status: "pending", kind: "remove" }], state);
    const result = acceptCandidate(1, state);
    expect(result.line).toBe("- Pas de docker login Docker Hub (26-10).");
    expect(readFileSync(join(state, "kiba-memory", "USER.md"), "utf8")).toBe("# Op\n\n- Bun seulement.\n");
    expect(readFileSync(join(state, "reflect", "USER.history.md"), "utf8")).toContain("superseded: - Pas de docker login Docker Hub (26-10).");
    expect(readCandidates(state)[0].status).toBe("accepted");
  });

  test("a quiet day does not call Claude", async () => {
    const dir = mkdtempSync(join(root, "quiet-"));
    const fake = fakeClaude("RIEN");
    const result = await runReflect({ projects: join(dir, "projects"), state: join(dir, "state"), now: NOW, choice, timeoutMs: 10_000, cwd: root });
    expect([result.path, result.note, existsSync(fake.argv)]).toEqual([null, "reflect: nothing in the last 24 h, no model call", false]);
  });

  test("a refused memory rewrite leaves the file intact and records the refusal", async () => {
    const w = world();
    mkdirSync(join(w.state, "kiba-memory"), { recursive: true });
    const previous = "- old memory " + "with enough detail to make this a meaningful saved note. ".repeat(5) + "\n";
    writeFileSync(join(w.state, "kiba-memory", "MEMORY.md"), previous);
    fakeClaude(`## MEMORY\nx ${previous.trim().slice(2)}\n+ tiny\n## USER\n(aucune)\n## SKILLS\n(aucun)`);
    const result = await runReflect({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root });
    expect(result.memoryUpdated).toBe(false);
    expect(result.memoryRefused).toContain("shorter than half");
    expect(readFileSync(join(w.state, "kiba-memory", "MEMORY.md"), "utf8")).toBe(previous);
    expect(readFileSync(result.path!, "utf8")).toContain("refusé : new MEMORY.md is shorter than half");
  });

  test("an invalid memory delta refuses the whole section without writing additions", async () => {
    const w = world();
    mkdirSync(join(w.state, "kiba-memory"), { recursive: true });
    const previous = "- Existing verified note\n";
    writeFileSync(join(w.state, "kiba-memory", "MEMORY.md"), previous);
    fakeClaude("## MEMORY\n+ New verified note\nx Missing old note\n## USER\n(none)\n## SKILLS\n(none)");

    const result = await runReflect({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root });

    expect(result.memoryUpdated).toBe(false);
    expect(result.memoryRefused).toContain("target not found");
    expect(readFileSync(join(w.state, "kiba-memory", "MEMORY.md"), "utf8")).toBe(previous);
  });

  test("accept appends within the cap and refuses overflow without writing", () => {
    const dir = mkdtempSync(join(root, "accept-"));
    mkdirSync(join(dir, "kiba-memory"), { recursive: true });
    writeFileSync(join(dir, "kiba-memory", "USER.md"), "- Existing rule\n");
    writeCandidates([{ n: 1, text: "Verify effects first", date: "2026-10-25", evidence: "operator correction", status: "pending" }], dir);
    const accepted = acceptCandidate(1, dir);
    expect(accepted.line).toBe("- 2026-10-25 : Verify effects first");
    expect(accepted.user).toContain(accepted.line + "\n");
    expect(readCandidates(dir)[0].status).toBe("accepted");

    const full = mkdtempSync(join(root, "full-user-"));
    mkdirSync(join(full, "kiba-memory"), { recursive: true });
    writeCandidates([{ n: 2, text: "Long rule", date: "2026-10-25", evidence: "proof", status: "pending" }], full);
    const before = "x".repeat(USER_CAP - 5) + "\n";
    writeFileSync(join(full, "kiba-memory", "USER.md"), before);
    expect(() => acceptCandidate(2, full)).toThrow("reflect accept: USER.md would exceed " + USER_CAP + " characters");
    expect(readFileSync(join(full, "kiba-memory", "USER.md"), "utf8")).toBe(before);
    expect(readCandidates(full)[0].status).toBe("pending");
  });

  test("reject marks a candidate rejected", () => {
    const dir = mkdtempSync(join(root, "reject-"));
    writeCandidates([{ n: 7, text: "Rejected rule", date: "2026-10-25", evidence: "quote", status: "pending" }], dir);
    expect(rejectCandidate(7, dir).status).toBe("rejected");
    expect(readCandidates(dir)[0].status).toBe("rejected");
  });

  test("candidate text already recorded or present in USER.md is not added again", async () => {
    const w = world();
    mkdirSync(join(w.state, "kiba-memory"), { recursive: true });
    writeFileSync(join(w.state, "kiba-memory", "USER.md"), "- 2026-10-20 : Already in user memory\n");
    writeCandidates([
      { n: 8, text: "Already in candidate history", date: "2026-10-24", evidence: "old", status: "accepted" },
    ], w.state);
    const answer = [
      "## MEMORY",
      "(nothing)",
      "## USER",
      "- Already in candidate history || proof",
      "- Already in user memory || proof",
      "- New repeated rule || first proof",
      "- New repeated rule || second proof",
      "## SKILLS",
      "(aucun)",
    ].join("\n");
    fakeClaude(answer);
    const result = await runReflect({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root });
    expect(result.candidates.map((candidate) => [candidate.n, candidate.text])).toEqual([[9, "New repeated rule"]]);
    expect(readCandidates(w.state)).toHaveLength(2);
  });

  test("candidate history keeps opposite kinds for the same text", async () => {
    const w = world();
    mkdirSync(join(w.state, "kiba-memory"), { recursive: true });
    writeFileSync(join(w.state, "kiba-memory", "USER.md"), "- Keep concise reports\n");
    writeCandidates([
      { n: 8, text: "Keep concise reports", date: "2026-10-24", evidence: "old", status: "accepted", kind: "add" },
    ], w.state);
    fakeClaude("## MEMORY\n(nothing)\n## USER\nx Keep concise reports || the report says the preference changed\n## SKILLS\n(none)");

    const result = await runReflect({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root });

    expect(result.candidates.map(({ text, kind }) => [text, kind])).toEqual([["Keep concise reports", "remove"]]);
    expect(readCandidates(w.state).map(({ kind }) => kind)).toEqual(["add", "remove"]);
  });
});
