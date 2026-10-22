import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneAuto, laneGc, laneIntegrate, laneRun, listLanes } from "../src/lane.ts";
import { appendLedger, type LedgerRow, readLedger, type RunRecord } from "../src/lanes/ledger.ts";
import { declaredFiles, inScope, routeSpec, specFeatures, type SpecFeatures } from "../src/lanes/route.ts";
import { parseSpec } from "../src/lanes/spec.ts";
import { loadProfile, type Profile } from "../src/core/profile.ts";

const feat = (files: string[], risk: SpecFeatures["risk"] = []): SpecFeatures => ({
  files, stacks: specFeatures(parseSpec(`FILES: ${files.join(", ")}`)).stacks, risk, objective: "x",
});

function run(id: string, to: string, status: RunRecord["status"], stacks = ["typescript"]): RunRecord {
  return { kind: "run", id, at: "", repo: "r", to, model: "m", effort: "e", channel: "headless", status, changed: true, verifyOk: true,
    features: { files: [], stacks, risk: [], objective: "" }, diff: { files: [], insertions: 0, deletions: 0 }, outOfScope: [], durationS: 1, usage: {} };
}

function history(to: string, ok: number, ko: number): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < ok + ko; i++) {
    rows.push(run(`${to}-${i}`, to, "complete"));
    rows.push({ kind: "outcome", id: `${to}-${i}`, at: "", outcome: i < ok ? "integrated" : "dropped", by: "gc" });
  }
  return rows;
}

const three = ["src/a.ts", "src/b.ts", "tests/a.test.ts"];

