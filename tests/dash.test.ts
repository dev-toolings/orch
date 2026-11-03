import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/core/profile.ts";
import type { LaneState } from "../src/lane.ts";
import type { RunRecord } from "../src/lanes/ledger.ts";
import { TOKENS_PER_LANE } from "../src/lanes/budget.ts";
import { activityFor, collectDash, dashLedgerOf, dashLanesOf, emptyBus, loadFixture } from "../src/dash/collect.ts";
import { dashServeOptions, parseDashArgs } from "../src/dash/cli.ts";
import { dashDev, parseDevEnv, waitForApi } from "../src/dash/dev.ts";
import { serveDash } from "../src/dash/serve.ts";
import { workerProviderSync, type ProviderSyncRunner } from "../src/dash/provider-sync.ts";
import { providerIoStatsForTests, type ProviderUsageSummary } from "../src/dash/providers-live.ts";
import type { DashLead, DashSnapshot } from "../src/dash/types.ts";

const limits = loadProfile("max20").limits;
const machine = { cores: 16, memAvailableGib: 23 };
const policy = { spend: { daily_usd: 8, embed_usd_per_million: 0.02, plan_tokens: TOKENS_PER_LANE * 4 }, paid_routines: [] as string[] };

const lane = (over: Partial<LaneState> = {}): LaneState => ({
  id: "20261101T101010-claude-1-abcd",
  to: "claude",
  repo: "/tmp/orch",
  base: "abc",
  branch: "lane/x",
  worktree: "/tmp/wt",
  status: "complete",
  changed: true,
  usage: { input: 1000, output: 200 },
  started: "2026-11-01T10:00:00Z",
  ended: "2026-11-01T10:01:00Z",
  ...over,
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  kind: "run",
  id: "20261101T101010-claude-1-abcd",
  at: "2026-11-01T10:01:00Z",
  repo: "/tmp/orch",
  to: "claude",
  model: "claude-haiku-4-5",
  effort: "high",
  channel: "cli",
  status: "complete",
  changed: true,
  verifyOk: true,
  features: { files: ["a.ts"], stacks: [], risk: [], objective: "SECRET PROMPT do not leak" },
  diff: { files: ["a.ts"], insertions: 1, deletions: 0 },
  outOfScope: [],
  durationS: 12,
  usage: { input: 1000, output: 200 },
  ...over,
});

const lead = (over: Partial<DashLead> = {}): DashLead => ({
  id: "kiba:lab",
  project: "lab",
  pid: 4242,
  harness: "claude",
  model: "claude-opus-4-5",
  effort: "high",
  permissionMode: "bypassPermissions",
  started: "2026-11-01T08:00:00.000Z",
  uptimeSec: 3600,
  remoteControl: true,
  supervised: true,
  cwd: "/home/kevin/lab",
  activity: "idle",
  ...over,
});

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-dash-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("port allocation failed")));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const isolated = (over: Parameters<typeof collectDash>[0] = {}) => collectDash({
  state: join(root, "state"),
  policy,
  machine,
  limits,
  now: new Date("2026-11-01T12:00:00Z"),
  lanes: [],
  ledger: [],
  spendUsed: 0.12,
  planUsed: 0,
  projectsRoot: join(root, "empty-projects"),
  busRoot: join(root, "missing-bus"),
  procRoot: null,
  home: root,
  claudeProjects: join(root, "empty-claude"),
  logs: [],
  skills: [],
  installed: [],
  hostName: "test",
  ...over,
});

