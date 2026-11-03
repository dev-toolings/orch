#!/usr/bin/env -S bun --no-env-file
// PreToolUse hook of an `orch serve` worker on Bash: publication belongs to
// the outbox only. The settings' deny rules already refuse these commands;
// this hook also catches them inside compound commands (`cd x && git push`).
import { readFileSync } from "node:fs";

const PUBLISH = /(^|[\s;&|()`$])(git\s+(-[Cc]\s+\S+\s+)*push\b|gh\s+(pr|api|issue|release|repo\s+(create|edit|delete))\b)/;

export function publishDecision(input: unknown): string | null {
  const rec = (input && typeof input === "object" ? input : {}) as { tool_name?: unknown; tool_input?: { command?: unknown } };
  if (rec.tool_name !== "Bash") return null;
  const command = typeof rec.tool_input?.command === "string" ? rec.tool_input.command : "";
  if (!PUBLISH.test(command)) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "orch serve worker: publishing (push, PR, comment, API) is the outbox's; finish the change and report" } });
}

if (import.meta.main) {
  let input: unknown = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const out = publishDecision(input);
  if (out) process.stdout.write(`${out}\n`);
}
