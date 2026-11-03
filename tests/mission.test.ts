import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, type Profile } from "../src/core/profile.ts";
import { readHolds } from "../src/core/policy.ts";
import { laneReport } from "../src/lanes/report.ts";
import { batchExitCode, detectCycle, estimateMissionUsd, laneBatch, parseMission, readyNodes, summarizeLaneAuto } from "../src/lanes/mission.ts";

const SPEC = `OBJECTIVE: create out.txt
FILES: out.txt
INTERFACES: none
CONSTRAINTS: touch nothing else
VERIFY: test -f out.txt
ACCEPT: out.txt exists
`;

let root: string;
let savedPolicy: string | undefined;
let savedState: string | undefined;
let savedPause: string | undefined;
const profile: Profile = { ...loadProfile("max20"), limits: { ...loadProfile("max20").limits, timeout_seconds: 5 } };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-mission-"));
  savedPolicy = process.env.ORCH_POLICY;
  savedState = process.env.ORCH_STATE;
  savedPause = process.env.ORCH_PAUSE;
  process.env.ORCH_STATE = join(root, "state");
  mkdirSync(process.env.ORCH_STATE, { recursive: true });
  const policy = join(root, "policy.yaml");
  writeFileSync(policy, "spend:\n  daily_usd: 50\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
  process.env.ORCH_POLICY = policy;
  delete process.env.ORCH_PAUSE;
});

afterAll(() => {
  if (savedPolicy === undefined) delete process.env.ORCH_POLICY;
  else process.env.ORCH_POLICY = savedPolicy;
  if (savedState === undefined) delete process.env.ORCH_STATE;
  else process.env.ORCH_STATE = savedState;
  if (savedPause === undefined) delete process.env.ORCH_PAUSE;
  else process.env.ORCH_PAUSE = savedPause;
  rmSync(root, { recursive: true, force: true });
});

function specFile(name: string): string {
  const path = join(root, name);
  writeFileSync(path, SPEC);
  return path;
}

describe("mission graph", () => {
  test("parses a DAG, rejects a cycle and an unknown need", () => {
    const a = specFile("a.txt");
    const b = specFile("b.txt");
    const mission = parseMission(`
name: demo
concurrency: 2
nodes:
  - id: types
    spec: ${a}
  - id: api
    spec: ${b}
    needs: [types]
`, root);
    expect(mission.name).toBe("demo");
    expect(mission.concurrency).toBe(2);
    expect(readyNodes(mission.nodes, new Set()).map((n) => n.id)).toEqual(["types"]);
    expect(readyNodes(mission.nodes, new Set(["types"])).map((n) => n.id)).toEqual(["api"]);
    expect(detectCycle(mission.nodes)).toBeNull();
    expect(() => parseMission(`
nodes:
  - id: a
    spec: ${a}
    needs: [b]
  - id: b
    spec: ${b}
    needs: [a]
`, root)).toThrow(/cycle/);
    expect(() => parseMission(`
nodes:
  - id: a
    spec: ${a}
    needs: [ghost]
`, root)).toThrow(/unknown ghost/);
  });

  test("estimates a positive reserved budget from the specs", () => {
    const a = specFile("est-a.txt");
    const mission = parseMission(`name: est\nnodes:\n  - id: a\n    spec: ${a}\n`, root);
    expect(estimateMissionUsd(mission)).toBeGreaterThan(0);
  });
});

