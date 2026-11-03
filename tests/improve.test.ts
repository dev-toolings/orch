import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, readSession, runImprove, titles } from "../src/improve/improve.ts";
import type { Notice } from "../src/presence/notify.ts";

let root: string;
const savedPath = process.env.PATH;
const savedLane = process.env.ORCH_LANE;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-improve-")); delete process.env.ORCH_LANE; });
afterAll(() => {
  process.env.PATH = savedPath;
  if (savedLane !== undefined) process.env.ORCH_LANE = savedLane;
  rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-10-25T08:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const line = (o: object) => JSON.stringify(o);

// A projects dir like ~/.claude/projects: one interactive session, one headless
// lane worker, one session last touched two days ago.
function world() {
  const dir = mkdtempSync(join(root, "w-"));
  const projects = join(dir, "projects");
  const state = join(dir, "state");
  mkdirSync(join(projects, "-home-kev-lab-app"), { recursive: true });
  mkdirSync(join(projects, "-home-kev-lane"), { recursive: true });
  mkdirSync(join(state, "routines"), { recursive: true });
  const base = { entrypoint: "cli", cwd: "/home/kev/lab/app" };
  writeFileSync(join(projects, "-home-kev-lab-app", "s.jsonl"), [
    line({ ...base, type: "user", timestamp: at(30), message: { content: "an old message, before the window" } }),
    line({ ...base, type: "user", timestamp: at(3), message: { content: "non, je t'ai dit de ne pas pousser sans demander" } }),
    line({ ...base, type: "user", timestamp: at(3), isMeta: true, message: { content: "hook output, not the operator" } }),
    line({ ...base, type: "user", timestamp: at(3), message: { content: "<task-notification>done</task-notification>" } }),
    line({ ...base, type: "assistant", timestamp: at(2), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    line({ ...base, type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "jq: error: Cannot index string" }] } }),
    line({ ...base, type: "user", timestamp: at(1), message: { content: [{ type: "text", text: "recommence stp" }] } }),
    "not json",
  ].join("\n"));
  writeFileSync(join(projects, "-home-kev-lane", "w.jsonl"),
    line({ entrypoint: "sdk-cli", cwd: "/tmp/lane", type: "user", timestamp: at(1), message: { content: "spec text, no operator here" } }));
  const old = join(projects, "-home-kev-lab-app", "old.jsonl");
  writeFileSync(old, line({ ...base, type: "user", timestamp: at(48), message: { content: "two days ago" } }));
  utimesSync(old, new Date(at(48)), new Date(at(48)));
  const journal = [
    { id: "ops-check", start: at(5), end: at(5), ok: false, steps: [{ command: "orch ops check", exit: 1, timed_out: false, ms: 1, tail: "FAIL exposure 8100" }] },
    { id: "ops-check", start: at(4), end: at(4), ok: false, steps: [{ command: "orch ops check", exit: 1, timed_out: false, ms: 1, tail: "FAIL exposure 3300" }] },
    { id: "brain-backup", start: at(4), end: at(4), ok: true, steps: [] },
  ];
  writeFileSync(join(state, "routines", "journal.jsonl"), journal.map(line).join("\n") + "\n");
  return { projects, state };
}

describe("improve", () => {
  test("a session keeps the operator's words and the tool errors of the window; headless runs are skipped", () => {
    const w = world();
    const s = readSession(join(w.projects, "-home-kev-lab-app", "s.jsonl"), new Date(at(24)))!;
    expect(s.cwd).toBe("/home/kev/lab/app");
    expect(s.operator).toEqual(["non, je t'ai dit de ne pas pousser sans demander", "recommence stp"]);
    expect([...s.errors]).toEqual([["Bash", ["jq: error: Cannot index string"]]]);
    expect(readSession(join(w.projects, "-home-kev-lane", "w.jsonl"), new Date(at(24)))).toBeNull();
  });

  test("the digest groups failed routines, lists sessions, and is bounded", () => {
    const w = world();
    const d = collect({ since: new Date(at(24)), projects: w.projects, state: w.state });
    expect(d.text).toContain("- ops-check : 2 échec(s), le dernier à");
    expect(d.text).toContain("FAIL exposure 3300");
    expect(d.text).not.toContain("brain-backup");
    expect(d.text).toContain("## Session /home/kev/lab/app");
    expect(d.text).toContain("« recommence stp »");
    expect(d.text).not.toContain("two days ago");
    expect(d.text).not.toContain("spec text");
    expect(d.signals).toBe(2 + 2 + 1);
    const small = collect({ since: new Date(at(24)), projects: w.projects, state: w.state, maxBytes: 120 });
    expect(Buffer.byteLength(small.text)).toBeLessThan(200);
    expect(small.text).toContain("relevé tronqué à 120 octets");
  });

  function fakeClaude(body: string) {
    const bin = mkdtempSync(join(root, "bin-"));
    const argv = join(bin, "argv");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" > ${argv}\npwd >> ${argv}\ncat > ${join(bin, "stdin")}\n${body}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    return { argv, stdin: join(bin, "stdin") };
  }
  const choice = { model: "opus", effort: "high" };

  test("run: a read-only Claude in orch turns the digest into proposals, saved and sent with their titles", async () => {
    const w = world();
    const f = fakeClaude(`printf '%s\\n' '{"result":"### 1. Ne jamais pousser sans demande\\nCONSTAT : x\\n### 2. Corriger jq\\nCONSTAT : y"}'`);
    const sent: Notice[] = [];
    const r = await runImprove({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root, notify: async (t) => { sent.push(t); } });
    expect(r.titles).toEqual(["1. Ne jamais pousser sans demande", "2. Corriger jq"]);
    expect(readFileSync(r.path!, "utf8")).toStartWith("# Propositions du 2026-10-25\n\n### 1. Ne jamais pousser sans demande");
    const argv = readFileSync(f.argv, "utf8");
    expect(argv).toContain("-p --output-format json");
    expect(argv).toContain("--model opus --effort high");
    expect(argv).toContain("--allowedTools");
    expect(argv).not.toContain("--permission-mode plan");
    expect(readFileSync(f.stdin, "utf8")).toContain("« recommence stp »");
    expect([sent[0].title, sent[0].text]).toEqual(["2 idées pour améliorer orch", "1. Ne jamais pousser sans demande\n2. Corriger jq"]);
    expect(sent[0].note).toContain("« valide N »");
  });

  test("run: a quiet day calls no model; a failed run throws and saves no proposals", async () => {
    const empty = mkdtempSync(join(root, "empty-"));
    const f = fakeClaude("exit 0");
    const quiet = await runImprove({ projects: join(empty, "none"), state: join(empty, "state"), now: NOW, choice, timeoutMs: 10_000 });
    expect([quiet.path, existsSync(f.argv)]).toEqual([null, false]);
    const w = world();
    fakeClaude("echo boom; exit 1");
    await expect(runImprove({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root })).rejects.toThrow("improve: model run exited 1");
    expect(existsSync(join(w.state, "improve", "2026-10-25.md"))).toBe(false);
    fakeClaude(`printf '%s\\n' '{"result":"RIEN"}'`);
    const none = await runImprove({ projects: w.projects, state: w.state, now: NOW, choice, timeoutMs: 10_000, cwd: root, notify: async () => { throw new Error("must not notify"); } });
    expect(none.titles).toEqual([]);
    expect(none.note).toContain("nothing proposed");
  });

  test("titles reads the numbered headings only", () => {
    expect(titles("intro\n### 1. Un\ntext ### 2. pas un titre\n###3. Deux\n")).toEqual(["1. Un", "3. Deux"]);
  });
});
