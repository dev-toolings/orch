#!/usr/bin/env bun
// lead <claude|codex|grok> [harness args...]: start the harness directly with
// the lead profile. Claude and Grok select the installed lead agent; Codex has
// no agent file, so the lead prompt goes in as developer_instructions. The
// session gets ORCH_LEAD and ORCH_HARNESS so `orch mem` knows who writes.
import { spawnSync } from "node:child_process";
import { HARNESSES, type Harness, loadProfile } from "./profile.ts";
import { leadPrompt } from "./render.ts";

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
    if (choice.model && !requestedModel(extra)) out.push("--model", choice.model);
    if (choice.effort) out.push("-c", `model_reasoning_effort="${choice.effort}"`);
    return out;
  }
  const out = [h, "--agent", "lead"];
  if (h === "claude") {
    if (choice.model) out.push("--model", choice.model);
    if (choice.effort) out.push("--effort", choice.effort);
  }
  return out;
}

if (import.meta.main) {
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