describe("spec features", () => {
  test("FILES accepts bullets, commas, backticks and trailing notes", () => {
    expect(declaredFiles("- `src/a.ts` (new)\n* tests/a.test.ts, README.md\nnothing else\nMakefile")).toEqual(["src/a.ts", "tests/a.test.ts", "README.md", "Makefile"]);
  });

  test("risk comes from paths and from the RISK field, stacks from extensions", () => {
    const f = specFeatures(parseSpec("OBJECTIVE: o\nFILES: db/migrations/001.sql, src/auth/login.ts\nRISK: public-api"));
    expect(f.risk).toEqual(["migration", "security", "public-api"]);
    expect(f.stacks).toEqual(["sql", "typescript"]);
  });

  test("scope: exact path, directory prefix, globs", () => {
    expect(inScope("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(inScope("src/b.ts", ["src/a.ts"])).toBe(false);
    expect(inScope("src/x/y.ts", ["src/"])).toBe(true);
    expect(inScope("src/x.ts", ["src/*.ts"])).toBe(true);
    expect(inScope("src/x/y.ts", ["src/*.ts"])).toBe(false);
    expect(inScope("src/x/y.ts", ["src/**.ts"])).toBe(true);
  });
});

describe("routeSpec", () => {
  const installed = ["codex", "claude", "grok"] as const;

  test("two declared files or fewer stay with the lead", () => {
    expect(routeSpec(feat(["src/a.ts", "src/b.ts"]), [], { installed: [...installed] }).action).toBe("self");
  });

  test("no evidence: first installed harness in the configured order", () => {
    const r = routeSpec(feat(three), [], { installed: ["claude", "grok"] });
    expect(r).toMatchObject({ action: "lane", to: "claude", review: "none" });
  });

  test("a measured good record outranks the order", () => {
    const r = routeSpec(feat(three), [...history("claude", 5, 0), ...history("codex", 1, 4)], { installed: [...installed] });
    expect(r.to).toBe("claude");
    expect(r.reasons[0]).toContain("claude: 5/5 integrated on typescript");
  });

  test("a measured bad record is skipped when nobody is good yet", () => {
    const r = routeSpec(feat(three), history("codex", 0, 5), { installed: [...installed] });
    expect(r.to).toBe("claude");
  });

  test("failed and timeout runs count against a harness, noop and unavailable do not", () => {
    const rows = [...["failed", "timeout", "refused", "failed", "failed"].map((s, i) => run(`f${i}`, "codex", s as RunRecord["status"])),
      run("n", "codex", "noop"), run("u", "codex", "unavailable")];
    const r = routeSpec(feat(three), rows, { installed: [...installed] });
    expect(r.stats.find((s) => s.to === "codex")).toMatchObject({ n: 5, ok: 0 });
    expect(r.to).toBe("claude");
  });

  test("risk asks for a high review; --to overrides the size rule", () => {
    const r = routeSpec(feat(["src/auth.ts"], ["security"]), [], { installed: [...installed], to: "grok" });
    expect(r).toMatchObject({ action: "lane", to: "grok", review: "high" });
  });
});

describe("ledger and integration gate", () => {
  let root: string, repo: string, bin: string;
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_STATE: process.env.ORCH_STATE, ORCH_LANE: process.env.ORCH_LANE };
  const base = loadProfile("max20");
  const profile: Profile = { ...base, limits: { ...base.limits, report_max_bytes: 8192, timeout_seconds: 30 } };
  const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  const fake = (body: string) => {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
    chmodSync(join(bin, "codex"), 0o755);
  };
  const spec = (files: string, extra = "") => {
    const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, `OBJECTIVE: write files\nFILES: ${files}\nINTERFACES: none\nCONSTRAINTS: none\nVERIFY: test -f a.txt\nACCEPT: a.txt exists\n${extra}`);
    return p;
  };

  beforeAll(() => {
    delete process.env.ORCH_LANE;
    root = mkdtempSync(join(tmpdir(), "route-test-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    sh(repo, "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feat/x");
    process.env.ORCH_STATE = join(root, "state");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = join(root, "home");
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });

  test("a run is logged; an in-scope green lane integrates into the feature branch tree", async () => {
    fake("echo a > a.txt; echo b > b.txt");
    const { state, report } = await laneRun({ to: "codex", specPath: spec("a.txt, b.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain(`GATE: lane integrate ${state!.id}`);
    const row = readLedger().find((r) => r.id === state!.id && r.kind === "run") as RunRecord;
    expect(row).toMatchObject({ to: "codex", status: "complete", verifyOk: true, outOfScope: [], diff: { files: ["a.txt", "b.txt"], insertions: 2 } });

    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(true);
    expect(gate.report).toContain("STATUS: integrated");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
    expect(listLanes().some((l) => l.id === state!.id)).toBe(false);
    expect(readLedger().find((r) => r.id === state!.id && r.kind === "outcome")).toMatchObject({ outcome: "integrated", by: "integrate" });
    sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -q -m one");
  });

  test("the gate refuses a file outside FILES, a risky spec without review, and the default branch", async () => {
    fake("echo c > a.txt; echo x > stray.txt");
    const out = await laneRun({ to: "codex", specPath: spec("a.txt"), repo, profile });
    expect(out.report).toContain("SCOPE: 1 file(s) outside FILES: stray.txt");
    const scope = await laneIntegrate(out.state!.id);
    expect(scope.integrated).toBe(false);
    expect(scope.report).toContain("GATE: 1 file(s) outside FILES: stray.txt");
    expect(existsSync(join(repo, "stray.txt"))).toBe(false);

    fake("echo d > a.txt");
    const risky = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    expect((await laneIntegrate(risky.state!.id)).report).toContain("GATE: risk security: run lane review");

    sh(repo, "git checkout -q main");
    const onMain = await laneIntegrate(risky.state!.id, { reviewed: true });
    expect(onMain.report).toContain("GATE: caller repo is on main");
    sh(repo, "git checkout -q feat/x");
    expect((await laneIntegrate(risky.state!.id, { reviewed: true })).integrated).toBe(true);

    expect(laneGc(out.state!.id)).toContain(`removed ${out.state!.id}`);
    expect(readLedger().find((r) => r.id === out.state!.id && r.kind === "outcome")).toMatchObject({ outcome: "dropped", by: "gc" });
  });

  test("auto: an inline-sized spec runs nothing; a larger one routes, runs and integrates", async () => {
    sh(repo, "git checkout -q -- . && git clean -qfd");
    const before = readLedger().length;
    const small = await laneAuto({ specPath: spec("a.txt"), repo, profile });
    expect(small.report).toContain("ACTION: self");
    expect(readLedger().length).toBe(before);

    fake("echo e > a.txt; echo f > b.txt; echo g > c.txt");
    const big = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt"), repo, profile });
    expect(big.report).toContain("ACTION: lane --to codex");
    expect(big.report).toContain("STATUS: integrated");
    expect(big.integrated).toBe(true);
    expect(readFileSync(join(repo, "c.txt"), "utf8")).toBe("g\n");
  });

  test("a torn ledger line is skipped", () => {
    appendLedger({ kind: "outcome", id: "z", at: "", outcome: "nochange", by: "gc" });
    writeFileSync(join(process.env.ORCH_STATE!, "lanes.jsonl"), `${readFileSync(join(process.env.ORCH_STATE!, "lanes.jsonl"), "utf8")}{"kind":"run",`);
    expect(readLedger().some((r) => r.id === "z")).toBe(true);
  });
});
