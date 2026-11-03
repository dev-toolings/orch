import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { appendEvent } from "../src/core/events.ts";
import {
  appendLog, consumeFreshRequest, contextTooLarge, DEFAULT_FRESH_PERCENT, formatLog,
  freshRequestPath, journalPath, parseLog, readLog, recheckBlock,
  snapshotState,
} from "../src/hooks/journal.ts";
import { logCli } from "../src/hooks/log-cli.ts";
import { runHook } from "../src/hooks/hook.ts";

let root: string;
let state: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-journal-"));
  state = join(root, "state");
  repo = join(root, "repo");
  mkdirSync(state, { recursive: true });
  mkdirSync(repo, { recursive: true });
  expect(spawnSync("sh", ["-c", "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base"], {
    cwd: repo, encoding: "utf8",
  }).status).toBe(0);
}, 20_000);

afterAll(() => rmSync(root, { recursive: true, force: true }), 20_000);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ORCH_LEAD: "1", ORCH_STATE: state, HOME: join(root, "home"), ...extra };
}

describe("mission log", () => {
  test("light log store round-trips tool errors and edited paths", async () => {
    const { recordTool, readLog } = await import("../src/hooks/log.ts");
    const project = "light-log";
    const e = env();
    recordTool({
      project, session: "light-session", tool: "Edit", summary: "expected x got y",
      file: "src/a.ts", failed: true, env: e,
    });
    expect(readLog(project, e)).toEqual([
      { at: expect.any(String), kind: "error", text: "Edit expected x got y", session: "light-session" },
      { at: expect.any(String), kind: "path", text: "src/a.ts", session: "light-session" },
    ]);
  });

  test("append groups STATE DECISIONS ERRORS PATHS NEXT EVIDENCE and rejects secrets", () => {
    const project = "alpha";
    const e = env();
    expect(appendLog({ kind: "decision", text: "keep lock.ts", project, env: e }).ok).toBe(true);
    expect(appendLog({ kind: "error", text: "bun test: expected 1 got 0", project, env: e }).ok).toBe(true);
    expect(appendLog({ kind: "path", text: "src/lanes/lock.ts", project, env: e }).ok).toBe(true);
    expect(appendLog({ kind: "next", text: "run lane check", project, env: e }).ok).toBe(true);
    expect(appendLog({ kind: "evidence", text: "VERIFY exit 0", project, env: e }).ok).toBe(true);
    expect(appendLog({ kind: "error", text: "ANTHROPIC_API_KEY=sk-ant-1234567890abcdef", project, env: e }).ok).toBe(false);
    const text = formatLog(readLog(project, e));
    expect(text).toContain("MISSION LOG");
    expect(text).toContain("DECISIONS:");
    expect(text).toContain("keep lock.ts");
    expect(text).toContain("ERRORS:");
    expect(text).toContain("PATHS:");
    expect(text).toContain("src/lanes/lock.ts");
    expect(text).toContain("NEXT:");
    expect(text).toContain("EVIDENCE:");
    expect(text).not.toContain("sk-ant-");
  });

  test("snapshot records live git, lanes and spend", () => {
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    const e = env();
    mkdirSync(join(state, "lanes", "lane-1"), { recursive: true });
    writeFileSync(join(state, "lanes", "lane-1", "state.json"), JSON.stringify({
      id: "lane-1", to: "claude", repo, base: "", branch: "feat/x", worktree: "",
      status: "complete", changed: true, usage: {}, started: "", ended: "",
    }));
    writeFileSync(join(state, "spend.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), usd: 1.25, source: "lane" })}\n`);
    const text = snapshotState({ cwd: repo, project: "snap", env: e });
    expect(text).toContain("branch main");
    expect(text).toMatch(/dirty 1/);
    expect(text).toContain("lanes lane-1:complete");
    expect(text).toContain("estimated cost (today) $1.25");
    expect(formatLog(readLog("snap", e))).toContain("STATE:");
  }, 20_000);

  test("contextTooLarge uses token usage, never transcript bytes", () => {
    const transcript = join(root, "big.jsonl");
    const pad = `${JSON.stringify({ type: "user", message: { content: "x".repeat(8000) } })}\n`.repeat(80);
    const low = JSON.stringify({
      type: "assistant",
      message: {
        id: "low", model: "claude-opus-4-5",
        usage: { input_tokens: 20_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 8_000, output_tokens: 500 },
      },
    });
    writeFileSync(transcript, `${pad}${low}\n`);
    expect(statSync(transcript).size).toBeGreaterThan(400_000);
    const isolated = { ORCH_FRESH_PERCENT: "60" };
    expect(contextTooLarge({ transcript_path: transcript }, isolated)).toMatchObject({ large: false, percent: 24 });
    expect(contextTooLarge({
      transcript_path: transcript,
      context_window: { used_percentage: 24, context_window_size: 200_000 },
    }, isolated).large).toBe(false);

    const high = JSON.stringify({
      type: "assistant",
      message: {
        id: "high", model: "claude-opus-4-5",
        usage: { input_tokens: 40_000, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 20_000 },
      },
    });
    writeFileSync(transcript, `${pad}${high}\n`);
    const over = contextTooLarge({ transcript_path: transcript }, isolated);
    expect(over.large).toBe(true);
    expect(over.percent).toBe(65);
    expect(over.threshold).toBe(60);

    const unknown = join(root, "unknown.jsonl");
    writeFileSync(unknown, `${pad}{"type":"user","message":{"content":"hello"}}\n`);
    expect(contextTooLarge({ transcript_path: unknown }, isolated)).toEqual({ large: false, threshold: 60, reason: "" });
    expect(contextTooLarge({}, isolated)).toEqual({ large: false, threshold: 60, reason: "" });
    expect(contextTooLarge({}, { ORCH_FRESH_PERCENT: "10" }).threshold).toBe(10);
    expect(contextTooLarge({}, {}).threshold).toBe(DEFAULT_FRESH_PERCENT);
  });

  test("recheck tells resume to trust the tree, not a compact", () => {
    const e = env();
    appendLog({ kind: "next", text: "ship the gate", project: "recheck", env: e });
    const text = recheckBlock({ cwd: repo, project: "recheck", env: e, source: "resume" });
    expect(text).toContain("RECHECK");
    expect(text).toContain("Do not trust a compacted summary");
    expect(text).toContain("ship the gate");
    expect(recheckBlock({ cwd: repo, project: "recheck", env: e, source: "compact" }))
      .toContain("Compaction is not the source of truth");
  }, 20_000);
});

describe("hooks write and inject the log", () => {
  test("session-start injects an existing log; resume rechecks; compact refuses to trust compaction", async () => {
    const cwd = join(root, "hook-log");
    mkdirSync(cwd, { recursive: true });
    const e = env({ ORCH_SESSION: "j1" });
    appendLog({ kind: "decision", text: "prefer delete", project: "hook-log", env: e });
    const start = await runHook("session-start", "claude", {
      session_id: "j1", cwd, source: "startup",
    }, e);
    expect(start).toContain("MISSION LOG");
    expect(start).toContain("prefer delete");

    const resume = await runHook("session-start", "claude", {
      session_id: "j1", cwd, source: "resume",
    }, e);
    expect(resume).toContain("RECHECK");
    expect(resume).toContain("Do not trust a compacted summary");

    const compact = await runHook("session-start", "claude", {
      session_id: "j1", cwd, source: "compact",
    }, e);
    expect(compact).toContain("Compaction is not the source of truth");
    expect(compact).toContain("MISSION LOG");
  }, 20_000);

  test("post-tool records failed tools and edited paths; usage above threshold nudges and writes a resume note", async () => {
    const cwd = join(root, "hook-tools");
    mkdirSync(cwd, { recursive: true });
    const e = env({ ORCH_SESSION: "j2", ORCH_FRESH_PERCENT: "60" });
    await runHook("post-tool", "claude", {
      cwd, tool_name: "Edit", tool_input: { file_path: "src/a.ts" },
      tool_response: { is_error: true },
    }, e);
    const log = formatLog(readLog("hook-tools", e));
    expect(log).toContain("ERRORS:");
    expect(log).toContain("src/a.ts");
    expect(log).toContain("PATHS:");

    const transcript = join(root, "transcript.jsonl");
    const pad = `${JSON.stringify({ type: "user", message: { content: "y".repeat(4000) } })}\n`.repeat(40);
    writeFileSync(transcript, `${pad}${JSON.stringify({
      type: "assistant",
      message: {
        id: "low", model: "claude-opus-4-5",
        usage: { input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 10_000 },
      },
    })}\n`);
    const quiet = await runHook("prompt-submit", "claude", {
      session_id: "j2-low", cwd, prompt: "continue the work please",
      transcript_path: transcript,
    }, { ...e, ORCH_SESSION: "j2-low", ORCH_MEMORY: "off" });
    expect(quiet).toBe("");
    expect(formatLog(readLog("hook-tools", { ...e, ORCH_SESSION: "j2-low" }))).not.toContain("RESUME");

    writeFileSync(transcript, `${pad}${JSON.stringify({
      type: "assistant",
      message: {
        id: "high", model: "claude-opus-4-5",
        usage: { input_tokens: 80_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000 },
      },
    })}\n`);
    // The fresh-session nudge promises a supervisor restart: only presence has one.
    const nudge = await runHook("prompt-submit", "claude", {
      session_id: "j2", cwd, prompt: "continue the work please",
      transcript_path: transcript,
    }, { ...e, ORCH_MEMORY: "off", ORCH_PRESENCE: "1" });
    expect(nudge).toContain("CONTEXT 65%");
    expect(nudge).toContain("threshold 60%");
    expect(nudge).toContain("Do not /compact");
    expect(nudge).toContain("without --continue/--resume");
    expect(nudge).toContain("Supervisor is starting a fresh `kiba`");
    expect(nudge).not.toContain("byte");
    expect(existsSync(freshRequestPath(state))).toBe(true);
    expect(consumeFreshRequest(state)).toMatchObject({ percent: 65, threshold: 60 });
    expect(existsSync(freshRequestPath(state))).toBe(false);
    const after = formatLog(readLog("hook-tools", e));
    expect(after).toContain("RESUME");
    expect(after).toContain("NEXT:");

    const unknown = await runHook("prompt-submit", "claude", {
      session_id: "j2-unknown", cwd, prompt: "continue the work please",
      transcript_path: join(root, "missing-usage.jsonl"),
    }, { ...e, ORCH_SESSION: "j2-unknown", ORCH_MEMORY: "off" });
    expect(unknown).toBe("");
  }, 20_000);

  test("stop and session-end write a resume note when usage is above the threshold", async () => {
    const cwd = join(root, "hook-stop");
    mkdirSync(cwd, { recursive: true });
    const e = env({ ORCH_SESSION: "j-stop", ORCH_FRESH_PERCENT: "60", ORCH_MEMORY: "off" });
    const transcript = join(root, "stop.jsonl");
    writeFileSync(transcript, `${JSON.stringify({
      type: "assistant",
      message: {
        id: "hot", model: "claude-opus-4-5",
        usage: { input_tokens: 90_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 10_000 },
      },
    })}\n`);
    await runHook("stop", "claude", {
      session_id: "j-stop", cwd,
      transcript_path: transcript,
      last_assistant_message: "Still on DEV-ORCH-15, check the nightly at 22:00.",
      session_crons: [{ at: "22:00", prompt: "nightly ingest" }],
    }, e);
    const log = formatLog(readLog("hook-stop", e));
    expect(log).toContain("RESUME");
    expect(log).toContain("DEV-ORCH-15");
    expect(log).toContain("22:00");
    expect(log).toContain("nightly ingest");

    const endEnv = env({ ORCH_SESSION: "j-end", ORCH_FRESH_PERCENT: "60", ORCH_MEMORY: "off" });
    await runHook("session-end", "claude", {
      session_id: "j-end", cwd, reason: "other",
      context_window: { used_percentage: 72, context_window_size: 200_000 },
    }, endEnv);
    expect(formatLog(readLog("hook-stop", endEnv))).toContain("RESUME");
  }, 20_000);
});

describe("orch log CLI", () => {
  test("show / append / snapshot / path", () => {
    const cwd = join(root, "cli-log");
    mkdirSync(cwd, { recursive: true });
    const e = env();
    expect(logCli(["append", "--kind", "decision", "--text", "fold the helper"], e, cwd))
      .toContain("fold the helper");
    expect(logCli(["show"], e, cwd)).toContain("DECISIONS:");
    expect(logCli(["snapshot"], e, cwd)).toContain("LOG SNAPSHOT");
    expect(logCli(["path"], e, cwd).trim()).toBe(journalPath("cli-log", e));
    appendEvent({ kind: "warn", text: "daily spend at 82% of $5 ($4.10)", source: "spend" }, state);
    expect(logCli(["show"], e, cwd)).toContain("ALERTS:");
    expect(logCli(["show"], e, cwd)).toContain("daily spend at 82%");
    expect(() => logCli(["append", "--kind", "nope", "--text", "x"], e, cwd)).toThrow(/usage: orch log/);
  }, 20_000);
});

test("parseLog skips junk lines", () => {
  expect(parseLog("{}\n{\"kind\":\"error\",\"text\":\"boom\"}\nnot-json\n")).toEqual([
    { at: "", kind: "error", text: "boom" },
  ]);
});

test("lead instructions keep context continuity and point at the log and transcript", () => {
  const text = readFileSync(join(import.meta.dir, "../catalog/lead.md"), "utf8");
  expect(text).toContain("## Mission log (no compaction)");
  expect(text).toContain("Never ask the operator to open a new Kiba session because of context");
  expect(text).toContain("Claude compacts automatically");
  expect(text).toContain("the raw transcript is the");
  expect(text).toContain("source of truth");
  expect(text).toContain("~/.claude/projects/");
  expect(text).toContain("orch log append");
  expect(text).toContain("re-check real state first");
});
