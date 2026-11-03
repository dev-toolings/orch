import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  burnRate, claudeQuota, codexQuota, grokQuota, parseClaudeRateLimits, parseCodexWindow,
  parseGrokBillingLine, pushSample, quotaWindow, readClaudeQuotaFile, toIso, windowLabel, writeClaudeQuotaSnapshot,
} from "../src/dash/quota.ts";
import { chainedStatuslineCommand, isOrchStatusline, runStatusline } from "../src/hooks/statusline.ts";
import { applyProviderLive, collectProviderLive, parseCodexLine, resetProviderLiveStateForTests } from "../src/dash/providers-live.ts";
import { render, STATUSLINE_REFRESH_SECONDS, statuslineCommand } from "../src/install/render.ts";
import { apply, plan } from "../src/install/manifest.ts";
import { loadProfile } from "../src/core/profile.ts";
import { sourceHookSettings } from "../src/checks/conso.ts";
import type { DashRuntime } from "../src/dash/types.ts";

const FIX = join(import.meta.dir, "fixtures", "quota");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const roots: string[] = [];

afterEach(() => {
  resetProviderLiveStateForTests();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "orch-quota-"));
  roots.push(root);
  return root;
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("quota helpers", () => {
  test("toIso accepts epoch seconds, epoch ms and ISO", () => {
    expect(toIso(1793548800)).toBe("2026-11-01T16:00:00.000Z");
    expect(toIso(1793548800000)).toBe("2026-11-01T16:00:00.000Z");
    expect(toIso("1793548800")).toBe("2026-11-01T16:00:00.000Z");
    expect(toIso("2026-11-01T16:00:00Z")).toBe("2026-11-01T16:00:00.000Z");
    expect(toIso(null)).toBeNull();
    expect(toIso("nope")).toBeNull();
  });

  test("window labels are French", () => {
    expect(windowLabel(300, "x")).toBe("Fenêtre 5 h");
    expect(windowLabel(10080, "x")).toBe("Hebdo");
    expect(windowLabel(undefined, "Quota primaire")).toBe("Quota primaire");
  });

  test("burn rate needs two samples over 10 min and projects 100 %", () => {
    const now = new Date("2026-11-01T10:00:00.000Z");
    expect(burnRate([{ at: "2026-11-01T10:00:00.000Z", p: 20 }], now)).toEqual({ ratePerHour: null, projectedFullAt: null });
    expect(burnRate([{ at: "2026-11-01T09:55:00.000Z", p: 19 }, { at: "2026-11-01T10:00:00.000Z", p: 20 }], now).ratePerHour).toBeNull();
    const rate = burnRate([
      { at: "2026-11-01T09:00:00.000Z", p: 10 },
      { at: "2026-11-01T10:00:00.000Z", p: 20 },
    ], now);
    expect(rate.ratePerHour).toBe(10);
    expect(rate.projectedFullAt).toBe("2026-11-01T18:00:00.000Z");
    // A reset inside the run (percent drops) restarts the measurement.
    const after = burnRate([
      { at: "2026-11-01T08:00:00.000Z", p: 90 },
      { at: "2026-11-01T09:00:00.000Z", p: 5 },
      { at: "2026-11-01T10:00:00.000Z", p: 7 },
    ], now);
    expect(after.ratePerHour).toBe(2);
  });

  test("pushSample collapses unchanged samples within 5 min", () => {
    const now = new Date("2026-11-01T10:10:00.000Z");
    let h = pushSample([], { at: "2026-11-01T10:00:00.000Z", p: 5 }, now);
    h = pushSample(h, { at: "2026-11-01T10:01:00.000Z", p: 5 }, now);
    expect(h).toHaveLength(1);
    h = pushSample(h, { at: "2026-11-01T10:02:00.000Z", p: 6 }, now);
    h = pushSample(h, { at: "2026-11-01T10:08:00.000Z", p: 6 }, now);
    expect(h.map((s) => s.p)).toEqual([5, 6, 6]);
  });

  test("an elapsed reset shows the window as reset", () => {
    const w = quotaWindow("five_hour", "Fenêtre 5 h", [{ at: "2026-11-01T08:00:00.000Z", p: 80, r: "2026-11-01T09:00:00.000Z", w: 300 }], new Date("2026-11-01T10:00:00.000Z"));
    expect(w.usedPercent).toBe(0);
    expect(w.resetAt).toBeUndefined();
    expect(w.note).toContain("réinitialisée");
  });
});

