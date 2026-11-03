import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Profile, ROOT } from "../core/profile.ts";
import type { HarnessId } from "../harness/registry.ts";
import { serveUnit } from "../serve/unit.ts";
import { routineUnits } from "../routines/routines.ts";
import { loadPolicy, resolveLogsPolicy } from "../core/policy.ts";
import { logsPruneUnits } from "../logs/prune.ts";
import { loadHookPolicy } from "../core/hook-policy.ts";
import { ORCH_GUARD_PATHS } from "../core/sensitive.ts";
import { editRules } from "./claude-rules.ts";

export interface Target {
  path: string; // relative to HOME
  kind: "file" | "symlink";
  content: string; // file body, or symlink target
  harness?: HarnessId;
}

const body = (name: string) => readFileSync(join(ROOT, "catalog", name), "utf8").trimEnd();

function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// Kiba runs on Claude only, as the named native agent (catalog/kiba-native.md).
const CLAUDE_LEAD_DESCRIPTION =
  "Kiba, the native developer with memory and optional lanes. Never spawn it as a subagent.";

// `orch hook statusline`, for an operator who wires it by hand. The lead
// settings set no statusLine: a lead keeps the operator's own, untouched
// (operator's call, 2026-11-02), so the dash's Claude quota snapshot is only
// fed where this command is the statusLine. Same periodic refresh as the operator's own statusLine (ccstatusline): a
// chained line that shows time or memory must not freeze between events.
export const STATUSLINE_REFRESH_SECONDS = 10;

export function statuslineCommand(): string {
  return 'exec "$HOME/.local/bin/orch" hook statusline --harness claude';
}

// Every tool but Edit|Write: a JavaScript regex for Claude Code's matcher (any
// character outside letters, digits, "_-, |" selects the regex path, tested
// unanchored with RegExp.test).
export const POST_TOOL_BACKGROUND_MATCHER = "^(?!Edit$|Write$)";

// How a lead hook runs: the entry src/hooks/hook.ts, found through the
// installed `orch` symlink so a moved checkout needs no re-render, run by
// `bun` directly, never through the `orch` CLI (its static imports cost 65 ms
// on every tool call). One replaceable unit: the benchmarks substitute their
// source checkout for it (src/checks/conso.ts, sourceHookSettings).
export const HOOK_ENTRY = 'bun --no-env-file "$(dirname "$(readlink -f "$HOME/.local/bin/orch")")/hooks/hook.ts"';

export function hookCommand(event: string): string {
  return `[ "$ORCH_LEAD" = 1 ] || exit 0; exec ${HOOK_ENTRY} ${event} --harness claude`;
}

// No PreToolUse hook (operator's decision): the native lead's guards are the
// settings-level deny rules generated from the hook policy. Lane workers keep
// their own PreToolUse scope guard (src/lanes/guard.ts).
function hookFile(): string {
  const entry = (event: string, matcher?: string, background = false) => [{
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: hookCommand(event), timeout: 10, ...(background ? { async: true } : {}) }],
  }];
  const hooks = {
    SessionStart: [
      ...entry("session-start", "startup"),
      ...entry("session-start", "resume"),
      ...entry("session-start", "compact"),
    ],
    SessionEnd: entry("session-end"),
    SubagentStart: entry("subagent-start", undefined, true),
    SubagentStop: entry("subagent-stop", undefined, true),
    // One PostToolUse process per tool call. Edit|Write stays synchronous
    // (the edit count and its nudge reach the current turn); every other tool
    // runs the same hook in the background (`async`: nothing to deliver, no wall
    // time on the call). src/hooks/hook.ts folds post-edit into post-tool.
    PostToolUse: [...entry("post-tool", "Edit|Write"), ...entry("post-tool", POST_TOOL_BACKGROUND_MATCHER, true)],
    UserPromptSubmit: entry("prompt-submit"),
    Stop: entry("stop"),
  };
  return JSON.stringify({
    permissions: { allow: CLAUDE_LEAD_ALLOW, ask: [], deny: claudeLeadDeny() },
    autoMemoryEnabled: false,
    hooks,
  }, null, 2) + "\n";
}

export const LEAD_SETTINGS_PATH = ".claude/orch/lead-settings.json";

// The native lead's settings: passed inline by `kiba` (src/kiba/native.ts)
// and installed at LEAD_SETTINGS_PATH for `orch doctor` and manual sessions.
export function leadSettings(): string {
  return hookFile();
}

// Narrow rules survive auto mode because broad code-execution rules are
// dropped, so the classifier never blocks the lead's own memory, docs or lane
// bookkeeping. `lane run` stays out: it runs
// the spec's SETUP and VERIFY on the host, so the classifier or the operator
// judges each one. Subcommands are listed one by one: a wildcard would also
// pass `lane gc --drop <id>`, which deletes a worktree that may hold unsaved
// work, and any write-capable subcommand added later.
const CLAUDE_LEAD_ALLOW = [
  ...["search", "recent", "show", "add", "supersede", "forget", "review"].map((sub) => `Bash(orch mem ${sub} *)`),
  "Bash(orch docs search *)",
  "Bash(orch docs status)",
  // Read-only operations, so the operator can ask from the phone.
  "Bash(orch ops usage)",
  "Bash(orch ops usage *)",
  "Bash(orch ops check)",
  "Bash(orch routine status)",
  "Bash(orch brain status)",
  "Bash(orch presence status)",
  "Bash(lane review *)",
  "Bash(lane status)",
  "Bash(lane status *)",
  "Bash(lane gc)",
];

