import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestClaudeTranscriptUsage } from "../src/core/spend-usage.ts";
import { readSpend } from "../src/core/policy.ts";

const usage = { input_tokens: 2, output_tokens: 538, cache_read_input_tokens: 44624, cache_creation_input_tokens: 1243 };
const block = (id: string, at: string) =>
  `${JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage } })}\n`;

describe("Claude transcript spend", () => {
  test("a message split over several lines and two reads is recorded once", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-spend-"));
    const transcript = join(state, "session.jsonl");
    writeFileSync(transcript, block("msg_1", "2026-11-02T08:51:16.857Z") + block("msg_1", "2026-11-02T08:51:16.862Z"));
    expect(ingestClaudeTranscriptUsage({ transcriptPath: transcript, project: "lab", state })).toBe(1);
    appendFileSync(transcript, block("msg_1", "2026-11-02T08:51:17.001Z") + block("msg_2", "2026-11-02T08:52:00.000Z"));
    expect(ingestClaudeTranscriptUsage({ transcriptPath: transcript, project: "lab", state })).toBe(1);
    expect(readSpend(state).map((row) => (row as { message?: string }).message)).toEqual(["msg_1", "msg_2"]);
  });
});
