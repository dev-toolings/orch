import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, type Profile } from "../../../src/core/profile.ts";
import { readHolds } from "../../../src/core/policy.ts";
import { batchExitCode, laneBatch } from "../../../src/lanes/mission.ts";
import { fakeCodex } from "./harness.ts";

const SPEC = (file: string) => `OBJECTIVE: create ${file}
FILES: ${file}
INTERFACES: none
CONSTRAINTS: touch nothing else
VERIFY: test -f ${file}
ACCEPT: ${file} exists
`;

let root: string;
let repo: string;
let bin: string;
const saved: Record<string, string | undefined> = {};
const loaded = loadProfile("max20");
const profile: Profile = { ...loaded, limits: { ...loaded.limits, timeout_seconds: 20 } };

function sh(cwd: string, cmd: string) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-mission-e2e-"));
  repo = join(root, "repo");
  bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  sh(repo, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feature");
  fakeCodex({ bin }, `
const file = /^FILES:\\s+(\\S+)/m.exec(prompt)?.[1];
if (!file) throw new Error("fake codex: no FILES line");
return { files: { [file]: "ok\\n" } };
`);
  for (const key of ["PATH", "ORCH_STATE", "ORCH_POLICY", "ORCH_PAUSE", "ORCH_LANE", "HOME", "ORCH_HOME"]) {
    saved[key] = process.env[key];
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.ORCH_STATE = join(root, "state");
  mkdirSync(process.env.ORCH_STATE, { recursive: true });
  const policy = join(root, "policy.yaml");
  writeFileSync(policy, "spend:\n  daily_usd: 5\n  embed_usd_per_million: 0.02\npaid_routines: []\n");
  process.env.ORCH_POLICY = policy;
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.ORCH_HOME;
  delete process.env.ORCH_PAUSE;
  delete process.env.ORCH_LANE;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("mission e2e", () => {
  test("runs a dependent DAG through the real post-lane path", async () => {
    const specs = join(root, "specs");
    mkdirSync(specs, { recursive: true });
    const types = join(specs, "types.txt");
    const docs = join(specs, "docs.txt");
    writeFileSync(types, SPEC("types.txt"));
    writeFileSync(docs, SPEC("docs.txt"));
    const mission = join(root, "mission.yaml");
    writeFileSync(mission, `
name: e2e
concurrency: 1
nodes:
  - id: types
    spec: ${types}
  - id: docs
    spec: ${docs}
    needs: [types]
`);
    const { status, report, nodes } = await laneBatch({
      missionPath: mission, repo, profile, to: "codex",
    });
    expect(status).toBe("complete");
    expect(nodes.map((n) => n.id)).toEqual(["types", "docs"]);
    expect(nodes.every((n) => n.mark === "prêt")).toBe(true);
    expect(nodes.every((n) => n.touched)).toBe(true);
    expect(nodes.every((n) => n.laneId)).toBe(true);
    expect(report).toContain("MISSION REPORT");
    expect(report).toContain("STATUS: complete");
    expect(report).toContain("NODE types: prêt");
    expect(report).toContain("NODE docs: prêt");
    expect(report).toContain("RECAP: 2 prêt, 0 bloqué, 0 skipped, 2 touché");
    expect(report).toContain("LANE REPORT");
    expect(report).toContain("STATUS: integrated");
    expect(batchExitCode(status, nodes)).toBe(0);
    expect(readHolds().filter((h) => h.source.startsWith("mission:"))).toEqual([]);
  }, 30000);
});