describe("orch dash collector", () => {
  test("without an explicit profile the budget is Kiba's: the kiba profile ceiling, not the default profile's", () => {
    const snap = isolated({ limits: undefined, machine: { cores: 64, memAvailableGib: 256 } });
    expect(snap.budget.ceiling).toBe(loadProfile("kiba").limits.max_concurrent_ceiling);
  });

  test("outcomes inherit the latest run project and harness in activity", () => {
    const id = "lane-outcome";
    const snap = isolated({ ledger: [
      run({ id, repo: "/work/old", to: "claude" }),
      run({ id, repo: "/work/front", to: "codex", at: "2026-11-01T10:02:00Z" }),
      { kind: "outcome", id, at: "2026-11-01T10:03:00Z", outcome: "dropped", by: "gc" },
    ] });
    expect(snap.ledger[0]).toMatchObject({ id, kind: "outcome", project: "front", harness: "codex" });
    expect(snap.activity.find((event) => event.verb === "outcome")).toMatchObject({
      actor: { kind: "lane", id, project: "front", harness: "codex" },
      text: `dropped · ${id}`,
    });
  });

  test("empty when no presence and no lanes", () => {
    const snap = isolated();
    expect(snap.leads).toEqual([]);
    expect(snap.lanes).toEqual([]);
    expect(snap.projects).toEqual([]);
    expect(snap.spend).toEqual({ used: 0.12 });
  });



  test("lanes, activity and ledger drop prompts, diffs and secrets", () => {
    const lanes = [
      lane({ id: "run-1", to: "codex", repo: "/work/front", status: "running", started: "2026-11-01T11:00:00Z", model: "gpt-5.1", effort: "medium" }),
      lane({ id: "run-2", to: "grok", repo: "/work/front", status: "blocked", started: "2026-11-01T10:00:00Z" }),
    ];
    const rows = dashLanesOf(lanes, [run({ id: "run-2", repo: "/work/front", to: "grok", model: "grok-4", effort: "high" })]);
    expect(rows[0]).toMatchObject({ project: "front", status: "running", harness: "codex", model: "gpt-5.1", effort: "medium", ended: null });
    expect(activityFor("front", rows)).toBe("working");
    expect(activityFor("lab", rows)).toBe("idle");
    const snap = isolated({
      lanes,
      ledger: [run({ features: { files: ["secret.ts"], stacks: [], risk: [], objective: "SECRET PROMPT do not leak" } })],
      leads: [lead({ project: "front", activity: "working" })],
    });
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain("SECRET PROMPT");
    expect(raw).not.toContain("secret.ts");
    expect(raw).not.toContain("hmac");
    expect(dashLedgerOf([run()])[0]).toMatchObject({
      kind: "run",
      project: "orch",
      model: "claude-haiku-4-5",
      channel: "cli",
    });
    expect(dashLedgerOf([run()])[0]).not.toHaveProperty("features");
  });

  test("bus status is counts and neighbor names, never keys or bodies", () => {
    const snap = isolated({
      bus: {
        ...emptyBus(),
        active: true,
        mailboxes: [{
          project: "lab",
          inboxValid: 2,
          inboxInvalid: 1,
          acked: 0,
          escalated: 0,
          neighbors: [{ name: "front", role: "consumer" }],
        }],
      },
    });
    const raw = JSON.stringify(snap);
    expect(snap.bus.active).toBe(true);
    expect(snap.bus.mailboxes[0].neighbors[0].name).toBe("front");
    expect(raw).not.toContain("bus-keys");
    expect(raw).not.toContain("ORCH_BUS");
    expect(raw).not.toMatch(/hmac|TELEGRAM|ANTHROPIC_API|sk-ant-/i);
  });

  test("missing bus dir is an explicit inactive state", () => {
    const snap = isolated();
    expect(snap.bus).toEqual(emptyBus());
  });

  test("loadFixture reads the committed mock snapshot", () => {
    const snap = loadFixture(join(import.meta.dir, "fixtures/dash/snapshot.json"));
    expect(snap.leads).toHaveLength(2);
    expect(snap.projects.map((p) => p.name)).toEqual(["front", "lab", "notes"]);
    expect(snap.activity.length).toBeGreaterThan(0);
    expect(snap.working[0]?.laneId).toBe("20261101T090100-codex-1-aaaa");
    expect(new Set(snap.lanes.map((lane) => lane.life))).toEqual(new Set([
      "queued", "claimed", "running", "verify", "done", "failed", "blocked",
    ]));
    expect(snap.runtimes.some((r) => r.id === "host" && r.name === "kev")).toBe(true);
  });

  test("a running lane shows its progress.json; missing or corrupt files leave it null", () => {
    const lanesDir = join(root, "state", "lanes");
    const write = (id: string, body: string) => {
      mkdirSync(join(lanesDir, id), { recursive: true });
      writeFileSync(join(lanesDir, id, "progress.json"), body);
    };
    write("live-1", JSON.stringify({
      v: 1, harness: "claude", model: "claude-sonnet-5-5", effort: "medium", phase: "worker",
      started: "2026-11-01T11:58:00Z", updated: "2026-11-01T11:59:50Z", elapsedS: 110,
      turns: 4, toolCalls: 6, lastTool: "Edit", lastFile: "src/a.ts", filesTouched: 2, lastText: "Editing the helper now.",
    }));
    write("corrupt-1", "{oops");
    write("done-1", JSON.stringify({ v: 1, harness: "claude", started: "2026-11-01T10:00:00Z", phase: "done" }));
    const snap = isolated({
      lanes: [
        lane({ id: "live-1", to: "claude", repo: "/work/front", status: "running", started: "2026-11-01T11:58:00Z" }),
        lane({ id: "corrupt-1", to: "claude", repo: "/work/front", status: "running", started: "2026-11-01T11:00:00Z" }),
        lane({ id: "missing-1", to: "codex", repo: "/work/front", status: "running", started: "2026-11-01T10:30:00Z" }),
        lane({ id: "done-1", to: "claude", repo: "/work/front", status: "complete", started: "2026-11-01T10:00:00Z", ended: "2026-11-01T10:10:00Z" }),
      ],
    });
    const byId = Object.fromEntries(snap.lanes.map((l) => [l.id, l]));
    expect(byId["live-1"]).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(byId["live-1"].progress).toEqual({
      phase: "worker", updated: "2026-11-01T11:59:50Z", turns: 4, toolCalls: 6,
      lastTool: "Edit", lastFile: "src/a.ts", filesTouched: 2, lastText: "Editing the helper now.",
    });
    expect(byId["corrupt-1"].progress).toBeNull();
    expect(byId["missing-1"].progress).toBeNull();
    expect(byId["done-1"].progress).toBeNull();
    const live = snap.working.find((w) => w.laneId === "live-1")!;
    expect(live).toMatchObject({ live: true, harness: "claude", effort: "medium", elapsedSec: 120, toolCalls: 6, lastStep: "Edit · src/a.ts", lastText: "Editing the helper now." });
    expect(live.stream[0]).toBe("Dernière étape : Edit · src/a.ts");
    expect(snap.working.find((w) => w.laneId === "missing-1")).toMatchObject({ live: false, lastStep: null });
  });

  test("collectDash adds activity, working and runtimes without leaking logs", () => {
    const snap = isolated({
      lanes: [lane({ status: "running", repo: "/work/front", usage: { input: 8000, output: 2000 } })],
      leads: [lead({ project: "front", activity: "working" })],
      logs: [{ at: "2026-11-01T09:00:00Z", kind: "next", project: "front", text: "RESUME: suivre" }],
      installed: ["claude", "codex"],
      hostName: "kev",
    });
    expect(snap.lanes[0].life).toBe("running");
    expect(snap.working).toHaveLength(1);
    expect(snap.activity.some((e) => e.verb === "note NEXT")).toBe(true);
    expect(snap.runtimes[0].name).toBe("kev");
    expect(JSON.stringify(snap)).not.toContain("SECRET");
  });
});

