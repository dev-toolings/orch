import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, classifyLog, claudeResult, parseWorkerOutput, sessionId, workerArgv } from "../src/harness/harness.ts";
import { PROGRESS_MAX_BYTES, ProgressTracker, readLaneProgress, SNIPPET_MAX, watchProgress } from "../src/lanes/progress.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "stream-json", name), "utf8");
const run = fixture("claude-run.jsonl");
const timedOut = fixture("claude-timeout.jsonl");
const tmp = mkdtempSync(join(tmpdir(), "orch-progress-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("claude stream-json output", () => {
  test("a write worker streams events; a read-only consult keeps the json object", () => {
    const opts = { cwd: "/wt", promptPath: "/p", lastMessagePath: "/l" };
    const write = workerArgv("claude", { model: "sonnet", effort: "medium" }, { ...opts, readOnly: false }).argv.join(" ");
    expect(write).toContain("-p --output-format stream-json --verbose");
    expect(write).toContain("--effort medium");
    const read = workerArgv("claude", { model: "haiku" }, { ...opts, readOnly: true }).argv.join(" ");
    expect(read).toContain("-p --output-format json");
    expect(read).not.toContain("stream-json");
  });

  test("the final result event gives the same message, usage, cost, model and session as the json format", () => {
    const fromStream = parseWorkerOutput("claude", `${run}stderr: some warning\n`, "");
    const json = run.trimEnd().split("\n").at(-1)!;
    expect(fromStream).toEqual(parseWorkerOutput("claude", json, ""));
    expect(fromStream).toEqual({
      message: "All ACCEPT criteria are met.\nLANE: done",
      model: "claude-sonnet-5-5",
      usage: { input: 120, cached: 3500, cacheRead: 3000, cacheCreation: 500, output: 80, total: 3700, costUsd: 0.1234 },
    });
    expect(sessionId(run)).toBe("sess-1");
  });

  test("a stream cut before its result (timeout, crash) has no result, like an empty json run", () => {
    expect(claudeResult(timedOut)).toBeUndefined();
    expect(parseWorkerOutput("claude", timedOut, "")).toEqual(parseWorkerOutput("claude", "", ""));
    expect(sessionId(timedOut)).toBeUndefined();
  });

  test("classify reads stderr and the result, not the streamed transcript", () => {
    // the fixture's tool output says "Permission denied": not a denial of the run
    expect(classify({ code: 0, timedOut: false, changed: false, verifyOk: true, log: run })).toBe("blocked");
    expect(classify({ code: 0, timedOut: false, changed: false, verifyOk: true, log: classifyLog("claude", run) })).toBe("noop");
    expect(classifyLog("claude", `${run}sandbox: permission denied\n`)).toContain("sandbox: permission denied");
    expect(classifyLog("codex", run)).toBe(run);
  });
});

