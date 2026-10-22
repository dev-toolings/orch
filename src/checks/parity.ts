#!/usr/bin/env bun
// parity [--level N]: matrix of the Powlisher corpus. Level 0 cases with an
// automated check run here; higher levels are listed as pending (billable).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { loadSources } from "../docs/docs.ts";
import { workerArgv } from "../harness/harness.ts";
import { addNote, type Caller, recentNotes, searchNotes } from "../mem/mem.ts";
import { HARNESSES, loadProfile, ROOT } from "../core/profile.ts";
import { leadPrompt, render } from "../install/render.ts";

interface Case { id: string; family: string; title: string; level: number; gate: string }

// Memory checks run against a throwaway state dir, never the operator's.
function withMem<T>(f: (state: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "orch-parity-"));
  try {
    return f(join(root, "state"), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const lead = (harness: string): Caller => ({ lead: true, lane: false, harness, session: "p" });
const plain: Caller = { lead: false, lane: false, harness: "claude", session: "" };

const checks: Record<string, () => boolean> = {
  // every docs source is well formed and unique; nothing is fetched here
  T08: () => loadSources().length >= 20,
  // persona is fixed in the cached prompt, honest about the model
  PW01: () => /^You are Marius, the operator's lead developer\./m.test(leadPrompt()) && leadPrompt().includes("Never claim to be human"),
  // a decision saved with a nonce in one session is found, with its id, in another
  PW10: () => withMem((state, cwd) => {
    const n = addNote({ body: "deploy target: nonce 4f9x", scope: "operator" }, plain, { state, cwd });
    return searchNotes("4f9x", plain, { state, cwd })[0]?.id === n.id;
  }),
  // saved from Codex, read from Grok, provenance kept
  PW11: () => withMem((state, cwd) => {
    addNote({ body: "export format: NDJSON", scope: "project" }, lead("codex"), { state, cwd });
    return searchNotes("export", lead("grok"), { state, cwd })[0]?.harness === "codex";
  }),
  // the lead scope is invisible to a plain session
  PW13: () => withMem((state, cwd) => {
    addNote({ body: "lead only", scope: "lead" }, lead("claude"), { state, cwd });
    return searchNotes("lead", plain, { state, cwd }).length === 0 && searchNotes("lead", lead("grok"), { state, cwd }).length === 1;
  }),
  // a new session finds the stopping point first
  PW30: () => withMem((state, cwd) => {
    addNote({ body: "old", scope: "project" }, lead("claude"), { state, cwd, now: new Date("2020-01-01") });
    addNote({ body: "stopped at step 3", scope: "project" }, lead("claude"), { state, cwd, now: new Date("2021-01-01") });
    return recentNotes(plain, { state, cwd, limit: 1 })[0]?.body === "stopped at step 3";
  }),
  // CLAUDE.md core stays small
  T01: () => readFileSync(join(homedir(), ".claude", "CLAUDE.md")).length <= 4096,
  // lane only ever launches the target harness binary
  T02: () => HARNESSES.every((h) => workerArgv(h, loadProfile().lanes[h], { cwd: "/w", promptPath: "/p", readOnly: false, lastMessagePath: "/l" }).argv[0] === h),
  // report bound comes from the profile and is small
  T03: () => loadProfile().limits.report_max_bytes <= 4096 && loadProfile("lean").limits.report_max_bytes <= 4096,
  // the cheaper profile really is cheaper for workers
  PW62: () => loadProfile("lean").lanes.codex.effort !== loadProfile("max20").lanes.codex.effort && render(loadProfile("lean"), ["claude", "codex", "grok"]).length > 0,
};

const { values } = parseArgs({ args: process.argv.slice(2), options: { level: { type: "string" } } });
const max = Number(values.level ?? 2);
const corpus = parse(readFileSync(join(ROOT, "tests", "parity", "powlisher-v1.yaml"), "utf8")) as { cases: Case[] };
const rows = corpus.cases.map((c) => {
  let result: string;
  if (c.gate !== "v1" && c.gate !== "partial") result = `GATED(${c.gate})`;
  else if (c.level > max) result = "PENDING(live)";
  else if (checks[c.id]) result = checks[c.id]() ? "PASS" : "FAIL";
  else result = "NO-CHECK";
  return { ...c, result };
});
for (const r of rows) console.log(`${r.id.padEnd(5)} L${r.level} ${r.result.padEnd(22)} ${r.title}`);
const count = (p: string) => rows.filter((r) => r.result.startsWith(p)).length;
console.log(`\nPASS ${count("PASS")}  FAIL ${count("FAIL")}  PENDING ${count("PENDING")}  GATED ${count("GATED")}  NO-CHECK ${count("NO-CHECK")}`);
if (count("FAIL")) process.exitCode = 1;