describe("orch dash args", () => {
  test("defaults to localhost:7894", () => {
    expect(parseDashArgs([])).toEqual({ port: 7894, host: "127.0.0.1", interval: 2, fixture: undefined });
  });

  test("accepts --host override and rejects a bad port", () => {
    expect(parseDashArgs(["--host", "0.0.0.0", "--port", "9000", "--interval", "3"])).toEqual({
      port: 9000, host: "0.0.0.0", interval: 3, fixture: undefined,
    });
    expect(() => parseDashArgs(["--port", "0"])).toThrow(/port/);
    expect(() => parseDashArgs(["--interval", "0"])).toThrow(/interval/);
  });
});

describe("orch dash:dev", () => {
  test("defaults to localhost Vite :7894 and API :7895", () => {
    expect(parseDevEnv({})).toEqual({ host: "127.0.0.1", devPort: 7894, apiPort: 7895 });
    expect(parseDevEnv({ HOST: "0.0.0.0", DEV_PORT: "7900", DASH_API_PORT: "7901" })).toEqual({
      host: "0.0.0.0", devPort: 7900, apiPort: 7901,
    });
    expect(() => parseDevEnv({ DEV_PORT: "7894", DASH_API_PORT: "7894" })).toThrow(/differ/);
    expect(() => parseDevEnv({ DEV_PORT: "0" })).toThrow(/DEV_PORT/);
  });

  test("waitForApi succeeds on /api/health even when snapshot collection is slow", async () => {
    const dist = join(root, "dist-dev-health");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Tableau</title>");
    const slow = () => {
      const start = Date.now();
      while (Date.now() - start < 700) { /* block */ }
      return isolated() as DashSnapshot;
    };
    const server = serveDash({ host: "127.0.0.1", port: 0, collect: slow, dist });
    try {
      const url = `http://${server.hostname}:${server.port}/api/health`;
      await waitForApi(url, { waitMs: 6_000, requestTimeoutMs: 250 });
    } finally {
      server.stop(true);
    }
  });

  test("dashDev cleans up API child on wait failure", async () => {
    const devPort = await freePort();
    const apiPort = await freePort();
    const api = spawn("sleep", ["30"], { stdio: "ignore" });
    let spawnCalls = 0;
    let apiArgs: string[] = [];
    try {
      await expect(dashDev(
        { HOST: "127.0.0.1", DEV_PORT: String(devPort), DASH_API_PORT: String(apiPort), DASH_API_WAIT_MS: "1000" },
        {
          spawn: ((_cmd: string, args: string[]) => {
            spawnCalls += 1;
            apiArgs = args;
            return api as any;
          }) as any,
          waitForApi: async () => { throw new Error("forced wait failure"); },
        },
      )).rejects.toThrow(/forced wait failure/);
      expect(spawnCalls).toBe(1);
      // The API reloads on a backend edit and never reads the repo `.env` itself.
      expect(apiArgs.slice(0, 3)).toEqual(["--watch", "--no-env-file", "src/orch.ts"]);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && api.exitCode == null && api.signalCode == null) await Bun.sleep(50);
      expect(api.exitCode != null || api.signalCode != null).toBe(true);
    } finally {
      try { api.kill("SIGKILL"); } catch { /* no-op */ }
    }
  });

  test("dashDev reports a clear message when API exits early", async () => {
    const devPort = await freePort();
    const apiPort = await freePort();
    await expect(dashDev(
      { HOST: "127.0.0.1", DEV_PORT: String(devPort), DASH_API_PORT: String(apiPort), DASH_API_WAIT_MS: "1500" },
      {
        spawn: () => spawn("bash", ["-lc", "exit 1"], { stdio: "ignore" }) as any,
      },
    )).rejects.toThrow(/run `make stop`/);
  });
});

