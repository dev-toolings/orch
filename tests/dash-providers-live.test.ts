import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProviderLive, collectProviderLive, parseClaudeLine, parseCodexLine, providerIoStatsForTests, resetProviderLiveStateForTests, TAIL_HARD_MAX } from "../src/dash/providers-live.ts";
import type { DashLead, DashRuntime } from "../src/dash/types.ts";

const roots: string[] = [];

afterEach(() => {
  resetProviderLiveStateForTests();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "orch-live-"));
  roots.push(root);
  return root;
}

function lead(over: Partial<DashLead> = {}): DashLead {
  return {
    id: "kiba:core",
    project: "core",
    pid: 10,
    harness: "claude",
    model: "opus",
    effort: "high",
    permissionMode: "bypassPermissions",
    started: "2026-11-01T09:00:00.000Z",
    uptimeSec: 100,
    remoteControl: false,
    supervised: false,
    cwd: "/home/kev/lab/core",
    activity: "working",
    ...over,
  };
}

describe("provider parsers", () => {
  test("parses Claude usage lines only", () => {
    const row = parseClaudeLine(JSON.stringify({
      timestamp: "2026-11-01T10:00:00.000Z",
      message: {
        id: "msg_1",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 30,
        },
      },
      content: "SECRET",
    }));
    expect(row).toEqual({
      id: "msg_1",
      at: "2026-11-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      tokens: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 50 },
    });
    expect(parseClaudeLine("{\"timestamp\":\"x\"}")).toBeNull();
  });

  test("parses Codex token_count and quotas", () => {
    const row = parseCodexLine(JSON.stringify({
      timestamp: "2026-11-01T10:01:00.000Z",
      payload: {
        type: "token_count",
        info: {
          model: "gpt-5-codex",
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 6,
          },
        },
        rate_limits: {
          primary: { used_percent: 67, resets_at: "2026-11-01T11:00:00.000Z" },
          secondary: { used_percent: 25, resets_at: "2026-11-01T10:30:00.000Z" },
        },
      },
      prompt: "do not parse me",
    }));
    expect(row).toEqual({
      at: "2026-11-01T10:01:00.000Z",
      model: "gpt-5-codex",
      tokens: { input: 100, output: 16, cacheRead: 20, cacheWrite: 0 },
      quota: {
        primaryUsedPercent: 67,
        secondaryUsedPercent: 25,
        primaryResetAt: "2026-11-01T11:00:00.000Z",
        secondaryResetAt: "2026-11-01T10:30:00.000Z",
      },
    });
    expect(parseCodexLine("{\"payload\":{\"type\":\"message\"}}")).toBeNull();
  });
});

