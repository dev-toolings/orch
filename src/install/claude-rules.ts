// The one list of Claude Code permission rule tool names orch may render.
// Claude Code 2.1.x dropped the MultiEdit tool and checks every file write
// through Edit(...) rules: a Write(<path>) rule "never matches" and a
// MultiEdit rule "matches no tool", and both print a warning at start-up.
// Rendered settings, worker argv, `orch doctor` and the lead launch all go
// through this module, so a renamed tool is fixed here once.

// Tool names a rendered permission rule may use (bare or with a specifier).
export const CLAUDE_RULE_TOOLS = [
  "Agent", "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Task", "WebFetch", "WebSearch", "Write",
] as const;

// Write stays valid only bare (the tool exists: `--disallowedTools Write`);
// with a path it must be Edit(<path>).
const PATHLESS_ONLY = new Set(["Write"]);

// Names removed from Claude Code: a rule on them always is stale.
export const STALE_RULE_TOOLS = ["MultiEdit"] as const;

const RULE = /^([A-Za-z]+)(?:\((.*)\))?$/;

// Why a rule is stale, or null when Claude Code accepts it. MCP rules
// (mcp__server__tool) are outside this list and never flagged.
export function staleReason(rule: string): string | null {
  if (rule.startsWith("mcp__")) return null;
  const m = RULE.exec(rule);
  if (!m) return "unparsable rule";
  const [, tool, spec] = m;
  if ((STALE_RULE_TOOLS as readonly string[]).includes(tool)) return `${tool} tool no longer exists`;
  if (!(CLAUDE_RULE_TOOLS as readonly string[]).includes(tool)) return `unknown tool ${tool}`;
  if (spec !== undefined && PATHLESS_ONLY.has(tool)) return `use Edit(${spec})`;
  return null;
}

export function staleRules(rules: string[]): string[] {
  return rules.filter((rule) => staleReason(rule) !== null);
}

// One Edit rule per protected path, in order, deduplicated.
export function editRules(paths: string[]): string[] {
  return [...new Set(paths)].map((path) => `Edit(${path})`);
}

// Same rules with Write(<path>) moved to Edit(<path>) and MultiEdit dropped
// (Edit(<path>) covers it), deduplicated; anything else is kept as is.
export function migrateRules(rules: string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const m = RULE.exec(rule);
    let next: string | null = rule;
    if (m && m[1] === "MultiEdit") next = m[2] === undefined ? null : `Edit(${m[2]})`;
    else if (m && m[1] === "Write" && m[2] !== undefined) next = `Edit(${m[2]})`;
    if (next !== null && !out.includes(next)) out.push(next);
  }
  return out;
}

type Permissions = { allow?: unknown; ask?: unknown; deny?: unknown };
const BUCKETS = ["allow", "ask", "deny"] as const;

const ruleList = (value: unknown): string[] => Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];

// Stale rules of a parsed settings object, as "bucket: rule".
export function staleSettingsRules(settings: { permissions?: Permissions } | null | undefined): string[] {
  const perms = settings?.permissions ?? {};
  return BUCKETS.flatMap((bucket) => staleRules(ruleList(perms[bucket])).map((rule) => `${bucket}: ${rule}`));
}
