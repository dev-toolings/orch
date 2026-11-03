#!/usr/bin/env bun
// parity [--level N]: matrix of the Emilien corpus (tests/parity/emilien.yaml).
// Delivered level 0 cases with an automated check run here; live levels are
// pending (billable), and cases of a later architecture step are gated.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { loadBrainConfig, roleName } from "../brain/db.ts";
import { loadSources } from "../docs/docs.ts";
import { workerArgv } from "../harness/harness.ts";
import { addNote, type Caller, recentNotes, searchNotes } from "../mem/mem.ts";
import { HARNESSES, loadProfile, ROOT } from "../core/profile.ts";
import { leadPrompt, render } from "../install/render.ts";
import { loadConfig as loadLlmConfig } from "../llm/llm.ts";
import { assertSpendAllowed } from "../core/policy.ts";
import { estimateLaneUsd } from "../core/paid.ts";

interface Case { id: string; family: string; title: string; level: number; gate: string }

// Memory checks run against a throwaway state dir and project folder root,
// never the operator's.
function withMem<T>(f: (opts: { state: string; projects: string; cwd: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "orch-parity-"));
  try {
    return f({ state: join(root, "state"), projects: join(root, "projects"), cwd: root });
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
  PW01: () => /^You are Kiba, the operator's lead developer\./m.test(leadPrompt()) && leadPrompt().includes("Never claim to be human"),
  // a decision saved with a nonce in one session is found, with its id, in another
  PW10: () => withMem((o) => {
    const n = addNote({ body: "deploy target: nonce 4f9x", scope: "operator" }, plain, o);
    return searchNotes("4f9x", plain, o)[0]?.id === n.id;
  }),
  // saved in one session, read from another, provenance kept
  PW11: () => withMem((o) => {
    addNote({ body: "export format: NDJSON", scope: "project" }, lead("codex"), o);
    return searchNotes("export", lead("grok"), o)[0]?.harness === "codex";
  }),
  // the lead scope is invisible to a plain session
  PW13: () => withMem((o) => {
    addNote({ body: "lead only", scope: "lead" }, lead("claude"), o);
    return searchNotes("lead", plain, o).length === 0 && searchNotes("lead", lead("grok"), o).length === 1;
  }),
  // a new session finds the stopping point first
  PW30: () => withMem((o) => {
    addNote({ body: "old", scope: "project" }, lead("claude"), { ...o, now: new Date("2020-01-01") });
    addNote({ body: "stopped at step 3", scope: "project" }, lead("claude"), { ...o, now: new Date("2021-01-01") });
    return recentNotes(plain, { ...o, limit: 1 })[0]?.body === "stopped at step 3";
  }),
  // one database and two roles per domain, bound to localhost, vectors sized
  // like the embed providers, one row per content hash (behaviour: brain.test.ts)
  EM10: () => {
    const c = loadBrainConfig();
    const compose = readFileSync(join(ROOT, "infra", "compose.yml"), "utf8");
    const sql = readFileSync(join(ROOT, "infra", "migrations", "001_memories.sql"), "utf8");
    const roles = c.domains.flatMap((d) => [roleName(d, "ro"), roleName(d, "rw")]);
    return c.domains.length >= 5 && new Set(roles).size === roles.length && /"127\.0\.0\.1:\d+:5432"/.test(compose) &&
      sql.includes(`embedding vector(${loadLlmConfig().dimensions})`) && sql.includes("content_hash text NOT NULL UNIQUE");
  },
  // CLAUDE.md core stays small
  T01: () => readFileSync(join(homedir(), ".claude", "CLAUDE.md")).length <= 4096,
  // lane only ever launches the target harness binary
  T02: () => HARNESSES.every((h) => workerArgv(h, loadProfile().lanes[h], { cwd: "/w", promptPath: "/p", readOnly: false, lastMessagePath: "/l" }).argv[0] === h),
  // report bound comes from the profile and is small
  T03: () => loadProfile().limits.report_max_bytes <= 4096 && loadProfile("lean").limits.report_max_bytes <= 4096,
  // the cheaper profile really is cheaper for workers
  // Worker efforts share the route's ladder in every profile (81d1176): lean is
  // cheaper by its Claude worker model and its concurrency ceiling.
  PW62: () => {
    const lean = loadProfile("lean"), max = loadProfile("max20");
    return lean.lanes.claude.model !== max.lanes.claude.model
      && lean.limits.max_concurrent_ceiling < max.limits.max_concurrent_ceiling
      && render(lean, ["claude", "codex", "grok"]).length > 0;
  },
  // a mission is a DAG of normal lanes: parse + batch go through laneAuto
  T04: () => {
    const mission = readFileSync(join(ROOT, "src/lanes/mission.ts"), "utf8");
    const lane = readFileSync(join(ROOT, "src/lane.ts"), "utf8");
    return mission.includes("forceLane: true") && mission.includes("laneAuto") && lane.includes('cmd === "batch"');
  },
  // spend tracking is informational: no refusal on daily cap settings
  T05: () => {
    assertSpendAllowed({ label: "mission", watched: true, policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02 }, paid_routines: [] } });
    const cap = { spend: { daily_usd: 0.001, embed_usd_per_million: 0.02 }, paid_routines: [] };
    assertSpendAllowed({ label: "lane report", extraUsd: estimateLaneUsd("high"), policy: cap });
    return true;
  },
  // delegation has no side path: batch calls laneAuto, not a second runner
  T06: () => {
    const mission = readFileSync(join(ROOT, "src/lanes/mission.ts"), "utf8");
    const lane = readFileSync(join(ROOT, "src/lane.ts"), "utf8");
    return mission.includes("await laneAuto(") && !mission.includes("spawnSync") && lane.includes("forceLane");
  },
};

const { values } = parseArgs({ args: process.argv.slice(2), options: { level: { type: "string" } } });
const max = Number(values.level ?? 2);
const corpus = parse(readFileSync(join(ROOT, "tests", "parity", "emilien.yaml"), "utf8")) as { cases: Case[] };
const rows = corpus.cases.map((c) => {
  let result: string;
  if (c.gate !== "v1") result = `GATED(${c.gate})`;
  else if (c.level > max) result = "PENDING(live)";
  else if (checks[c.id]) result = checks[c.id]() ? "PASS" : "FAIL";
  else result = "NO-CHECK";
  return { ...c, result };
});
for (const r of rows) console.log(`${r.id.padEnd(5)} L${r.level} ${r.result.padEnd(22)} ${r.title}`);
const count = (p: string) => rows.filter((r) => r.result.startsWith(p)).length;
console.log(`\nPASS ${count("PASS")}  FAIL ${count("FAIL")}  PENDING ${count("PENDING")}  GATED ${count("GATED")}  NO-CHECK ${count("NO-CHECK")}`);
if (count("FAIL")) process.exitCode = 1;