describe("provider live collector", () => {
  test("aggregates Claude/Codex usage for today, statuses, and quota bars", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        message: { id: "m1", model: "claude-opus-4-5", usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 80, cache_read_input_tokens: 40 } },
      }),
      JSON.stringify({
        timestamp: "2026-11-01T10:00:05.000Z",
        message: { id: "m1", model: "claude-opus-4-5", usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 80, cache_read_input_tokens: 40 } },
      }),
      "",
    ].join("\n"));

    const now = new Date("2026-11-01T10:05:00.000Z");
    const codexDir = join(home, ".codex", "sessions", "2026", "11", "01");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "rollout-abc.jsonl"), [
      JSON.stringify({
        timestamp: "2026-11-01T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 60, reasoning_output_tokens: 40 } },
          rate_limits: { primary: { used_percent: 75 }, secondary: { used_percent: 20 } },
        },
      }),
      "",
    ].join("\n"));

    writeFileSync(join(state, "lanes.jsonl"), `${JSON.stringify({
      kind: "run",
      at: "2026-11-01T10:02:00.000Z",
      to: "codex",
      usage: { input: 1000, output: 200 },
    })}\n`);

    const live = collectProviderLive({
      leads: [lead(), lead({ harness: "codex", id: "kiba:core#2", pid: 11, model: "gpt-5-codex", permissionMode: "yolo" })],
      installed: ["claude", "codex"],
      now,
      home,
      state,
    });

    expect(live.byHarness.claude.tokens).toEqual({ input: 2000, output: 400, cacheRead: 40, cacheWrite: 80 });
    expect(live.byHarness.claude.status).toBe("actif");
    expect(live.byHarness.codex.tokens).toEqual({ input: 500, output: 100, cacheRead: 100, cacheWrite: 0 });
    expect(live.byHarness.codex.status).toBe("en ligne");
    expect(live.byHarness.codex.quota?.primaryUsedPercent).toBe(75);
    expect(live.hostDetail).toContain("cœurs");
    expect(live.byHarness.codex.costUsd).toBeGreaterThan(0);

    const base: DashRuntime[] = [
      { id: "host", kind: "host", name: "kev", online: true, live: true, detail: "x", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
      { id: "claude", kind: "harness", name: "claude", online: true, live: false, detail: "installé", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
      { id: "codex", kind: "harness", name: "codex", online: true, live: false, detail: "installé", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
      { id: "grok", kind: "harness", name: "grok", online: false, live: false, detail: "absent", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
    ];
    const merged = applyProviderLive(base, live);
    expect(merged.find((r) => r.id === "claude")?.detail).toBe("actif");
    expect(merged.find((r) => r.id === "codex")?.quota?.secondaryUsedPercent).toBe(20);
    expect(JSON.stringify(merged)).not.toContain("SECRET");
    expect(JSON.stringify(merged)).not.toContain("prompt");
  });

  test("uses spend.jsonl as source of truth and overlays only in-progress tail deltas", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "session.jsonl"), `${JSON.stringify({
      timestamp: "2026-11-01T10:00:00.000Z",
      message: {
        id: "m1",
        model: "claude-opus-4-5",
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      },
    })}\n`);
    writeFileSync(join(state, "spend.jsonl"), `${JSON.stringify({
      at: "2026-11-01T10:00:00.000Z",
      usd: 0.123,
      source: "lead:claude:stop",
      provider: "claude",
      model: "claude-opus-4-5",
      session: "s1",
      project: "core",
      tokens: { input: 90, output: 20, cacheRead: 5, cacheWrite: 0 },
    })}\n`);
    const live = collectProviderLive({
      leads: [lead()],
      installed: ["claude"],
      now: new Date("2026-11-01T10:01:00.000Z"),
      home,
      state,
    });
    // Ledger baseline (90/20/5) + live delta (10/0/5) from transcript tail.
    expect(live.byHarness.claude.tokens).toEqual({ input: 100, output: 20, cacheRead: 10, cacheWrite: 0 });
    expect(live.byHarness.claude.costUsd).toBeCloseTo(0.123);
  });

  test("Provider aggregation counts only today's Europe/Paris rows", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-10-31T20:30:00.000Z",
        message: { id: "old", model: "claude-opus-4-6", usage: { input_tokens: 9000, output_tokens: 1000, cache_read_input_tokens: 5000 } },
      }),
      JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        message: { id: "today", model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 } },
      }),
      "",
    ].join("\n"));
    const live = collectProviderLive({
      leads: [lead()],
      installed: ["claude"],
      now: new Date("2026-11-01T10:30:00.000Z"),
      home,
      state,
    });
    expect(live.byHarness.claude.tokens).toEqual({ input: 100, output: 20, cacheRead: 10, cacheWrite: 0 });
  });

  test("Codex login mode shows quota and suppresses USD cost", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
    const codexDir = join(home, ".codex", "sessions", "2026", "11", "01");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "rollout-abc.jsonl"), `${JSON.stringify({
      timestamp: "2026-11-01T10:01:00.000Z",
      payload: {
        type: "token_count",
        info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 200, output_tokens: 20, cached_input_tokens: 10 } },
        rate_limits: { primary: { used_percent: 80 }, secondary: { used_percent: 30 } },
      },
    })}\n`);
    writeFileSync(join(state, "spend.jsonl"), `${JSON.stringify({
      at: "2026-11-01T10:00:00.000Z",
      usd: 1.5,
      source: "lane:x",
      provider: "codex",
      model: "gpt-5-codex",
      tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0 },
    })}\n`);
    const live = collectProviderLive({
      leads: [lead({ harness: "codex", id: "kiba:core#2", pid: 12, model: "gpt-5-codex", permissionMode: "yolo" })],
      installed: ["codex"],
      now: new Date("2026-11-01T10:02:00.000Z"),
      home,
      state,
    });
    expect(live.byHarness.codex.billing).toBe("quota");
    expect(live.byHarness.codex.authType).toBe("login");
    expect(live.byHarness.codex.costUsd).toBe(0);
    expect(live.byHarness.codex.quota?.primaryUsedPercent).toBe(80);
    expect(live.byHarness.codex.tokens).toEqual({ input: 200, output: 20, cacheRead: 10, cacheWrite: 0 });
  });

  test("Grok usage parsing scans nested ~/.grok session files", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const grokNested = join(home, ".grok", "sessions", "today");
    mkdirSync(grokNested, { recursive: true });
    writeFileSync(join(grokNested, "rollout.jsonl"), `${JSON.stringify({
      timestamp: "2026-11-01T09:00:00.000Z",
      model: "grok-4.7-build-fast",
      usage: { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 4 },
    })}\n`);
    const live = collectProviderLive({
      leads: [lead({ harness: "grok", id: "kiba:core#3", pid: 13, model: "grok-4.7-build-fast", permissionMode: null })],
      installed: ["grok"],
      now: new Date("2026-11-01T09:01:00.000Z"),
      home,
      state,
    });
    expect(live.byHarness.grok.tokens).toEqual({ input: 30, output: 6, cacheRead: 4, cacheWrite: 0 });
    expect(live.byHarness.grok.status).toBe("actif");
  });

  test("Grok scan skips unreadable and sandbox-blocked entries without failing snapshot", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const sessions = join(home, ".grok", "sessions");
    const nested = join(sessions, "today");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "rollout.jsonl"), `${JSON.stringify({
      timestamp: "2026-11-01T09:00:00.000Z",
      model: "grok-4.7-build-fast",
      usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2 },
    })}\n`);
    mkdirSync(join(sessions, "sandbox-blocked-dir.123"), { recursive: true });
    writeFileSync(join(sessions, "sandbox-blocked.456"), "blocked");
    const unreadable = join(sessions, "private");
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o000);
    try {
      const live = collectProviderLive({
        leads: [lead({ harness: "grok", id: "kiba:core#3", pid: 13, model: "grok-4.7-build-fast", permissionMode: null })],
        installed: ["grok"],
        now: new Date("2026-11-01T09:01:00.000Z"),
        home,
        state,
      });
      expect(live.byHarness.grok.tokens).toEqual({ input: 11, output: 3, cacheRead: 2, cacheWrite: 0 });
      expect(live.byHarness.grok.status).toBe("actif");
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });

  test("persists provider cache and reads appended bytes only after restart", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    const file = join(claudeDir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({
      timestamp: "2026-11-01T10:00:00.000Z",
      message: { id: "m1", model: "claude-opus-4-6", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1 } },
    })}\n`);
    const baseOpts = {
      leads: [lead()],
      installed: ["claude"],
      now: new Date("2026-11-01T10:01:00.000Z"),
      home,
      state,
    };
    const first = collectProviderLive(baseOpts);
    expect(first.byHarness.claude.tokens).toEqual({ input: 10, output: 2, cacheRead: 1, cacheWrite: 0 });
    expect(existsSync(join(state, "dash-usage-cache.json"))).toBe(true);

    resetProviderLiveStateForTests();
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({
      timestamp: "2026-11-01T10:02:00.000Z",
      message: { id: "m2", model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0 } },
    })}\n`);
    const second = collectProviderLive({ ...baseOpts, now: new Date("2026-11-01T10:03:00.000Z") });
    expect(second.byHarness.claude.tokens).toEqual({ input: 15, output: 3, cacheRead: 1, cacheWrite: 0 });
  });

  test("resets cached offset and reparses when file truncates", () => {
    const home = tempHome();
    const state = join(home, ".local", "state", "orch");
    mkdirSync(state, { recursive: true });
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    const file = join(claudeDir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({
      timestamp: "2026-11-01T10:00:00.000Z",
      message: { id: "old", model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 20 } },
    })}\n`);
    collectProviderLive({
      leads: [lead()],
      installed: ["claude"],
      now: new Date("2026-11-01T10:01:00.000Z"),
      home,
      state,
    });
    writeFileSync(file, `${JSON.stringify({
      timestamp: "2026-11-01T10:02:00.000Z",
      message: { id: "new", model: "claude-opus-4-6", usage: { input_tokens: 3, output_tokens: 1 } },
    })}\n`);
    const snap = collectProviderLive({
      leads: [lead()],
      installed: ["claude"],
      now: new Date("2026-11-01T10:03:00.000Z"),
      home,
      state,
    });
    expect(snap.byHarness.claude.tokens).toEqual({ input: 3, output: 1, cacheRead: 0, cacheWrite: 0 });
  });

  test("an unchanged file (same size, mtime, inode) is not opened again", () => {
    const home = tempHome();
    const state = join(home, "state");
    const claudeDir = join(home, ".claude", "projects", "-home-kev-lab-core");
    mkdirSync(claudeDir, { recursive: true });
    const file = join(claudeDir, "session.jsonl");
    const line = (id: string, input: number) => `${JSON.stringify({
      timestamp: "2026-11-01T10:00:00.000Z",
      message: { id, model: "claude-opus-4-6", usage: { input_tokens: input, output_tokens: 1 } },
    })}\n`;
    writeFileSync(file, line("a", 10));
    writeFileSync(join(claudeDir, "other.jsonl"), line("b", 5));
    const opts = { leads: [], installed: ["claude"], now: new Date("2026-11-01T10:01:00.000Z"), home, state };
    collectProviderLive(opts);
    const before = providerIoStatsForTests();
    const again = collectProviderLive(opts);
    expect(providerIoStatsForTests()).toEqual(before);
    expect(again.byHarness.claude.tokens.input).toBe(15);
    // After a restart the cursors come from the cache file: still no open.
    resetProviderLiveStateForTests();
    const reloaded = collectProviderLive(opts);
    expect(providerIoStatsForTests()).toEqual(before);
    expect(reloaded.byHarness.claude.tokens.input).toBe(15);
    appendFileSync(file, line("c", 2));
    const grown = collectProviderLive(opts);
    expect(providerIoStatsForTests().opens).toBe(before.opens + 1);
    expect(grown.byHarness.claude.tokens.input).toBe(17);
  });

  test("Grok billing quota is tail-read from a large CLI log with bounded bytes", () => {
    const home = tempHome();
    const state = join(home, "state");
    const logs = join(home, ".grok", "logs");
    mkdirSync(logs, { recursive: true });
    const unified = join(logs, "unified.jsonl");
    const billing = (ts: string, p: number) => `${JSON.stringify({
      ts,
      msg: "billing: fetched credits config",
      ctx: { config: { creditUsagePercent: p, currentPeriod: { type: "WEEKLY", start: "2026-10-28T00:00:00.000Z", end: "2026-11-04T00:00:00.000Z" } } },
    })}\n`;
    const filler = `${JSON.stringify({ ts: "2026-11-01T09:00:00.000Z", msg: "shell.tool.exec_done", ctx: { pad: "x".repeat(400) } })}\n`;
    const block = filler.repeat(Math.ceil((1024 * 1024) / filler.length));
    // ~30 MB: an old billing line at the start, the latest one 6 MB from the end.
    const fd = openSync(unified, "w");
    writeSync(fd, billing("2026-10-29T09:00:00.000Z", 5));
    for (let i = 0; i < 24; i++) writeSync(fd, block);
    writeSync(fd, billing("2026-11-01T09:30:00.000Z", 37));
    for (let i = 0; i < 6; i++) writeSync(fd, block);
    closeSync(fd);
    const size = statSync(unified).size;
    expect(size).toBeGreaterThan(30 * 1024 * 1024);
    const opts = { leads: [], installed: ["grok"], now: new Date("2026-11-01T10:00:00.000Z"), home, state };
    const before = providerIoStatsForTests().bytesRead;
    const live = collectProviderLive(opts);
    const read = providerIoStatsForTests().bytesRead - before;
    const credits = live.byHarness.grok.limits?.windows.find((w) => w.id === "credits");
    expect(credits?.usedPercent).toBe(37);
    expect(read).toBeLessThanOrEqual(TAIL_HARD_MAX);
    expect(read).toBeLessThan(size / 3);
    // Later passes read only the appended bytes.
    const appended = billing("2026-11-01T09:55:00.000Z", 39);
    appendFileSync(unified, appended);
    const mid = providerIoStatsForTests().bytesRead;
    const next = collectProviderLive({ ...opts, now: new Date("2026-11-01T10:01:00.000Z") });
    expect(providerIoStatsForTests().bytesRead - mid).toBe(Buffer.byteLength(appended));
    expect(next.byHarness.grok.limits?.windows.find((w) => w.id === "credits")?.usedPercent).toBe(39);
  });
});

