import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { ensureClaudeCleanupSettings, logsPruneUnits, pruneHarnessLogs } from "../src/logs/prune.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orch-prune-"));
  roots.push(root);
  return root;
}

describe("logs prune", () => {
  test("renders prune timer with Paris timezone and configured HH:MM", () => {
    const units = logsPruneUnits("12:00");
    const timer = units.find((u) => u.name === "orch-logs-prune.timer")?.content ?? "";
    expect(timer).toContain("OnCalendar=*-*-* 12:00:00 Europe/Paris");
    expect(timer).toContain("Persistent=true");
  });

  test("prunes old codex/grok logs, keeps open/lead/newest files, and writes usage cache", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    const codexDay = join(home, ".codex", "sessions", "2026", "09", "01");
    const codexOld = join(codexDay, "rollout-old.jsonl");
    const codexKeepNewest = join(codexDay, "rollout-newest.jsonl");
    mkdirSync(codexDay, { recursive: true });
    writeFileSync(codexOld, `${JSON.stringify({
      timestamp: "2026-09-01T10:00:00.000Z",
      payload: { type: "token_count", info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 2 } } },
    })}\n`);
    writeFileSync(codexKeepNewest, `${JSON.stringify({
      timestamp: "2026-09-01T11:00:00.000Z",
      payload: { type: "token_count", info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 30, output_tokens: 8, cached_input_tokens: 3 } } },
    })}\n`);
    const grokRoot = join(home, ".grok", "sessions", "alpha");
    const grokDelete = join(grokRoot, "session-old.jsonl");
    const grokOpen = join(grokRoot, "session-open.jsonl");
    mkdirSync(grokRoot, { recursive: true });
    writeFileSync(grokDelete, `${JSON.stringify({
      timestamp: "2026-09-01T10:00:00.000Z",
      model: "grok-4.7-build-fast",
      usage: { input_tokens: 10, output_tokens: 2 },
    })}\n`);
    writeFileSync(grokOpen, `${JSON.stringify({
      timestamp: "2026-09-01T12:00:00.000Z",
      model: "grok-4.7-build-fast",
      usage: { input_tokens: 11, output_tokens: 3 },
    })}\n`);
    const old = new Date("2026-09-01T12:00:00.000Z");
    utimesSync(codexOld, old, new Date(old.getTime()));
    utimesSync(codexKeepNewest, old, new Date(old.getTime() + 1000));
    utimesSync(grokDelete, old, new Date(old.getTime()));
    utimesSync(grokOpen, old, new Date(old.getTime() + 1000));

    const result = pruneHarnessLogs({
      days: 7,
      deps: {
        now: new Date("2026-11-01T12:00:00.000Z"),
        home,
        state,
        listOpenFiles: () => new Set([grokOpen]),
        listLeadFiles: () => new Set([join(home, ".codex", "sessions", "2026", "09", "01", "rollout-live.jsonl")]),
      },
    });
    expect(result.totalDeleted).toBeGreaterThanOrEqual(2);
    expect(existsSync(codexOld)).toBe(false);
    expect(existsSync(grokDelete)).toBe(false);
    expect(existsSync(codexKeepNewest)).toBe(true);
    expect(existsSync(grokOpen)).toBe(true);
    const cache = JSON.parse(readFileSync(join(state, "dash-usage-cache.json"), "utf8")) as { codex: Record<string, unknown>; grok: Record<string, unknown> };
    expect(Object.keys(cache.codex).some((path) => path.endsWith("rollout-old.jsonl"))).toBe(true);
    expect(Object.keys(cache.grok).some((path) => path.endsWith("session-old.jsonl"))).toBe(true);
  });

  test("dry-run reports without deleting", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const file = join(home, ".codex", "sessions", "2026", "09", "01", "rollout-abc.jsonl");
    const newer = join(home, ".codex", "sessions", "2026", "09", "01", "rollout-def.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      timestamp: "2026-09-01T10:00:00.000Z",
      payload: { type: "token_count", info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 1 } } },
    })}\n`);
    writeFileSync(newer, `${JSON.stringify({
      timestamp: "2026-09-01T11:00:00.000Z",
      payload: { type: "token_count", info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 7, output_tokens: 2, cached_input_tokens: 1 } } },
    })}\n`);
    const t = new Date("2026-09-01T12:00:00.000Z");
    utimesSync(file, t, t);
    utimesSync(newer, t, new Date(t.getTime() + 1000));
    const result = pruneHarnessLogs({
      days: 7,
      dryRun: true,
      deps: { now: new Date("2026-11-01T12:00:00.000Z"), home, state: join(root, "state"), listOpenFiles: () => new Set(), listLeadFiles: () => new Set() },
    });
    expect(result.totalDeleted).toBe(1);
    expect(existsSync(file)).toBe(true);
  });

  test("prunes orch's own contests, reviews and asks past the retention, keeps recent ones", () => {
    const root = tempRoot();
    const state = join(root, "state");
    const now = new Date("2026-11-02T12:00:00.000Z");
    const old = new Date(now.getTime() - 10 * 86_400_000);
    for (const [dir, name, when] of [["contests", "old-run", old], ["contests", "new-run", now], ["reviews", "old-review", old], ["asks", "old-ask", old]] as const) {
      const entry = join(state, dir, name);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, "worker.log"), "x".repeat(100));
      utimesSync(entry, when, when);
    }
    const deps = { now, home: join(root, "home"), state, listOpenFiles: () => new Set<string>(), listLeadFiles: () => new Set<string>() };
    const dry = pruneHarnessLogs({ days: 7, dryRun: true, deps });
    expect(dry.stateRuns.map((r) => [r.dir, r.deleted])).toEqual([["contests", 1], ["reviews", 1], ["asks", 1]]);
    expect(existsSync(join(state, "contests", "old-run"))).toBe(true);
    const done = pruneHarnessLogs({ days: 7, deps });
    expect(done.stateRuns.reduce((n, r) => n + r.bytesFreed, 0)).toBe(300);
    expect(existsSync(join(state, "contests", "old-run"))).toBe(false);
    expect(existsSync(join(state, "reviews", "old-review"))).toBe(false);
    expect(existsSync(join(state, "asks", "old-ask"))).toBe(false);
    expect(existsSync(join(state, "contests", "new-run"))).toBe(true);
  });

  test("orch logs prune --help or an unknown option prints the usage and deletes nothing", () => {
    const root = tempRoot();
    const state = join(root, "state");
    const entry = join(state, "contests", "old-run");
    mkdirSync(entry, { recursive: true });
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(entry, old, old);
    const env = { ...process.env, HOME: join(root, "home"), ORCH_STATE: state };
    for (const [flag, code] of [["--help", 0], ["--bogus", 2]] as const) {
      const r = spawnSync(process.execPath, ["src/orch.ts", "logs", "prune", flag], { cwd: join(import.meta.dir, ".."), env, encoding: "utf8" });
      expect(r.status).toBe(code);
      expect(r.stdout).toContain("usage: orch logs prune");
      expect(existsSync(entry)).toBe(true);
    }
  });

  test("ensures Claude cleanupPeriodDays with backup and merge", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ theme: "dark", cleanupPeriodDays: 3 }, null, 2)}\n`);
    const out = ensureClaudeCleanupSettings({ home, days: 7, now: new Date("2026-11-01T12:00:00.000Z") });
    expect(out.changed).toBe(true);
    expect(typeof out.backupPath).toBe("string");
    const merged = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    expect(merged.theme).toBe("dark");
    expect(merged.cleanupPeriodDays).toBe(7);
    expect(out.backupPath && existsSync(out.backupPath)).toBe(true);
  });
});
