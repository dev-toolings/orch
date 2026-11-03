// Freshness of the installed Claude lead settings (~/.claude/orch/lead-settings.json).
// `orch doctor` reports it; `kiba` re-renders it before starting Claude so a
// template change (such as the Edit-only file rules) never needs a manual
// `orch install`. Cheap: one file read, one JSON parse, no profile load.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateRules, staleSettingsRules } from "./claude-rules.ts";
import { readManifest, recordEntry, sha } from "./manifest.ts";
import { LEAD_SETTINGS_PATH, leadSettings } from "./render.ts";

export type LeadSettingsState =
  | "missing" // not installed: `orch install`
  | "current" // byte for byte the rendered template
  | "outdated" // installed by orch, unedited, from an older template
  | "edited"; // changed by hand since install (or never installed by orch)

export interface LeadSettingsStatus {
  state: LeadSettingsState;
  stale: string[]; // "bucket: rule" Claude Code would warn about
}

function readSettings(abs: string): string | null {
  try { return readFileSync(abs, "utf8"); } catch { return null; }
}

export function leadSettingsStatus(home: string, stateDir: string, want = leadSettings()): LeadSettingsStatus {
  const cur = readSettings(join(home, LEAD_SETTINGS_PATH));
  if (cur === null) return { state: "missing", stale: [] };
  if (cur === want) return { state: "current", stale: [] };
  let stale: string[] = [];
  try { stale = staleSettingsRules(JSON.parse(cur)); } catch { stale = []; }
  const entry = readManifest(stateDir)?.entries.find((e) => e.path === LEAD_SETTINGS_PATH);
  return { state: entry?.sha256 === sha(cur) ? "outdated" : "edited", stale };
}

function writeAtomic(abs: string, content: string) {
  const tmp = `${abs}.orch-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

// Brings the installed file up to date, as `orch install` would for this one
// file: an unedited file is replaced by the template and the manifest follows;
// an edited one keeps its content and only has its stale rules rewritten
// (Write(<path>) -> Edit(<path>), MultiEdit dropped), so it stays "edited".
// Returns what was done; throws on I/O or JSON errors (the caller warns).
export function refreshLeadSettings(home: string, stateDir: string): "unchanged" | "rendered" | "migrated" {
  const want = leadSettings();
  const status = leadSettingsStatus(home, stateDir, want);
  const abs = join(home, LEAD_SETTINGS_PATH);
  if (status.state === "outdated") {
    writeAtomic(abs, want);
    recordEntry(stateDir, LEAD_SETTINGS_PATH, want);
    return "rendered";
  }
  if (status.state === "edited" && status.stale.length) {
    const settings = JSON.parse(readFileSync(abs, "utf8"));
    for (const bucket of ["allow", "ask", "deny"] as const) {
      const rules = settings.permissions?.[bucket];
      if (Array.isArray(rules)) settings.permissions[bucket] = migrateRules(rules);
    }
    writeAtomic(abs, JSON.stringify(settings, null, 2) + "\n");
    return "migrated";
  }
  return "unchanged";
}
