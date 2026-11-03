import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_RULE_TOOLS, migrateRules, staleReason, staleRules } from "../src/install/claude-rules.ts";
import { leadSettingsStatus, refreshLeadSettings } from "../src/install/lead-settings.ts";
import { apply, readManifest, recordEntry, sha } from "../src/install/manifest.ts";
import { LEAD_SETTINGS_PATH, leadSettings, render } from "../src/install/render.ts";
import { doctorChecks } from "../src/install/doctor.ts";
import { CLAUDE_READ_TOOLS, CLAUDE_WRITE_WORKER, workerArgv } from "../src/harness/harness.ts";
import { loadProfile } from "../src/core/profile.ts";

const settings = () => JSON.parse(leadSettings());
const ruleTool = (rule: string) => /^([A-Za-z]+)/.exec(rule)![1];

// Paths the lead settings protected with Write(...) rules before Claude Code
// moved file writes to Edit(...) rules; each must keep an Edit rule in the same bucket.
const FORMER_WRITE = {
  deny: [
    ".env.local", ".env.*.local", ".env.prod", ".env.production", "**/.env.local", "**/.env.*.local",
    "**/*.pem", "**/*.key", "**/id_rsa*", "**/credentials", "~/.ssh/**", "~/.aws/**",
  ],
  // Cooperative policy (src/core/hook-policy.ts): orch guard files and the
  // former ask paths are decided by the pre-bash hook at call time, never by
  // a settings rule (an ask rule prompts even in bypassPermissions).
  cooperative: [
    "catalog/policy.yaml", ".claude/orch/lead-settings.json", ".claude/settings.json", ".grok/hooks/orch.json",
    "src/hooks/hook.ts", "src/core/sensitive.ts", "src/install/render.ts",
    "CLAUDE.md", "AGENTS.md", ".github/**", ".claude/**", "package.json", "orch.yaml", "catalog/lead.md",
  ],
};

// Arguments of every --allowedTools / --disallowedTools flag in a Claude argv.
function argvRules(argv: string[]): string[] {
  const out: string[] = [];
  let inList = false;
  for (const arg of argv) {
    if (arg === "--allowedTools" || arg === "--disallowedTools") inList = true;
    else if (arg.startsWith("-")) inList = false;
    else if (inList) out.push(arg);
  }
  return out;
}

function temp() {
  const root = mkdtempSync(join(tmpdir(), "claude-rules-"));
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home);
  return { root, home, state, file: join(home, LEAD_SETTINGS_PATH) };
}

const OLD = JSON.stringify({ permissions: { allow: [], ask: ["Write(CLAUDE.md)", "MultiEdit(CLAUDE.md)"], deny: ["Write(.env.local)"] } }, null, 2) + "\n";

