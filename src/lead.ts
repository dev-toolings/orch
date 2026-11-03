#!/usr/bin/env -S bun --no-env-file
// kiba|lead [claude] [harness args...]: start Kiba, the only lead, natively on
// Claude Code (`claude --agent kiba`). Kiba runs on Claude only: Codex and
// Grok are lane workers and reviewers. `kiba --conductor` prints the status of
// orch serve, the conductor. The session gets ORCH_LEAD, ORCH_HARNESS,
// ORCH_CONDUCTOR and ORCH_SESSION so `orch mem` knows who writes.
// --no-env-file: Bun must not load the .env of the directory the lead starts
// in into the session.
import { spawn } from "node:child_process";
import { HARNESSES, type Harness, loadProfile, ROOT } from "./core/profile.ts";
import { loadPolicy, resolveLeadPolicy } from "./core/policy.ts";
import { kibaProfile, nativeChoice, nativeKibaArgv, withLeadOverride } from "./kiba/native.ts";
import { detect, onPath, type Which } from "./harness/registry.ts";
import { legacyNotice } from "./core/project.ts";
import { codeRevision, recordLaunch } from "./core/lead-pulse.ts";

export const CLAUDE_ONLY = "Kiba runs on Claude only; Codex and Grok are lane workers and reviewers";

// A first argument naming a harness: claude is accepted, codex and grok are refused.
export function leadArgs(args: string[]): { harness: Harness; extra: string[] } {
  const first = args[0];
  if (typeof first === "string" && (HARNESSES as string[]).includes(first)) return { harness: first as Harness, extra: args.slice(1) };
  return { harness: "claude", extra: args };
}

export function leadArgv(profileName?: string, extra: string[] = []): string[] {
  if (extra.includes("--yolo")) {
    extra = extra.filter((arg) => arg !== "--yolo");
    if (!extra.includes("--dangerously-skip-permissions")) extra.push("--dangerously-skip-permissions");
  }
  const profile = loadProfile(kibaProfile(profileName));
  const lead = resolveLeadPolicy(loadPolicy());
  return nativeKibaArgv(withLeadOverride(nativeChoice(profile), lead), extra);
}

// Model and effort a lead argv runs with.
export function argvChoice(argv: string[]): { model: string | null; effort: string | null } {
  let model: string | null = null;
  let effort: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[i + 1] ?? null;
    if (argv[i] === "--effort") effort = argv[i + 1] ?? null;
  }
  return { model, effort };
}

// What Kiba would start with now (no operator extras).
export function currentLeadChoice(): { model: string | null; effort: string | null } {
  return argvChoice(leadArgv());
}

export function leadGuard(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ORCH_LEAD === "1") return "lead: a lead session cannot start another lead; use a plain terminal or `env -u ORCH_LEAD kiba`";
  return env.ORCH_LANE === "1" ? "lead: a lane worker cannot start a lead session" : null;
}

export function leadAvailability(which: Which = onPath): string | null {
  const detected = detect(which);
  return detected.includes("claude") ? null : `lead: claude is not installed (detected: ${detected.join(", ") || "none"}); ${CLAUDE_ONLY}`;
}

// Keep the launcher alive until the harness exits, including after a stop.
export async function runLeadChild(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    // Terminal Ctrl+C already reaches the harness in our foreground group.
    const handler = () => { if (signal !== "SIGINT") child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal as "SIGTERM"] ?? 1) : 1)));
      child.once("error", reject);
    });
  } finally {
    signals.forEach((signal, i) => process.off(signal, handlers[i]));
  }
}

if (import.meta.main) {
  const { harness, extra } = leadArgs(process.argv.slice(2));
  if (harness !== "claude") {
    console.error(`kiba ${harness}: ${CLAUDE_ONLY}`);
    process.exit(2);
  }
  if (extra.includes("--conductor")) {
    // The dispatch-only conductor is retired: orch serve conducts.
    process.stdout.write((await import("./serve/cli.ts")).serveStatus());
    process.exit(0);
  }
  const refusal = leadGuard();
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  const unavailable = leadAvailability();
  if (unavailable) {
    console.error(unavailable);
    process.exit(1);
  }
  const legacy = legacyNotice();
  if (legacy) console.error(`kiba: ${legacy}`);
  const full = leadArgv(undefined, extra);
  const leadPolicy = resolveLeadPolicy(loadPolicy());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCH_LEAD: "1",
    ORCH_HARNESS: "claude",
    ORCH_CONDUCTOR: "native",
    ORCH_SESSION: `claude-${Date.now().toString(36)}`,
  };
  if (leadPolicy.autocompact_tokens != null) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(leadPolicy.autocompact_tokens);
  // The launcher pid keys this lead's records (src/core/lead-pulse.ts):
  // its hooks write the pulse under it, install compares its launch record.
  env.ORCH_LEAD_PID = String(process.pid);
  try {
    recordLaunch({
      pid: process.pid, harness: "claude", conductor: "kiba", execution: "native", rev: codeRevision(ROOT), ...argvChoice(full),
      cwd: process.cwd(), started: new Date().toISOString(), presence: false,
    });
  } catch { /* the registry is informative: never blocks a launch */ }
  process.exit(await runLeadChild(full, env));
}