describe("Claude statusLine", () => {
  test("parses rate_limits from the statusLine stdin fixture", () => {
    expect(parseClaudeRateLimits(JSON.parse(fixture("claude-statusline.json")))).toEqual({
      five_hour: { used_percentage: 23.5, resets_at: "2026-11-01T16:00:00.000Z" },
      seven_day: { used_percentage: 41.2, resets_at: "2026-11-06T16:00:00.000Z" },
    });
    expect(parseClaudeRateLimits({ model: { display_name: "Opus" } })).toBeNull();
    expect(parseClaudeRateLimits({ rate_limits: { five_hour: { resets_at: 1 } } })).toBeNull();
  });

  test("the hook writes quota-claude.json atomically and prints a short line", () => {
    const state = temp();
    const home = temp();
    const now = new Date("2026-11-01T10:00:00.000Z");
    const out = runStatusline(fixture("claude-statusline.json"), { HOME: home, ORCH_STATE: state }, now);
    expect(out).toBe("Opus · ctx 8% · 5h 24% ↺17:00 · 7j 41% ↺17:00");
    const file = readClaudeQuotaFile(state)!;
    expect(file.captured_at).toBe(now.toISOString());
    expect(file.rate_limits.five_hour?.used_percentage).toBe(23.5);
    expect(file.history.five_hour).toHaveLength(1);
    expect(readdirSync(state).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // No rate_limits (API key session): the snapshot is left untouched.
    runStatusline(JSON.stringify({ model: { display_name: "Opus" } }), { HOME: home, ORCH_STATE: state }, new Date("2026-11-01T11:00:00.000Z"));
    expect(readClaudeQuotaFile(state)!.captured_at).toBe(now.toISOString());
    expect(runStatusline("not json", { HOME: home, ORCH_STATE: state }, now)).toBe("orch");
  });

  test("the CLI entrypoint writes the snapshot from stdin", () => {
    const state = temp();
    const home = temp();
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "hook", "statusline", "--harness", "claude"], {
      input: fixture("claude-statusline.json"),
      encoding: "utf8",
      env: { HOME: home, ORCH_STATE: state, PATH: process.env.PATH, TZ: "UTC" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("5h 24%");
    expect(existsSync(join(state, "quota-claude.json"))).toBe(true);
    const alias = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "statusline"], {
      input: "{}", encoding: "utf8", env: { HOME: home, ORCH_STATE: state, PATH: process.env.PATH },
    });
    expect(alias.stdout.trim()).toBe("orch");
  });

  test("chains the operator's previous statusLine with the same stdin", () => {
    const state = temp();
    const home = temp();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const script = join(home, "mine.sh");
    writeFileSync(script, "#!/bin/sh\nprintf 'mine:'; cat | head -c 1\n");
    chmodSync(script, 0o755);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: script } }));
    const env = { HOME: home, ORCH_STATE: state, PATH: process.env.PATH };
    expect(chainedStatuslineCommand(env)).toBe(script);
    const out = runStatusline(fixture("claude-statusline.json"), env, new Date("2026-11-01T10:00:00.000Z"));
    // The operator's line comes first, unchanged; orch adds only the quotas.
    expect(out.split("\n")).toEqual(["mine:{", "5h 24% ↺17:00 · 7j 41% ↺17:00"]);
    // orch's own statusLine is never chained (no recursion).
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: statuslineCommand() } }));
    expect(chainedStatuslineCommand(env)).toBeNull();
    expect(isOrchStatusline('"$HOME/.local/bin/orch" statusline')).toBe(true);
    expect(chainedStatuslineCommand({ ...env, ORCH_STATUSLINE_CHAIN: "echo hi" })).toBe("echo hi");
    // A chained wrapper that calls orch again does not chain a second time.
    expect(chainedStatuslineCommand({ ...env, ORCH_STATUSLINE_CHAIN: "echo hi", ORCH_STATUSLINE_CHAINED: "1" })).toBeNull();
  });

  test("dash quota from the snapshot: windows, burn rate, stale marker", () => {
    const state = temp();
    const limits = (p5: number, p7: number) => ({
      five_hour: { used_percentage: p5, resets_at: "2026-11-01T12:00:00.000Z" },
      seven_day: { used_percentage: p7, resets_at: "2026-11-06T16:00:00.000Z" },
    });
    writeClaudeQuotaSnapshot(state, limits(10, 40), new Date("2026-11-01T09:00:00.000Z"));
    writeClaudeQuotaSnapshot(state, limits(30, 42), new Date("2026-11-01T10:00:00.000Z"));
    const q = claudeQuota(state, new Date("2026-11-01T10:05:00.000Z"));
    expect(q.stale).toBe(false);
    expect(q.windows.map((w) => w.label)).toEqual(["Fenêtre 5 h", "Hebdo"]);
    expect(q.windows[0]).toMatchObject({ usedPercent: 30, resetAt: "2026-11-01T12:00:00.000Z", ratePerHour: 20, projectedFullAt: "2026-11-01T13:30:00.000Z", fullBeforeReset: false });
    expect(q.windows[1]!.ratePerHour).toBe(2);
    expect(claudeQuota(state, new Date("2026-11-01T16:30:00.000Z")).stale).toBe(true);
    expect(claudeQuota(temp(), new Date()).unavailable).toContain("aucun instantané");
  });
});

