import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Profile, ROOT } from "./profile.ts";

export interface Target {
  path: string; // relative to HOME
  kind: "file" | "symlink";
  content: string; // file body, or symlink target
}

const body = (name: string) => readFileSync(join(ROOT, "catalog", name), "utf8").trimEnd();

function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

const LEAD_DESCRIPTION =
  "Lead developer session agent, selected at launch with --agent lead. Never spawn it as a subagent.";

// Files written under HOME. Codex gets no agent file (`lead codex` passes the
// lead prompt as developer_instructions at launch), only an exec-policy rule.
export function render(profile: Profile): Target[] {
  const claude = profile.lead.claude;
  return [
    {
      path: ".claude/agents/lead.md",
      kind: "file",
      content: frontmatter({ name: "lead", description: LEAD_DESCRIPTION, model: claude.model ?? undefined, effort: claude.effort }) + body("lead.md") + "\n",
    },
    {
      // no model line: Grok workers and leads inherit the session model
      path: ".grok/agents/lead.md",
      kind: "file",
      content: frontmatter({ name: "lead", description: LEAD_DESCRIPTION }) + body("lead.md") + "\n",
    },
    {
      path: ".grok/agents/lead-explore.md",
      kind: "file",
      content: frontmatter({
        name: "lead-explore",
        description: "Read-only repository explorer for the lead developer. Use to map files and flows before a change; never edits.",
      }) + body("lead-explore.md") + "\n",
    },
    {
      // Lets a Codex lead run lane and orch outside its workspace sandbox (see the file).
      path: ".codex/rules/orch.rules",
      kind: "file",
      content: body("codex-orch.rules") + "\n",
    },
    {
      // The profile lane runs Grok write workers under: no child network (see the file).
      path: ".grok/sandbox.toml",
      kind: "file",
      content: body("grok-sandbox.toml") + "\n",
    },
    { path: ".local/bin/lane", kind: "symlink", content: join(ROOT, "src", "lane.ts") },
    { path: ".local/bin/lead", kind: "symlink", content: join(ROOT, "src", "lead.ts") },
    { path: ".local/bin/orch", kind: "symlink", content: join(ROOT, "src", "orch.ts") },
  ];
}

export function leadPrompt(): string {
  return body("lead.md");
}
