import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateRun, compareRuns, fingerprint, getBaseline, history, invalidateRun, setBaseline, type BenchObservation } from "../src/bench/index.ts";
import { runMemoryContract } from "../src/bench/suites/memory-contract.ts";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "orch-bench-"));
  roots.push(path);
  return path;
}

function unlockTree(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) unlockTree(child);
    else if (lstatSync(child).isSymbolicLink()) continue;
    else chmodSync(child, 0o644);
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    unlockTree(path);
    rmSync(path, { recursive: true, force: true });
  }
});

const options = (base: string, overrides: Partial<Parameters<typeof allocateRun>[0]> = {}) => ({
  suite: "fixture", feature: "memory-recall", source: { revision: "abc123", dirtyHash: null },
  corpus: { cases: ["one", "two"] }, settings: { temperature: 0 }, models: ["fake-model"],
  protocol: { version: 1, judge: "fixed" }, paid: false, root: base, ...overrides,
});

function finish(run: ReturnType<typeof allocateRun>, observations: BenchObservation[]) {
  return run.finalize(observations);
}

describe("benchmark run store", () => {
  test("invalidation preserves sealed evidence and blocks baseline and comparison use", () => {
    const base = root();
    const run = allocateRun(options(base));
    run.finalize([{ caseId: "one", config: "C", attempt: 1, quality: 1 }]);
    const before = readFileSync(join(run.outDir, "manifest.json"), "utf8");
    setBaseline("fixture", run.id, "default", base);
    invalidateRun(run.id, "answer-key leakage", base);
    expect(readFileSync(join(run.outDir, "manifest.json"), "utf8")).toBe(before);
    expect(history("fixture", base)[0].invalidation?.reason).toBe("answer-key leakage");
    expect(() => setBaseline("fixture", run.id, "next", base)).toThrow("invalidated");
    expect(() => compareRuns(run.id, run.id, base)).toThrow("invalidated");
    expect(() => invalidateRun(run.id, "rewrite", base)).toThrow();
  });

  test("fingerprints structured settings without depending on object key order", () => {
    expect(fingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(fingerprint({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test("allocates an exclusive run directory and per-config state namespaces", () => {
    const base = root();
    const first = allocateRun(options(base));
    const second = allocateRun(options(base));
    expect(first.id).not.toBe(second.id);
    expect(first.outDir).not.toBe(second.outDir);
    expect(first.sessionNamespace).toMatch(/^bench-/);
    expect(first.bankId("C")).toBe(`${first.ownerPrefix}-C`);
    expect(first.stateDirFor("C")).not.toBe(first.stateDirFor("D"));
    expect(existsSync(first.stateDirFor("C"))).toBe(true);
    expect(JSON.parse(readFileSync(join(first.outDir, "manifest.json"), "utf8"))).toMatchObject({
      version: 1, id: first.id, suite: "fixture", feature: "memory-recall", status: "running",
      source: { revision: "abc123", dirtyHash: null },
    });
    expect(() => first.writeArtifact("capture.txt", "one")).not.toThrow();
    expect(() => first.writeArtifact("capture.txt", "two")).toThrow(/already exists|EEXIST/);
    expect(readFileSync(join(first.outDir, "capture.txt"), "utf8")).toBe("one");
  });

  test("dry-run allocates metadata and paths without creating state", () => {
    const base = root();
    const run = allocateRun(options(base, { dryRun: true }));
    expect(run.dryRun).toBe(true);
    expect(existsSync(run.outDir)).toBe(false);
    run.writeArtifact("ignored.txt", "ignored");
    expect(run.finalize([]).status).toBe("planned");
    expect(existsSync(run.outDir)).toBe(false);
  });

  test("finalizes metrics and artifacts as read-only and rejects later reuse", () => {
    const run = allocateRun(options(root()));
    run.writeArtifact("raw/output.txt", "captured");
    const manifest = finish(run, [{ caseId: "case-1", config: "A", attempt: 1, quality: 1, cost: 0.02, latencyMs: 120 }]);
    expect(manifest.status).toBe("complete");
    expect(manifest.artifacts?.map((artifact) => artifact.path)).toContain("metrics.json");
    expect(manifest.artifacts?.map((artifact) => artifact.path)).toContain("raw/output.txt");
    expect(statSync(run.outDir).mode & 0o222).toBe(0);
    expect(statSync(run.outDir).mode & 0o077).toBe(0);
    expect(statSync(join(run.outDir, "metrics.json")).mode & 0o222).toBe(0);
    expect(statSync(join(run.outDir, "metrics.json")).mode & 0o077).toBe(0);
    expect(() => run.writeArtifact("late.txt", "no")).toThrow(/finalized/);
    expect(() => run.finalize([])).toThrow(/finalized/);
  });

  test("history, named baseline, repeated attempts, and per-case deltas", () => {
    const base = root();
    const oldRun = allocateRun(options(base));
    finish(oldRun, [
      { caseId: "recall", config: "C", attempt: 1, quality: 1, cost: 0.1, latencyMs: 100 },
      { caseId: "recall", config: "C", attempt: 2, quality: 0.5, cost: 0.3, latencyMs: 300, error: "timeout" },
    ]);
    setBaseline("fixture", oldRun.id, "release", base);
    expect(getBaseline("fixture", "release", base)).toBe(oldRun.id);

    const newRun = allocateRun(options(base, { settings: { temperature: 0.2 } }));
    finish(newRun, [
      { caseId: "recall", config: "C", attempt: 1, quality: 1, cost: 0.2, latencyMs: 200 },
      { caseId: "recall", config: "C", attempt: 2, quality: 0.8, cost: 0.4, latencyMs: 400 },
    ]);
    const oldManifest = readFileSync(join(oldRun.outDir, "manifest.json"), "utf8");
    setBaseline("fixture", newRun.id, "release", base);
    expect(getBaseline("fixture", "release", base)).toBe(newRun.id);
    expect(readFileSync(join(oldRun.outDir, "manifest.json"), "utf8")).toBe(oldManifest);
    const runs = history("fixture", base);
    expect(runs.map((run) => run.id)).toContain(oldRun.id);
    expect(runs.map((run) => run.id)).toContain(newRun.id);

    const report = compareRuns(oldRun.id, newRun.id, base);
    expect(report.settingsChanged).toBe(true);
    expect(report.warnings).toContain("settings fingerprint differs between baseline and candidate");
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      caseId: "recall", config: "C",
      baseline: { attempts: 2, errors: 1, quality: { mean: 0.75, n: 2 }, cost: { mean: 0.2, n: 2 }, latencyMs: { mean: 200, n: 2 } },
      candidate: { attempts: 2, errors: 0, quality: { mean: 0.9, n: 2 }, cost: { mean: 0.30000000000000004, n: 2 }, latencyMs: { mean: 300, n: 2 } },
      delta: { quality: 0.15000000000000002, cost: 0.10000000000000003, latencyMs: 100, errorRate: -0.5 },
    });
  });

  test("rejects comparison when corpus, model, or protocol fingerprints differ", () => {
    const base = root();
    const original = allocateRun(options(base));
    finish(original, []);
    const variants = [
      { corpus: { cases: ["changed"] } },
      { models: ["other-model"] },
      { protocol: { version: 2 } },
    ];
    for (const variant of variants) {
      const candidate = allocateRun(options(base, variant));
      finish(candidate, []);
      expect(() => compareRuns(original.id, candidate.id, base)).toThrow(/incompatible runs/);
    }
  });

  test("flags default quality and error regressions and optional cost and latency limits", () => {
    const base = root();
    const oldRun = allocateRun(options(base));
    finish(oldRun, [{ caseId: "case", config: "C", attempt: 1, quality: 0.9, cost: 0.1, latencyMs: 100 }]);
    const candidate = allocateRun(options(base, { regressionPolicy: { maxCostIncrease: 0.04, maxLatencyIncreaseMs: 50 } }));
    finish(candidate, [{ caseId: "case", config: "C", attempt: 1, quality: 0.8, cost: 0.15, latencyMs: 200, error: "partial failure" }]);
    const report = compareRuns(oldRun.id, candidate.id, base);
    expect(report.regressions.map((item) => item.metric).sort()).toEqual(["cost", "errorRate", "latencyMs", "quality"]);
  });

  test("rejects tampered metrics and artifact writes through symlink parents", () => {
    const base = root();
    const oldRun = allocateRun(options(base));
    finish(oldRun, [{ caseId: "case", config: "C", attempt: 1, quality: 1 }]);
    const candidate = allocateRun(options(base));
    finish(candidate, [{ caseId: "case", config: "C", attempt: 1, quality: 1 }]);
    const metrics = join(oldRun.outDir, "metrics.json");
    chmodSync(metrics, 0o644);
    writeFileSync(metrics, JSON.stringify({ version: 1, observations: [] }));
    expect(() => compareRuns(oldRun.id, candidate.id, base)).toThrow(/artifact integrity check failed/);
    expect(() => setBaseline("fixture", oldRun.id, "default", base)).toThrow(/artifact integrity check failed/);

    const outside = join(base, "outside");
    const unfinalized = allocateRun(options(base));
    symlinkSync(outside, join(unfinalized.outDir, "linked"), "dir");
    expect(() => unfinalized.writeArtifact("linked/escape.txt", "no")).toThrow(/symbolic link parent/);
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
  });

  test("refuses to move a named baseline to a running or foreign suite run", () => {
    const base = root();
    const running = allocateRun(options(base));
    expect(() => setBaseline("fixture", running.id, "default", base)).toThrow(/not complete/);
    const other = allocateRun(options(base, { suite: "other" }));
    finish(other, []);
    expect(() => setBaseline("fixture", other.id, "default", base)).toThrow(/belongs to suite/);
  });

  test("missing candidate cases or quality measurements cannot silently pass comparison", () => {
    const base = root();
    const oldRun = allocateRun(options(base));
    finish(oldRun, [{ caseId: "missing", config: "C", attempt: 1, quality: 1 }, { caseId: "unscored", config: "C", attempt: 1, quality: 1 }]);
    const candidate = allocateRun(options(base));
    finish(candidate, [{ caseId: "unscored", config: "C", attempt: 1 }]);
    const report = compareRuns(oldRun.id, candidate.id, base);
    expect(report.regressions.map((r) => [r.caseId, r.metric])).toEqual([["missing", "coverage"], ["unscored", "coverage"]]);
    expect(report.warnings).toHaveLength(2);
  });

  test("paid comparisons reject model alias drift and incomplete runtime model provenance", () => {
    const base = root();
    const oldRun = allocateRun(options(base, { paid: true, models: ["alias"] }));
    oldRun.writeJsonArtifact("runtime-models.json", { models: ["resolved-one"], complete: true });
    finish(oldRun, []);
    const changed = allocateRun(options(base, { paid: true, models: ["alias"] }));
    changed.writeJsonArtifact("runtime-models.json", { models: ["resolved-two"], complete: true });
    finish(changed, []);
    expect(() => compareRuns(oldRun.id, changed.id, base)).toThrow("resolved runtime models");
    const unknown = allocateRun(options(base, { paid: true, models: ["alias"] }));
    unknown.writeJsonArtifact("runtime-models.json", { models: [], complete: false });
    finish(unknown, []);
    expect(() => compareRuns(oldRun.id, unknown.id, base)).toThrow("provenance incomplete");
  });

  test("runs the offline memory contract against source modules with synthetic recall only", async () => {
    const result = await runMemoryContract({ root: root() });
    expect(result.run.suite).toBe("memory-contract");
    expect(result.run.feature).toBe("memory-recall-and-reflection-guards");
    expect(result.observations.map((row) => row.caseId)).toEqual([
      "hook.oversized-first-small-later", "reflect.explicit-noop", "reflect.more-than-three-removals",
    ]);
    expect(result.observations.map((row) => row.quality)).toEqual([1, 1, 1]);
    expect(JSON.parse(readFileSync(join(result.run.outDir, "metrics.json"), "utf8")).observations).toHaveLength(3);
  });

  test("runs the offline contract from a detached ref worktree and removes it afterward", async () => {
    const fixture = join(root(), "repository");
    const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", join(import.meta.dir, ".."), fixture], { encoding: "utf8" });
    expect(cloned.status).toBe(0);
    symlinkSync(join(import.meta.dir, "../node_modules"), join(fixture, "node_modules"), "dir");
    const before = spawnSync("git", ["-C", fixture, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout;
    const base = root();
    const result = await runMemoryContract({ root: base, ref: "HEAD", repositoryRoot: fixture });
    const manifest = JSON.parse(readFileSync(join(result.run.outDir, "manifest.json"), "utf8"));
    const current = await runMemoryContract({ root: base });
    const after = spawnSync("git", ["-C", fixture, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout;
    expect(manifest.source).toMatchObject({ ref: "HEAD", dirtyHash: null });
    expect(manifest.source.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(after).toBe(before);
    expect(compareRuns(result.run.id, current.run.id, base).cases).toHaveLength(3);
  });
});