describe("lane batch", () => {
  test("does not refuse unsupervised work when the daily cap is null", async () => {
    const prev = process.env.ORCH_POLICY;
    const policy = join(root, "null-cap.yaml");
    writeFileSync(policy, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    process.env.ORCH_POLICY = policy;
    try {
      const spec = specFile("cap.txt");
      const mission = join(root, "no-cap.yaml");
      writeFileSync(mission, `name: nocap\nnodes:\n  - id: a\n    spec: ${spec}\n`);
      const { status, nodes } = await laneBatch({
        missionPath: mission, repo: root, profile,
        runNode: async () => ({ report: "LANE REPORT\nSTATUS: complete\nSTATUS: integrated\n", integrated: true, touched: true }),
      });
      expect(status).toBe("complete");
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.mark).toBe("prêt");
      expect(batchExitCode(status, nodes)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ORCH_POLICY;
      else process.env.ORCH_POLICY = prev;
    }
  });

  test("runs ready nodes, stops at the first blockage, and skips dependents", async () => {
    const a = specFile("run-a.txt");
    const b = specFile("run-b.txt");
    const c = specFile("run-c.txt");
    const mission = join(root, "graph.yaml");
    writeFileSync(mission, `
name: graph
concurrency: 2
nodes:
  - id: root
    spec: ${a}
  - id: ok
    spec: ${b}
    needs: [root]
  - id: child
    spec: ${c}
    needs: [ok]
`);
    const seen: string[] = [];
    const { status, report, nodes } = await laneBatch({
      missionPath: mission, repo: root, profile,
      runNode: async (node) => {
        seen.push(node.id);
        if (node.id === "ok") return { report: "LANE REPORT\nSTATUS: blocked\nREASON: VERIFY failed\n", integrated: false };
        return { report: "LANE REPORT\nSTATUS: complete\nCHANGES:\nout.txt | 1 +\nID: lane-x\nSTATUS: integrated\n", integrated: true, touched: true, files: ["out.txt"], laneId: `id-${node.id}` };
      },
    });
    expect(status).toBe("blocked");
    expect(seen).toEqual(["root", "ok"]);
    expect(nodes.find((n) => n.id === "root")?.mark).toBe("prêt");
    expect(nodes.find((n) => n.id === "ok")?.mark).toBe("bloqué");
    expect(nodes.find((n) => n.id === "child")?.mark).toBe("skipped");
    expect(report).toContain("RECAP:");
    expect(report).toContain("NODE root: prêt");
    expect(batchExitCode(status, nodes)).toBe(3);
  });

  test("re-checks ORCH_PAUSE between nodes", async () => {
    const a = specFile("pause-a.txt");
    const b = specFile("pause-b.txt");
    const mission = join(root, "pause.yaml");
    writeFileSync(mission, `
name: pause
nodes:
  - id: first
    spec: ${a}
  - id: second
    spec: ${b}
    needs: [first]
`);
    const { status, nodes } = await laneBatch({
      missionPath: mission, repo: root, profile,
      runNode: async (node) => {
        process.env.ORCH_PAUSE = "1";
        return { report: "LANE REPORT\nSTATUS: complete\nSTATUS: integrated\n", integrated: true, touched: true, laneId: node.id };
      },
    });
    expect(status).toBe("paused");
    expect(nodes.find((n) => n.id === "first")?.mark).toBe("prêt");
    expect(nodes.find((n) => n.id === "second")?.mark).toBe("skipped");
    expect(batchExitCode(status, nodes)).toBe(3);
    delete process.env.ORCH_PAUSE;
  });

  test("does not refuse when the reserved estimate exceeds the daily cap", async () => {
    const prev = process.env.ORCH_POLICY;
    const tight = join(root, "tight.yaml");
    writeFileSync(tight, "spend:\n  daily_usd: 0.0001\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    process.env.ORCH_POLICY = tight;
    try {
      const spec = specFile("tight.txt");
      const mission = join(root, "over.yaml");
      writeFileSync(mission, `name: over\nnodes:\n  - id: a\n    spec: ${spec}\n`);
      const { status, nodes } = await laneBatch({
        missionPath: mission, repo: root, profile,
        runNode: async () => ({ report: "LANE REPORT\nSTATUS: complete\nSTATUS: integrated\n", integrated: true, touched: true }),
      });
      expect(status).toBe("complete");
      expect(nodes[0]?.mark).toBe("prêt");
      expect(batchExitCode(status, nodes)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ORCH_POLICY;
      else process.env.ORCH_POLICY = prev;
    }
  });

  test("does not hand the lead history to a node, only its spec", async () => {
    const spec = specFile("hist.txt");
    const mission = join(root, "hist.yaml");
    writeFileSync(mission, `name: hist\nnodes:\n  - id: only\n    spec: ${spec}\n`);
    let seen = "";
    const { status, nodes } = await laneBatch({
      missionPath: mission, repo: root, profile,
      runNode: async (node) => {
        seen = node.spec;
        return { report: "LANE REPORT\nSTATUS: complete\nSTATUS: integrated\n", integrated: true };
      },
    });
    expect(seen).toBe(spec);
    expect(status).toBe("complete");
    expect(batchExitCode(status, nodes)).toBe(0);
  });

  test("lane batch with a null cap policy does not emit MISSION REFUSED", () => {
    const spec = specFile("cli-cap.txt");
    const mission = join(root, "cli-nocap.yaml");
    writeFileSync(mission, `name: cli\nnodes:\n  - id: a\n    spec: ${spec}\n  - id: b\n    spec: ${spec}\n`);
    const policy = join(root, "cli-nocap-policy.yaml");
    writeFileSync(policy, "spend:\n  daily_usd: null\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
    // A temporary repo passed explicitly and a PATH with no harness: the CLI
    // must neither branch the orch checkout nor start a real worker.
    const repo = join(root, "cli-repo");
    mkdirSync(repo);
    spawnSync("sh", ["-c", "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init"], { cwd: repo });
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/lane.ts"), "batch", "--mission", mission, "--repo", repo], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin", ORCH_POLICY: policy, ORCH_STATE: join(root, "state") },
    });
    expect(result.stdout).not.toContain("MISSION REFUSED");
    expect(result.stdout).toContain("MISSION REPORT");
  });

  test("batchExitCode is non-zero when any node is blocked", () => {
    expect(batchExitCode("complete", [])).toBe(0);
    expect(batchExitCode("complete", [{ id: "a", mark: "prêt", touched: false, files: [] }])).toBe(0);
    expect(batchExitCode("complete", [{ id: "a", mark: "bloqué", touched: false, files: [] }])).toBe(3);
    expect(batchExitCode("blocked", [{ id: "a", mark: "bloqué", touched: false, files: [] }])).toBe(3);
    expect(batchExitCode("refused")).toBe(3);
  });

  test("a completed lane whose gate refuses is blocked on the integrate status", async () => {
    const spec = specFile("gate.txt");
    const mission = join(root, "gate.yaml");
    writeFileSync(mission, `name: gate\nnodes:\n  - id: only\n    spec: ${spec}\n`);
    const report = laneReport({
      to: "claude", model: "inherited", effort: "default", status: "complete",
      id: "lane-gate", base: "abc", branch: "lane/gate", setupLine: "SETUP: none",
      stat: " out.txt | 1 +", verifyOut: "exit 0", message: "done", usage: {},
      changed: true, logPath: "/tmp/gate.log",
    }) + "LANE INTEGRATE\nSTATUS: refused\nID: lane-gate\nGATE: caller repo is on master\n";
    const { status, nodes } = await laneBatch({
      missionPath: mission, repo: root, profile,
      runNode: async () => ({ report, integrated: false, ...summarizeLaneAuto(report, false) }),
    });
    expect(status).toBe("blocked");
    expect(nodes[0]?.mark).toBe("bloqué");
    expect(nodes[0]?.reason).toBe("refused");
  });

  test("summarizeLaneAuto parses a real lane report, including SCOPE lines", () => {
    const report = laneReport({
      to: "claude", model: "inherited", effort: "default", status: "complete",
      id: "20261031-claude-demo", base: "abc123", branch: "lane/20261031-claude-demo",
      setupLine: "SETUP: none", stat: " types.txt | 1 +\n docs.txt | 1 +", verifyOut: "exit 0",
      message: "done", usage: { input: 12, output: 4 }, changed: true,
      logPath: "/tmp/lane.log", outOfScope: ["docs.txt", "extra.ts"],
    }) + "LANE INTEGRATE\nSTATUS: integrated\nID: 20261031-claude-demo\n";
    const out = summarizeLaneAuto(report, true);
    expect(out.laneId).toBe("20261031-claude-demo");
    expect(out.touched).toBe(true);
    expect(out.files).toEqual(["docs.txt", "extra.ts"]);
    const gated = `${report}LANE INTEGRATE\nSTATUS: refused\nID: 20261031-claude-demo\nGATE: default branch\n`;
    expect(summarizeLaneAuto(gated, false).laneId).toBe("20261031-claude-demo");
    const clean = summarizeLaneAuto(laneReport({
      to: "claude", model: "inherited", effort: "default", status: "complete",
      id: "lane-clean", base: "def", branch: "lane/clean", setupLine: "SETUP: none",
      stat: " types.txt | 1 +", verifyOut: "exit 0", message: "ok", usage: {},
      changed: true, logPath: "/tmp/ok.log",
    }), true);
    expect(clean.files).toEqual([]);
    expect(clean.touched).toBe(true);
  });

  test("a node crash still prints a RECAP, releases the hold, and exits non-zero", async () => {
    const a = specFile("crash-a.txt");
    const b = specFile("crash-b.txt");
    const mission = join(root, "crash.yaml");
    writeFileSync(mission, `
name: crash
nodes:
  - id: first
    spec: ${a}
  - id: child
    spec: ${b}
    needs: [first]
`);
    const { status, report, nodes } = await laneBatch({
      missionPath: mission, repo: root, profile,
      runNode: async (node) => {
        if (node.id === "first") {
          throw new Error("String.prototype.matchAll argument must not be a non-global regular expression");
        }
        throw new Error("must not run");
      },
    });
    expect(status).toBe("blocked");
    expect(nodes.find((n) => n.id === "first")?.mark).toBe("bloqué");
    expect(nodes.find((n) => n.id === "child")?.mark).toBe("skipped");
    expect(report).toContain("MISSION REPORT");
    expect(report).toContain("RECAP:");
    expect(report).toContain("NODE first: bloqué");
    expect(report).toMatch(/matchAll/);
    expect(batchExitCode(status, nodes)).toBe(3);
    expect(readHolds().filter((h) => h.source.startsWith("mission:"))).toEqual([]);
  });
});