// Settings cannot express permission modes: only unconditional denies of the
// hook policy belong here. The native lead has no PreToolUse hook, so asks
// and mode-specific rules are left to Claude Code's own permission modes.
const CLAUDE_LEAD_READ_DENY_PATHS = [
  ".env.local",
  ".env.*.local",
  ".env.prod",
  ".env.production",
  "**/.env.local",
  "**/.env.*.local",
  "**/.env.prod",
  "**/.env.production",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",
  "**/credentials",
  "**/credentials.*",
  "~/.ssh/**",
  "~/.aws/**",
  "~/.claude/.credentials*",
  "~/.codex/auth.json",
  "~/.grok/auth.json",
  "~/.grok/auth",
  "~/.netrc",
  "**/.netrc",
  "~/.npmrc",
  "**/.npmrc",
  "**/*.token",
  "**/token",
  "**/tokens",
];

function claudeLeadDeny(): string[] {
  const { permissions } = loadHookPolicy();
  const denies = (id: "secrets.read" | "secrets.edit" | "orch.guard-files") =>
    permissions[id].bypass === "deny" && permissions[id].default === "deny";
  return [
    ...(denies("secrets.read") ? CLAUDE_LEAD_READ_DENY_PATHS.map((path) => `Read(${path})`) : []),
    ...(denies("secrets.edit") ? editRules(CLAUDE_LEAD_READ_DENY_PATHS) : []),
    ...(denies("orch.guard-files") ? editRules([...ORCH_GUARD_PATHS]) : []),
  ];
}

// Lead and worker files written under HOME, filtered to detected harnesses.
export function render(profile: Profile, harnesses: HarnessId[]): Target[] {
  const logs = resolveLogsPolicy(loadPolicy());
  const targets: Target[] = [
    {
      path: ".claude/agents/kiba.md",
      harness: "claude",
      kind: "file",
      content: frontmatter({ name: "kiba", description: CLAUDE_LEAD_DESCRIPTION, model: profile.lead.claude.model ?? undefined, effort: profile.lead.claude.effort }) + body("kiba-native.md") + "\n",
    },
    {
      // Overrides Claude Code's built-in Explore (same name) and pins it to haiku.
      path: ".claude/agents/Explore.md",
      harness: "claude",
      kind: "file",
      content: frontmatter({
        name: "Explore",
        description: "Read-only repository explorer. Use to map files and flows before a change; never edits.",
        model: profile.explore?.claude ?? "haiku",
        tools: "Read, Grep, Glob",
      }) + body("lead-explore.md") + "\n",
    },
    {
      path: ".claude/agents/lead-explore.md",
      harness: "claude",
      kind: "file",
      content: frontmatter({
        name: "lead-explore",
        description: "Read-only repository explorer for the lead developer. Uses the Explore (haiku) override.",
        model: profile.explore?.claude ?? "haiku",
        tools: "Read, Grep, Glob",
      }) + body("lead-explore.md") + "\n",
    },
    {
      // The profile lane runs Grok write workers under: no child network (see the file).
      path: ".grok/sandbox.toml",
      harness: "grok",
      kind: "file",
      content: body("grok-sandbox.toml") + "\n",
    },
    {
      path: LEAD_SETTINGS_PATH,
      harness: "claude",
      kind: "file",
      content: leadSettings(),
    },
    { path: ".local/bin/lane", kind: "symlink", content: join(ROOT, "src", "lane.ts") },
    { path: ".local/bin/lead", kind: "symlink", content: join(ROOT, "src", "lead.ts") },
    { path: ".local/bin/kiba", kind: "symlink", content: join(ROOT, "src", "lead.ts") },
    { path: ".local/bin/orch", kind: "symlink", content: join(ROOT, "src", "orch.ts") },
    // Written, never enabled: `systemctl --user enable --now` is the operator's.
    // orch serve runs Claude workers: opt-in, never enabled by install.
    { path: `.config/systemd/user/${serveUnit().name}`, harness: "claude", kind: "file", content: serveUnit().content },
    ...routineUnits().map((u): Target => ({ path: `.config/systemd/user/${u.name}`, kind: "file", content: u.content })),
    ...logsPruneUnits(logs.prune_at).map((u): Target => ({ path: `.config/systemd/user/${u.name}`, kind: "file", content: u.content })),
  ];
  return targets.filter((target) => !target.harness || harnesses.includes(target.harness));
}

export function leadPrompt(): string {
  return body("lead.md");
}