describe("Codex rate limits", () => {
  test("parses primary and secondary windows with reset times", () => {
    expect(parseCodexWindow({ used_percent: 73, window_minutes: 10080, resets_at: 1793780306 }, "2026-11-01T10:00:00.000Z"))
      .toEqual({ usedPercent: 73, windowMinutes: 10080, resetAt: "2026-11-04T08:18:26.000Z" });
    expect(parseCodexWindow({ used_percent: 20, window_minutes: 300, resets_in_seconds: 3600 }, "2026-11-01T10:00:00.000Z"))
      .toEqual({ usedPercent: 20, windowMinutes: 300, resetAt: "2026-11-01T11:00:00.000Z" });
    expect(parseCodexWindow(null, "x")).toBeNull();
    const row = parseCodexLine(fixture("codex-rollout.jsonl").split("\n")[2]!)!;
    expect(row.quota).toEqual({
      primaryUsedPercent: 20, primaryWindowMinutes: 300, primaryResetAt: "2026-11-01T11:00:00.000Z",
      secondaryUsedPercent: 62, secondaryWindowMinutes: 10080, secondaryResetAt: "2026-11-04T08:18:26.000Z",
    });
  });

  test("weekly-only primary (secondary null) lists the 5 h window as unavailable", () => {
    const q = codexQuota({ primary: [{ at: "2026-11-01T10:00:00.000Z", p: 73, r: "2026-11-04T08:18:26.000Z", w: 10080 }] }, new Date("2026-11-01T10:01:00.000Z"));
    expect(q.windows.map((w) => [w.label, w.usedPercent])).toEqual([["Fenêtre 5 h", null], ["Hebdo", 73]]);
    expect(q.windows[0]!.unavailable).toBeTruthy();
    expect(q.windows[1]!.ratePerHour).toBeNull();
  });

  test("collector exposes 5 h and weekly windows with burn rate from the rollout", () => {
    const home = temp();
    const state = join(home, "state");
    mkdirSync(state, { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
    const dir = join(home, ".codex", "sessions", "2026", "11", "01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-q.jsonl"), fixture("codex-rollout.jsonl"));
    const live = collectProviderLive({ leads: [], installed: ["codex"], now: new Date("2026-11-01T10:01:00.000Z"), home, state });
    const limits = live.byHarness.codex.limits!;
    expect(limits.stale).toBe(false);
    expect(limits.capturedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(limits.windows.map((w) => w.label)).toEqual(["Fenêtre 5 h", "Hebdo"]);
    expect(limits.windows[0]).toMatchObject({ usedPercent: 20, ratePerHour: 10, resetAt: "2026-11-01T11:00:00.000Z" });
    expect(limits.windows[1]).toMatchObject({ usedPercent: 62, ratePerHour: 2, resetAt: "2026-11-04T08:18:26.000Z" });
    // Persisted: a cache-only restart keeps the history.
    resetProviderLiveStateForTests();
    const cached = collectProviderLive({ leads: [], installed: ["codex"], now: new Date("2026-11-01T10:01:00.000Z"), home, state, ingestMode: "cache-only" });
    expect(cached.byHarness.codex.limits?.windows[0]?.ratePerHour).toBe(10);
  });
});

describe("Grok credits", () => {
  test("parses the billing credits log line only", () => {
    const lines = fixture("grok-unified.jsonl").trim().split("\n");
    expect(parseGrokBillingLine(lines[0]!)).toEqual({ at: "2026-11-01T08:00:00.000Z", p: 40, r: "2026-11-01T17:40:17.140Z", w: 10080 });
    expect(parseGrokBillingLine(lines[1]!)).toBeNull();
    expect(parseGrokBillingLine("billing: fetched credits config")).toBeNull();
    expect(grokQuota([], new Date()).unavailable).toContain("billing");
  });

  test("collector reads ~/.grok/logs/unified.jsonl and reports the weekly window", () => {
    const home = temp();
    const state = join(home, "state");
    mkdirSync(join(home, ".grok", "logs"), { recursive: true });
    writeFileSync(join(home, ".grok", "logs", "unified.jsonl"), fixture("grok-unified.jsonl"));
    const live = collectProviderLive({ leads: [], installed: ["grok"], now: new Date("2026-11-01T10:30:00.000Z"), home, state });
    const limits = live.byHarness.grok.limits!;
    expect(limits.source).toContain("unified.jsonl");
    expect(limits.windows[0]).toMatchObject({ label: "Fenêtre 5 h", usedPercent: null });
    expect(limits.windows[1]).toMatchObject({ label: "Hebdo", usedPercent: 44, ratePerHour: 2, resetAt: "2026-11-01T17:40:17.140Z" });
    expect(live.byHarness.grok.tokens).toEqual(zero);
    const base: DashRuntime[] = [{ id: "grok", kind: "harness", name: "grok", online: true, live: false, detail: "x", tokens: zero, costUsd: 0 }];
    expect(applyProviderLive(base, live)[0]!.limits?.windows[1]?.usedPercent).toBe(44);
    expect(collectProviderLive({ leads: [], installed: ["grok"], now: new Date("2026-11-01T17:00:00.000Z"), home, state }).byHarness.grok.limits?.stale).toBe(true);
  });
});

describe("install render", () => {
  const profile = loadProfile();

  test("lead settings leave the operator's statusLine alone: no override", () => {
    const settings = JSON.parse(render(profile, ["claude"]).find((t) => t.path === ".claude/orch/lead-settings.json")!.content);
    expect(settings.statusLine).toBeUndefined();
    expect(statuslineCommand()).toContain("hook statusline --harness claude");
  });

  test("orch diff sees an older lead settings file as an update", () => {
    const home = temp();
    const state = join(home, "state");
    const targets = render(profile, ["claude"]);
    const old = targets.map((t) => {
      if (t.path !== ".claude/orch/lead-settings.json") return t;
      const parsed = JSON.parse(t.content);
      parsed.statusLine = { type: "command", command: statuslineCommand(), padding: 0, refreshInterval: STATUSLINE_REFRESH_SECONDS };
      return { ...t, content: JSON.stringify(parsed, null, 2) + "\n" };
    });
    const manifest = apply(home, state, profile.name, old, plan(home, old, null));
    const actions = plan(home, targets, manifest);
    expect(actions.find((a) => a.path === ".claude/orch/lead-settings.json")?.op).toBe("update");
  });
});
