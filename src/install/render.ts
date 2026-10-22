import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Profile, ROOT } from "../core/profile.ts";
import type { HarnessId } from "../harness/registry.ts";

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

const LEAD_DESCRIPTION =
  "Lead developer session agent, selected at launch with --agent marius. Never spawn it as a subagent.";

export function hookCommand(event: string, harness: "claude" | "codex" | "grok"): string {
  return `[ "$ORCH_LEAD" = 1 ] || exit 0; exec "$HOME/.local/bin/orch" hook ${event} --harness ${harness}`;
}

function hookFile(harness: "claude" | "grok"): string {
  const preMatcher = harness === "claude" ? "Bash" : "run_terminal_command";
  const postMatcher = harness === "claude" ? "Edit|MultiEdit|Write" : "search_replace|write_file|write";
  const entry = (event: string, matcher?: string) => [{
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: hookCommand(event, harness), timeout: 10 }],
  }];
  return JSON.stringify({ hooks: {
    PreToolUse: entry("pre-bash", preMatcher),
    PostToolUse: entry("post-edit", postMatcher),
    UserPromptSubmit: entry("prompt-submit"),
    Stop: entry("stop"),
  } }, null, 2) + "\n";
}

// Files written under HOME. Codex gets no agent file (`lead codex` passes the
// lead prompt as developer_instructions at launch), only an exec-policy rule.
export function render(profile: Profile, harnesses: HarnessId[]): Target[] {
  const claude = profile.lead.claude;
  const targets: Target[] = [
    {
      path: ".claude/agents/marius.md",
      harness: "claude",
      kind: "file",
      content: frontmatter({ name: "marius", description: LEAD_DESCRIPTION, model: claude.model ?? undefined, effort: claude.effort }) + body("lead.md") + "\n",
    },
    {
      // no model line (Grok drops agents whose model it does not know); lead.ts and
      // harness.ts pin the model on the command line instead
      path: ".grok/agents/marius.md",
      harness: "grok",
      kind: "file",
      content: frontmatter({ name: "marius", description: LEAD_DESCRIPTION }) + body("lead.md") + "\n",
    },
    {
      // Claude's built-in Explore inherits the lead's model (Opus): this one is pinned
      path: ".claude/agents/lead-explore.md",
      harness: "claude",
      kind: "file",
      content: frontmatter({
        name: "lead-explore",
        description: "Read-only repository explorer for the lead developer. Use to map files and flows before a change; never edits.",
        model: profile.explore?.claude ?? "sonnet",
        tools: "Read, Grep, Glob, Bash",
      }) + body("lead-explore.md") + "\n",
    },
    {
      path: ".grok/agents/lead-explore.md",
      harness: "grok",
      kind: "file",
      content: frontmatter({
        name: "lead-explore",
        description: "Read-only repository explorer for the lead developer. Use to map files and flows before a change; never edits.",
      }) + body("lead-explore.md") + "\n",
    },
    {
      // Lets a Codex lead run lane and orch outside its workspace sandbox (see the file).
      path: ".codex/rules/orch.rules",
      harness: "codex",
      kind: "file",
      content: body("codex-orch.rules") + "\n",
    },
    {
      // The profile lane runs Grok write workers under: no child network (see the file).
      path: ".grok/sandbox.toml",
      harness: "grok",
      kind: "file",
      content: body("grok-sandbox.toml") + "\n",
    },
    {
      path: ".claude/orch/lead-settings.json",
      harness: "claude",
      kind: "file",
      content: hookFile("claude"),
    },
    {
      path: ".grok/hooks/orch-lead.json",
      harness: "grok",
      kind: "file",
      content: hookFile("grok"),
    },
    { path: ".local/bin/lane", kind: "symlink", content: join(ROOT, "src", "lane.ts") },
    { path: ".local/bin/lead", kind: "symlink", content: join(ROOT, "src", "lead.ts") },
    { path: ".local/bin/marius", kind: "symlink", content: join(ROOT, "src", "lead.ts") },
    { path: ".local/bin/orch", kind: "symlink", content: join(ROOT, "src", "orch.ts") },
  ];
  return targets.filter((target) => !target.harness || harnesses.includes(target.harness));
}

export function leadPrompt(): string {
  return body("lead.md");
}