const summary = (over: Partial<ProviderUsageSummary> = {}): ProviderUsageSummary => ({
  at: "2026-11-01T12:00:00.000Z",
  home: root,
  claude: { byDay: { "2026-11-01": { tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 } }, lastMtimeMs: 0 },
  codex: { files: [], primary: [{ at: "2026-11-01T11:50:00.000Z", p: 42, w: 300 }], secondary: [] },
  grok: { byDay: {}, quota: [] },
  errors: {},
  ...over,
});

function slowRunner(ms: number, result = summary()): ProviderSyncRunner & { runs: number } {
  const runner = {
    runs: 0,
    async run() {
      runner.runs++;
      await Bun.sleep(ms);
      return result;
    },
    stop() {},
  };
  return runner;
}

const live = (args: { providerSummary: ProviderUsageSummary | null; providersSyncing: boolean }) =>
  isolated({ ...args, installed: ["claude", "codex", "grok"] });

describe("orch dash HTTP", () => {
  test("snapshot, SSE and SPA fallback stay read-only and secret-free", async () => {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Tableau</title>");
    const snap = isolated({ leads: [lead()], lanes: [lane({ status: "running", repo: "/work/lab" })] }) as DashSnapshot;
    const server = serveDash({
      host: "127.0.0.1",
      port: 0,
      intervalSec: 0.2,
      collect: () => snap,
      dist,
    });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const posted = await fetch(`${base}/api/snapshot`, { method: "POST" });
      expect(posted.status).toBe(405);
      const res = await fetch(`${base}/api/snapshot`);
      expect(res.status).toBe(200);
      const body = await res.json() as DashSnapshot;
      expect(body.leads[0].pid).toBe(4242);
      expect(JSON.stringify(body)).not.toContain("SECRET");
      const html = await fetch(`${base}/projects/lab`);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain("Tableau");
      const missing = await fetch(`${base}/api/secret`);
      expect(missing.status).toBe(404);
      const stream = await fetch(`${base}/api/stream`);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body?.getReader();
      const chunk = await reader?.read();
      const text = new TextDecoder().decode(chunk?.value);
      expect(text).toContain("data: ");
      expect(text).toContain("\"leads\"");
      await reader?.cancel();
    } finally {
      server.stop(true);
    }
  });

  test("missing UI build is 503, not a crash", async () => {
    const server = serveDash({
      host: "127.0.0.1",
      port: 0,
      collect: () => isolated(),
      dist: join(root, "no-dist"),
    });
    try {
      const res = await fetch(`http://${server.hostname}:${server.port}/`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("UI not built");
    } finally {
      server.stop(true);
    }
  });

  test("orch dash serves cache-only snapshots; only --fixture passes a collector", () => {
    expect(dashServeOptions(parseDashArgs([]))?.collect).toBeUndefined();
    const fixture = join(root, "fixture.json");
    writeFileSync(fixture, JSON.stringify(isolated()));
    expect(typeof dashServeOptions(parseDashArgs(["--fixture", fixture]))?.collect).toBe("function");
  });

  test("first snapshot with no cache is fast, syncing and shows loading quotas", async () => {
    const dist = join(root, "dist-fast-snapshot");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Tableau</title>");
    const runner = slowRunner(750);
    const seen: Array<ProviderUsageSummary | null> = [];
    const server = serveDash({
      host: "127.0.0.1",
      port: 0,
      dist,
      providerSync: runner,
      collectWith: (args) => {
        seen.push(args.providerSummary);
        return live(args);
      },
    });
    try {
      const opens = providerIoStatsForTests().opens;
      const t0 = Date.now();
      const res = await fetch(`http://${server.hostname}:${server.port}/api/snapshot`);
      const ms = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(450);
      // The request path never reads a provider log.
      expect(providerIoStatsForTests().opens).toBe(opens);
      const body = await res.json() as DashSnapshot;
      expect(body.providersSyncing).toBe(true);
      expect(seen[0]).toBeNull();
      for (const id of ["claude", "codex", "grok"]) {
        const rt = body.runtimes.find((row) => row.id === id);
        expect(rt?.limits?.loading).toBe(true);
        expect(rt?.limits?.unavailable).toBeUndefined();
      }
      const deadline = Date.now() + 3_000;
      let after = body;
      while (after.providersSyncing && Date.now() < deadline) {
        await Bun.sleep(50);
        after = await (await fetch(`http://${server.hostname}:${server.port}/api/snapshot`)).json() as DashSnapshot;
      }
      expect(after.providersSyncing).toBe(false);
      const codex = after.runtimes.find((row) => row.id === "codex");
      expect(codex?.limits?.loading).toBeUndefined();
      expect(codex?.limits?.windows.find((w) => w.id === "primary")?.usedPercent).toBe(42);
      expect(after.runtimes.find((row) => row.id === "claude")?.tokens).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("SSE pushes an update once background provider sync completes", async () => {
    const dist = join(root, "dist-sse-sync");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Tableau</title>");
    const server = serveDash({
      host: "127.0.0.1",
      port: 0,
      dist,
      providerSync: slowRunner(300),
      collectWith: live,
    });
    try {
      const stream = await fetch(`http://${server.hostname}:${server.port}/api/stream`);
      const reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      const text1 = new TextDecoder().decode(first?.value);
      expect(text1).toContain("\"providersSyncing\":true");
      let gotFalse = false;
      const readDeadline = Date.now() + 4_000;
      while (!gotFalse && Date.now() < readDeadline) {
        const next = await reader?.read();
        const text = new TextDecoder().decode(next?.value);
        if (text.includes("\"providersSyncing\":false")) gotFalse = true;
      }
      expect(gotFalse).toBe(true);
      await reader?.cancel();
    } finally {
      server.stop(true);
    }
  });

  test("background sync repeats on its interval, never overlapping, and stops with the server", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    let stopped = false;
    const runner: ProviderSyncRunner = {
      async run() {
        runs++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(60);
        running--;
        return summary();
      },
      stop() { stopped = true; },
    };
    const server = serveDash({ host: "127.0.0.1", port: 0, dist: join(root, "no-dist"), providerSync: runner, providerSyncMs: 20, collectWith: live });
    const deadline = Date.now() + 3_000;
    while (runs < 3 && Date.now() < deadline) await Bun.sleep(20);
    server.stop(true);
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(maxRunning).toBe(1);
    expect(stopped).toBe(true);
    const after = runs;
    await Bun.sleep(200);
    expect(runs).toBeLessThanOrEqual(after + 1);
  });

  test("the ingest worker reads provider logs off the main thread and posts a summary", async () => {
    const home = mkdtempSync(join(tmpdir(), "orch-dash-worker-"));
    try {
      const state = join(home, "state");
      const dir = join(home, ".claude", "projects", "-home-kev-lab-core");
      mkdirSync(dir, { recursive: true });
      const now = new Date();
      writeFileSync(join(dir, "s.jsonl"), `${JSON.stringify({
        timestamp: now.toISOString(),
        message: { id: "w1", model: "claude-opus-4-6", usage: { input_tokens: 11, output_tokens: 4 } },
      })}\n`);
      const runner = workerProviderSync({ home, state });
      try {
        const first = await runner.run(() => {});
        const days = Object.keys(first.claude.byDay);
        expect(days.length).toBe(1);
        const day = days[0]!;
        expect(first.claude.byDay[day]?.tokens.input).toBe(11);
        expect(existsSync(join(state, "dash-usage-cache.json"))).toBe(true);
        // A second pass in the same worker keeps its memory and stays correct.
        const second = await runner.run(() => {});
        expect(second.claude.byDay[day]?.tokens.input).toBe(11);
      } finally {
        runner.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("orch dash collector without a provider summary", () => {
  test("no cache: fast, syncing, loading quotas instead of no-data reasons", () => {
    const t0 = performance.now();
    const snap = live({ providerSummary: null, providersSyncing: true });
    expect(performance.now() - t0).toBeLessThan(450);
    expect(snap.providersSyncing).toBe(true);
    for (const id of ["codex", "grok"]) {
      const limits = snap.runtimes.find((row) => row.id === id)?.limits;
      expect(limits?.loading).toBe(true);
    }
    const done = live({ providerSummary: summary({ codex: { files: [], primary: [], secondary: [] } }), providersSyncing: false });
    const grok = done.runtimes.find((row) => row.id === "grok")?.limits;
    expect(grok?.loading).toBeUndefined();
    expect(grok?.unavailable).toContain("billing");
  });
});
