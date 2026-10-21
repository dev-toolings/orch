#!/usr/bin/env bun
// lead <claude|codex|grok> [harness args...]: start the harness directly with
// the lead profile. Claude and Grok select the installed lead agent; Codex has
// no agent file, so the lead prompt goes in as developer_instructions. The
// session gets ORCH_LEAD and ORCH_HARNESS so `orch mem` knows who writes.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESSES, type Harness, loadProfile } from "./core/profile.ts";
import { hookCommand, leadPrompt } from "./install/render.ts";

function codexHookOverride(event: string, handlerEvent: string, matcher?: string): string {
  const match = matcher === undefined ? "" : `matcher = ${JSON.stringify(matcher)}, `;
  const group = `[{ ${match}hooks = [{ type = "command", command = ${JSON.stringify(hookCommand(handlerEvent, "codex"))}, timeout = 10 }] }]`;
  return `hooks.${event}=${group}`;
}

// The model the operator asked for: a --model/-m in the extra args wins over
// the profile.
function requestedModel(extra: string[], fallback?: string | null): string | undefined {
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === "--model" || extra[i] === "-m") return extra[i + 1];
    if (extra[i].startsWith("--model=")) return extra[i].slice("--model=".length);
  }
  return fallback ?? undefined;
}

// Pure: harness argv for a lead session. Codex never tells the model which
// model it runs, so the name goes after the lead prompt: the prompt itself
// stays a stable prefix.
export function leadArgv(h: Harness, profileName?: string, extra: string[] = []): string[] {
  const choice = loadProfile(profileName).lead[h];
  if (h === "codex") {
    const model = requestedModel(extra, choice.model);
    const text = model ? `${leadPrompt()}\n\nYour harness reports this model: ${model}.` : leadPrompt();
    const out = ["codex", "-c", `developer_instructions=${JSON.stringify(text)}`];
    out.push("-c", codexHookOverride("PreToolUse", "pre-bash", "Bash"));
    out.push("-c", codexHookOverride("PostToolUse", "post-edit", "Edit|Write"));
    out.push("-c", codexHookOverride("UserPromptSubmit", "prompt-submit"));
    out.push("-c", codexHookOverride("Stop", "stop"));
    if (choice.model && !requestedModel(extra)) out.push("--model", choice.model);
    if (choice.effort) out.push("-c", `model_reasoning_effort="${choice.effort}"`);
    // yolo: no approval prompt and no sandbox, like the Claude lead's
    // bypassPermissions. Any sandbox or approval flag the operator passes wins.
    const chosen = extra.some((a) => ["-s", "--sandbox", "-a", "--ask-for-approval", "--full-auto", "--yolo",
      "--dangerously-bypass-approvals-and-sandbox"].includes(a.split("=")[0]));
    if (choice.permission_mode === "yolo" && !chosen) out.push("--dangerously-bypass-approvals-and-sandbox");
    return out;
  }
  const out = [h, "--agent", "lead"];
  if (h === "claude") {
    out.push("--settings", join(process.env.HOME ?? homedir(), ".claude", "orch", "lead-settings.json"));
    if (choice.model) out.push("--model", choice.model);
    if (choice.effort) out.push("--effort", choice.effort);
    const asked = extra.some((a) => a.startsWith("--permission-mode") || a === "--dangerously-skip-permissions");
    if (choice.permission_mode && !asked) out.push("--permission-mode", choice.permission_mode);
  }
  if (h === "grok") {
    if (choice.model && !requestedModel(extra)) out.push("--model", choice.model);
    const effortAsked = extra.some((a) => ["--reasoning-effort", "--effort"].includes(a.split("=")[0]));
    if (choice.effort && !effortAsked) out.push("--reasoning-effort", choice.effort);
  }
  return out;
}

export function leadGuard(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ORCH_LANE === "1" ? "lead: a lane worker cannot start a lead session" : null;
}

if (import.meta.main) {
  const refusal = leadGuard();
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  const [h, ...rest] = process.argv.slice(2);
  if (!(HARNESSES as string[]).includes(h)) {
    console.error("usage: lead claude|codex|grok [harness args...]");
    process.exit(2);
  }
  const full = [...leadArgv(h as Harness, undefined, rest), ...rest];
  const env = { ...process.env, ORCH_LEAD: "1", ORCH_HARNESS: h, ORCH_SESSION: `${h}-${Date.now().toString(36)}` };
  const r = spawnSync(full[0], full.slice(1), { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