describe("Claude permission rule names", () => {
  test("rendered lead rules use only known tools, never MultiEdit or Write(<path>)", () => {
    const { permissions } = settings();
    const all: string[] = [...permissions.allow, ...permissions.ask, ...permissions.deny];
    expect(staleRules(all)).toEqual([]);
    for (const rule of all) expect(CLAUDE_RULE_TOOLS as readonly string[]).toContain(ruleTool(rule));
    expect(all.filter((rule) => /^MultiEdit|^Write\(/.test(rule))).toEqual([]);
    for (const bucket of ["allow", "ask", "deny"] as const) {
      expect(new Set(permissions[bucket]).size).toBe(permissions[bucket].length);
    }
    for (const path of FORMER_WRITE.deny) expect(permissions.deny).toContain(`Edit(${path})`);
    expect(permissions.ask).toEqual([]);
    for (const path of FORMER_WRITE.cooperative) expect(permissions.deny).not.toContain(`Edit(${path})`);
    // env templates stay writable; only unversioned secrets are blocked
    for (const path of [".env.example", ".env.dist", ".env.dev", ".env"]) {
      expect([...permissions.ask, ...permissions.deny]).not.toContain(`Edit(${path})`);
    }
    expect(render(loadProfile("max20"), ["claude"]).find((t) => t.path === LEAD_SETTINGS_PATH)!.content).toBe(leadSettings());
  });

  test("Claude worker and read-only argv use only known tool rules", () => {
    const opts = { cwd: "/w", promptPath: "/p", readOnly: false, lastMessagePath: "/m", search: true };
    const rules = [
      ...argvRules(CLAUDE_WRITE_WORKER), ...argvRules(CLAUDE_READ_TOOLS),
      ...argvRules(workerArgv("claude", {}, opts).argv),
      ...argvRules(workerArgv("claude", {}, { ...opts, readOnly: true }).argv),
    ];
    expect(rules).toContain("Edit(/**)");
    expect(staleRules(rules)).toEqual([]);
  });

  test("stale names are named and migrate to Edit(<path>)", () => {
    expect(staleReason("Write(.env.local)")).toBe("use Edit(.env.local)");
    expect(staleReason("MultiEdit(src/x.ts)")).toContain("no longer exists");
    expect(staleReason("Write")).toBeNull();
    expect(staleReason("Bash(git push *)")).toBeNull();
    expect(staleReason("mcp__srv__tool")).toBeNull();
    expect(migrateRules(["Edit(a)", "Write(a)", "MultiEdit(a)", "Write(b)", "Bash(ls)", "MultiEdit"]))
      .toEqual(["Edit(a)", "Edit(b)", "Bash(ls)"]);
  });
});

describe("installed lead settings freshness", () => {
  test("doctor flags an older template and stale rules, and suggests orch install", () => {
    const t = temp();
    const which = (bin: string) => ["claude", "git", "bwrap", "socat"].includes(bin);
    expect(doctorChecks(t.home, which, () => true, undefined, t.state).lines.join("\n")).toContain("skip claude lead settings");
    apply(t.home, t.state, "max20", [{ path: LEAD_SETTINGS_PATH, kind: "file", content: OLD, harness: "claude" }], []);
    const stale = doctorChecks(t.home, which, () => true, undefined, t.state);
    expect(stale.ok).toBe(false);
    expect(stale.lines.join("\n")).toMatch(/FAIL claude lead settings .*older template, stale rules ask: Write\(CLAUDE\.md\).*orch install/);
    writeFileSync(t.file, leadSettings());
    expect(doctorChecks(t.home, which, () => true, undefined, t.state).lines).toContain("ok   claude lead settings ~/.claude/orch/lead-settings.json");
    rmSync(t.root, { recursive: true, force: true });
  });

  test("kiba re-renders an unedited older file and keeps the manifest in step", () => {
    const t = temp();
    apply(t.home, t.state, "max20", [{ path: LEAD_SETTINGS_PATH, kind: "file", content: OLD, harness: "claude" }], []);
    expect(leadSettingsStatus(t.home, t.state).state).toBe("outdated");
    expect(refreshLeadSettings(t.home, t.state)).toBe("rendered");
    expect(readFileSync(t.file, "utf8")).toBe(leadSettings());
    expect(readManifest(t.state)!.entries.find((e) => e.path === LEAD_SETTINGS_PATH)!.sha256).toBe(sha(leadSettings()));
    expect(refreshLeadSettings(t.home, t.state)).toBe("unchanged");
    rmSync(t.root, { recursive: true, force: true });
  });

  test("an edited file keeps its own content and only loses its stale rules", () => {
    const t = temp();
    apply(t.home, t.state, "max20", [{ path: LEAD_SETTINGS_PATH, kind: "file", content: leadSettings(), harness: "claude" }], []);
    const mine = JSON.parse(OLD);
    mine.permissions.allow = ["Bash(make check)"];
    mine.env = { MINE: "1" };
    writeFileSync(t.file, JSON.stringify(mine));
    expect(refreshLeadSettings(t.home, t.state)).toBe("migrated");
    const after = JSON.parse(readFileSync(t.file, "utf8"));
    expect(after).toEqual({ permissions: { allow: ["Bash(make check)"], ask: ["Edit(CLAUDE.md)"], deny: ["Edit(.env.local)"] }, env: { MINE: "1" } });
    // still edited for orch install: the operator's file is never overwritten
    expect(leadSettingsStatus(t.home, t.state)).toEqual({ state: "edited", stale: [] });
    recordEntry(t.state, "not/listed", "x");
    expect(readManifest(t.state)!.entries.map((e) => e.path)).toEqual([LEAD_SETTINGS_PATH]);
    rmSync(t.root, { recursive: true, force: true });
  });

  test("a missing or unparsable file is left alone", () => {
    const t = temp();
    expect(refreshLeadSettings(t.home, t.state)).toBe("unchanged");
    mkdirSync(join(t.home, ".claude", "orch"), { recursive: true });
    writeFileSync(t.file, "{ not json");
    expect(refreshLeadSettings(t.home, t.state)).toBe("unchanged");
    expect(readFileSync(t.file, "utf8")).toBe("{ not json");
    rmSync(t.root, { recursive: true, force: true });
  });
});

test("the rendered lead settings name no removed tool anywhere", () => {
  expect(leadSettings()).not.toMatch(/MultiEdit|Write\(/);
});