describe("progress", () => {
  const base = { harness: "claude", model: "sonnet", effort: "medium", started: "2026-11-01T10:00:00.000Z", cwd: "/wt" };

  test("VERIFY and targeted test invocations count, including Codex wrappers and repeated events", () => {
    const claude = new ProgressTracker({ ...base, verify: "bun test" });
    const event = (id: string, command: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }) + "\n";
    claude.feed(event("read", "git status"));
    expect(claude.snapshot()).toMatchObject({ verifyRuns: 0, lastVerifyTurn: null });
    claude.feed(event("check", "bun test"));
    expect(claude.snapshot()).toMatchObject({ verifyRuns: 1, lastVerifyTurn: 2 });
    claude.feed(event("targeted", "bun test tests/focused.test.ts"));
    expect(claude.snapshot()).toMatchObject({ verifyRuns: 2, lastVerifyTurn: 3, stepsSinceVerify: 0 });
    const codex = new ProgressTracker({ ...base, harness: "codex", verify: "bun test" });
    for (const type of ["item.started", "item.completed"]) codex.feed(JSON.stringify({ type, item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'bun test'" } }) + "\n");
    expect(codex.snapshot()).toMatchObject({ verifyRuns: 1, lastVerifyTurn: 0 });
    expect(JSON.stringify(codex.snapshot())).not.toContain("bun test");
    codex.feed(JSON.stringify({ type: "item.started", item: { id: "c2", type: "command_execution", command: "git status" } }) + "\n");
    expect(codex.snapshot()).toMatchObject({ turns: 0, stepsSinceVerify: 1 });
  });

  test("tracks turns, last tool and file, distinct files touched and a bounded snippet, across split chunks", () => {
    const t = new ProgressTracker(base);
    t.setPhase("worker");
    const cut = run.indexOf("tu_3") ;
    t.feed(run.slice(0, cut));
    expect(t.snapshot().filesTouched).toBe(1);
    t.feed(run.slice(cut));
    const p = t.snapshot(new Date("2026-11-01T10:02:05.000Z"));
    expect(p).toMatchObject({
      v: 1, harness: "claude", model: "claude-sonnet-5-5", effort: "medium", phase: "worker",
      elapsedS: 125, turns: 7, toolCalls: 5, lastTool: "Bash", lastFile: null, filesTouched: 2,
    });
    expect(p.lastText!.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(p.lastText).toStartWith("All ACCEPT criteria are met");
    const text = JSON.stringify(p);
    for (const leak of ["hunter2", "SECRET_TOKEN", "OLD-BODY", "NEW-BODY", "FILE-CONTENT", "Permission denied"]) expect(text).not.toContain(leak);
  });

  test("file paths are made relative to the worktree; a snippet holding a secret is masked", () => {
    const t = new ProgressTracker(base);
    t.feed(`${JSON.stringify({ type: "assistant", message: { id: "m", content: [
      { type: "text", text: "key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
      { type: "tool_use", name: "Edit", input: { file_path: "/wt/src/x.ts" } },
    ] } })}\n`);
    expect(t.snapshot()).toMatchObject({ lastTool: "Edit", lastFile: "src/x.ts", filesTouched: 1 });
    expect(t.snapshot().lastText).not.toContain("sk-ant");
  });

  test("watchProgress writes on start and phase changes and follows the appended log", () => {
    const dir = mkdtempSync(join(tmp, "lane-"));
    const log = join(dir, "worker.log");
    writeFileSync(log, "");
    const w = watchProgress({ dir, logPath: log, tracker: new ProgressTracker(base), intervalMs: 60_000 });
    expect(readLaneProgress(dir)).toMatchObject({ phase: "setup", turns: 0, toolCalls: 0 });
    w.phase("worker");
    appendFileSync(log, timedOut);
    w.phase("verify");
    expect(readLaneProgress(dir)).toMatchObject({ phase: "verify", turns: 5, toolCalls: 5, lastTool: "Bash", filesTouched: 2 });
    w.stop();
    expect(readLaneProgress(dir)?.phase).toBe("done");
  });

  test("readLaneProgress tolerates a missing, corrupt, foreign or oversized file", () => {
    const dir = mkdtempSync(join(tmp, "read-"));
    expect(readLaneProgress(dir)).toBeNull();
    writeFileSync(join(dir, "progress.json"), "{not json");
    expect(readLaneProgress(dir)).toBeNull();
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ v: 2, harness: "claude", started: "x" }));
    expect(readLaneProgress(dir)).toBeNull();
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ v: 1, harness: "claude", started: "s", lastText: "x".repeat(PROGRESS_MAX_BYTES) }));
    expect(readLaneProgress(dir)).toBeNull();
    writeFileSync(join(dir, "progress.json"), JSON.stringify({ v: 1, harness: "claude", started: "s", turns: -3, lastText: "y".repeat(500), extra: "dropped" }));
    const p = readLaneProgress(dir)!;
    expect(p.turns).toBe(0);
    expect(p.lastText!.length).toBe(SNIPPET_MAX);
    expect(p).not.toHaveProperty("extra");
  });
});
