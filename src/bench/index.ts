export { pool } from "../core/pool.ts";
export { claudeEnv, type ClaudeEnvCtx } from "./claude-env.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stateDir } from "../core/paths.ts";

export const BENCH_VERSION = 1 as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface SourceSnapshot {
  revision: string;
  dirtyHash: string | null;
  ref?: string;
}

export interface RunFingerprints {
  corpus: string;
  settings: string;
  models: string;
  protocol: string;
}

export interface RegressionPolicy {
  /** Candidate-minus-baseline quality below this value is a regression. Defaults to zero. */
  minQualityDelta?: number;
  /** Candidate-minus-baseline error rate above this value is a regression. Defaults to zero. */
  maxErrorRateIncrease?: number;
  /** Optional maximum absolute cost increase, in the suite's cost unit. */
  maxCostIncrease?: number;
  /** Optional maximum latency increase in milliseconds. */
  maxLatencyIncreaseMs?: number;
}

export interface NormalizedRegressionPolicy {
  minQualityDelta: number;
  maxErrorRateIncrease: number;
  maxCostIncrease?: number;
  maxLatencyIncreaseMs?: number;
}

export interface BenchManifest {
  version: typeof BENCH_VERSION;
  id: string;
  suite: string;
  feature: string;
  status: "running" | "complete" | "planned";
  createdAt: string;
  finishedAt?: string;
  invalidation?: { reason: string; createdAt: string };
  source: SourceSnapshot;
  fingerprints: RunFingerprints;
  regressionPolicy: RegressionPolicy;
  paid: boolean;
  artifacts?: { path: string; sha256: string; bytes: number }[];
}

export interface BenchObservation {
  caseId: string;
  config: string;
  attempt: number;
  quality?: number | null;
  cost?: number | null;
  latencyMs?: number | null;
  error?: string;
}

export interface BenchRunOptions {
  suite: string;
  feature: string;
  source: SourceSnapshot;
  corpus: unknown;
  settings: unknown;
  models: unknown;
  protocol: unknown;
  paid: boolean;
  regressionPolicy?: RegressionPolicy;
  /** Bench root, normally <orch state>/bench. Mainly useful for isolated runs and tests. */
  root?: string;
  /** Plans the UUID and paths without creating files or directories. */
  dryRun?: boolean;
}

export interface BenchRun {
  id: string;
  suite: string;
  feature: string;
  outDir: string;
  sessionNamespace: string;
  ownerPrefix: string;
  dryRun: boolean;
  stateDirFor(config: string): string;
  bankId(label: string): string;
  writeArtifact(path: string, contents: string | Uint8Array): void;
  writeJsonArtifact(path: string, value: unknown): void;
  finalize(observations: BenchObservation[], artifacts?: Record<string, string | Uint8Array>): BenchManifest;
}

export interface BenchAggregate {
  attempts: number;
  errors: number;
  errorRate: number | null;
  quality: { mean: number | null; n: number };
  cost: { mean: number | null; n: number };
  latencyMs: { mean: number | null; n: number };
}

export interface CaseComparison {
  caseId: string;
  config: string;
  baseline: BenchAggregate;
  candidate: BenchAggregate;
  delta: { quality: number | null; cost: number | null; latencyMs: number | null; errorRate: number | null };
}

export interface BenchComparison {
  baselineId: string;
  candidateId: string;
  compatible: true;
  settingsChanged: boolean;
  warnings: string[];
  regressionPolicy: NormalizedRegressionPolicy;
  regressions: Regression[];
  cases: CaseComparison[];
}

export interface Regression {
  caseId: string;
  config: string;
  metric: "quality" | "errorRate" | "cost" | "latencyMs" | "coverage";
  delta: number;
  threshold: number;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? '"$undefined"';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function validSlug(value: string, kind: string): string {
  if (!SLUG.test(value) || value === "." || value === "..") throw new Error(`bench: invalid ${kind} ${JSON.stringify(value)}`);
  return value;
}

function normalizePolicy(policy: RegressionPolicy = {}): NormalizedRegressionPolicy {
  const normalized = { minQualityDelta: 0, maxErrorRateIncrease: 0, ...policy };
  for (const [key, value] of Object.entries(normalized)) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`bench: regression policy ${key} must be finite`);
  }
  for (const key of ["maxErrorRateIncrease", "maxCostIncrease", "maxLatencyIncreaseMs"] as const) {
    const value = normalized[key];
    if (value !== undefined && value < 0) throw new Error(`bench: regression policy ${key} must be non-negative`);
  }
  return normalized;
}

function benchRoot(root?: string): string {
  return resolve(root ?? join(stateDir(), "bench"));
}

export function allocateRun(options: BenchRunOptions): BenchRun {
  const suite = validSlug(options.suite, "suite");
  const feature = validSlug(options.feature, "feature");
  if (!options.source.revision.trim()) throw new Error("bench: source revision is required");
  if (options.source.dirtyHash !== null && !options.source.dirtyHash.trim()) throw new Error("bench: dirty hash must be null or non-empty");
  const root = benchRoot(options.root);
  const id = randomUUID();
  const outDir = join(root, suite, id);
  const compactId = id.replaceAll("-", "");
  const namespace = `bench-${compactId.slice(0, 20)}`;
  const fingerprints: RunFingerprints = {
    corpus: fingerprint(options.corpus), settings: fingerprint(options.settings),
    models: fingerprint(options.models), protocol: fingerprint(options.protocol),
  };
  const regressionPolicy = normalizePolicy(options.regressionPolicy);
  const manifest: BenchManifest = {
    version: BENCH_VERSION, id, suite, feature, status: "running", createdAt: new Date().toISOString(),
    source: { ...options.source }, fingerprints, regressionPolicy, paid: options.paid,
  };
  let closed = false;

  if (!options.dryRun) {
    mkdirSync(join(root, suite), { recursive: true, mode: 0o700 });
    // mkdir without recursive is the ownership claim: an existing run path is never reused.
    mkdirSync(outDir, { mode: 0o700 });
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  function artifactPath(name: string): string {
    if (!name || name.includes("\0") || name === "manifest.json" || name === "metrics.json") throw new Error(`bench: reserved or invalid artifact path ${JSON.stringify(name)}`);
    const target = resolve(outDir, name);
    const rel = relative(outDir, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(target) !== target) throw new Error(`bench: artifact path escapes run directory: ${name}`);
    let parent = outDir;
    for (const part of rel.split(sep).slice(0, -1)) {
      parent = join(parent, part);
      let stat;
      try { stat = lstatSync(parent); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`bench: artifact path has a symbolic link parent: ${name}`);
      if (!stat.isDirectory()) throw new Error(`bench: artifact parent is not a directory: ${name}`);
    }
    return target;
  }

  function writeArtifact(name: string, contents: string | Uint8Array): void {
    if (closed) throw new Error(`bench: run ${id} is finalized`);
    if (options.dryRun) return;
    const target = artifactPath(name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
  }

  const run: BenchRun = {
    id, suite, feature, outDir, sessionNamespace: namespace, ownerPrefix: namespace, dryRun: options.dryRun ?? false,
    stateDirFor(config) {
      const safeConfig = validSlug(config, "config");
      const dir = join(outDir, "state", safeConfig);
      if (!closed && !options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    bankId(label) {
      const safeLabel = validSlug(label, "bank label");
      if (namespace.length + 1 + safeLabel.length > 63) throw new Error("bench: bank label is too long for a run-owned bank id");
      return `${namespace}-${safeLabel}`;
    },
    writeArtifact,
    writeJsonArtifact(name, value) { writeArtifact(name, `${JSON.stringify(value, null, 2)}\n`); },
    finalize(observations, artifacts = {}) {
      if (closed) throw new Error(`bench: run ${id} is finalized`);
      validateObservations(observations);
      if (options.dryRun) {
        closed = true;
        return { ...manifest, status: "planned", finishedAt: new Date().toISOString(), artifacts: [] };
      }
      for (const [name, contents] of Object.entries(artifacts)) writeArtifact(name, contents);
      writeFileSync(join(outDir, "metrics.json"), `${JSON.stringify({ version: BENCH_VERSION, observations }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const allArtifacts = listArtifacts(outDir).map(({ path, bytes }) => ({ path, bytes, sha256: hashFile(join(outDir, path)) }));
      const final: BenchManifest = { ...manifest, status: "complete", finishedAt: new Date().toISOString(), artifacts: allArtifacts };
      writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(final, null, 2)}\n`);
      lockTree(outDir);
      closed = true;
      return final;
    },
  };
  return run;
}

function validateObservations(observations: BenchObservation[]): void {
  const seen = new Set<string>();
  for (const item of observations) {
    if (!item.caseId.trim() || !SLUG.test(item.config) || !Number.isInteger(item.attempt) || item.attempt < 1) throw new Error("bench: each observation needs caseId, valid config, and positive attempt number");
    const key = JSON.stringify([item.config, item.caseId, item.attempt]);
    if (seen.has(key)) throw new Error(`bench: duplicate observation ${item.config}/${item.caseId} attempt ${item.attempt}`);
    seen.add(key);
    for (const key of ["quality", "cost", "latencyMs"] as const) {
      const value = item[key];
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`bench: ${key} must be a finite non-negative number`);
    }
    if (item.error !== undefined && !item.error.trim()) throw new Error("bench: error must be non-empty when provided");
  }
}

function listArtifacts(root: string): { path: string; bytes: number }[] {
  const found: { path: string; bytes: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`bench: symbolic links are not allowed in run artifacts: ${relative(root, absolute)}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        if (entry.name !== "manifest.json" || absolute !== join(root, "manifest.json")) found.push({ path: relative(root, absolute).split(sep).join("/"), bytes: statSync(absolute).size });
      }
      else throw new Error(`bench: unsupported artifact entry ${relative(root, absolute)}`);
    }
  };
  walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lockTree(root: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else chmodSync(path, 0o400);
    }
    chmodSync(dir, 0o500);
  };
  walk(root);
}

function readManifest(path: string): BenchManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BenchManifest;
  if (manifest.version !== BENCH_VERSION || !UUID.test(manifest.id) || !["running", "complete"].includes(manifest.status)) throw new Error(`bench: invalid manifest ${path}`);
  const invalidation = join(dirname(path), "..", "invalidations", `${manifest.id}.json`);
  if (existsSync(invalidation)) manifest.invalidation = JSON.parse(readFileSync(invalidation, "utf8"));
  return manifest;
}

function verifyArtifacts(run: { dir: string; manifest: BenchManifest }): void {
  if (run.manifest.invalidation) throw new Error(`bench: run ${run.manifest.id} invalidated: ${run.manifest.invalidation.reason}`);
  if (run.manifest.status !== "complete" || !run.manifest.artifacts) throw new Error(`bench: run ${run.manifest.id} has no finalized artifact index`);
  const actual = listArtifacts(run.dir).map(({ path, bytes }) => ({ path, bytes, sha256: hashFile(join(run.dir, path)) }));
  const expected = [...run.manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path));
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`bench: artifact integrity check failed for run ${run.manifest.id}`);
}

function findRun(runId: string, root?: string): { dir: string; manifest: BenchManifest } {
  if (!UUID.test(runId)) throw new Error(`bench: invalid run id ${runId}`);
  const base = benchRoot(root);
  if (!existsSync(base)) throw new Error(`bench: no run ${runId}`);
  for (const suiteEntry of readdirSync(base, { withFileTypes: true })) {
    if (!suiteEntry.isDirectory() || !SLUG.test(suiteEntry.name)) continue;
    const dir = join(base, suiteEntry.name, runId);
    const file = join(dir, "manifest.json");
    if (!existsSync(file)) continue;
    const manifest = readManifest(file);
    if (manifest.id !== runId || manifest.suite !== suiteEntry.name) throw new Error(`bench: manifest identity mismatch at ${dir}`);
    return { dir, manifest };
  }
  throw new Error(`bench: no run ${runId}`);
}

export function history(suite: string, root?: string): BenchManifest[] {
  const safeSuite = validSlug(suite, "suite");
  const dir = join(benchRoot(root), safeSuite);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && UUID.test(entry.name) && existsSync(join(dir, entry.name, "manifest.json")))
    .map((entry) => readManifest(join(dir, entry.name, "manifest.json")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function baselinePath(suite: string, name: string, root?: string): string {
  return join(benchRoot(root), validSlug(suite, "suite"), "baselines", `${validSlug(name, "baseline name")}.json`);
}

/** Preserve sealed evidence while excluding a subsequently invalid evaluation. */
export function invalidateRun(runId: string, reason: string, root?: string): void {
  if (!reason.trim()) throw new Error("bench: invalidation reason is required");
  const run = findRun(runId, root);
  const dir = join(benchRoot(root), run.manifest.suite, "invalidations");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ reason: reason.trim(), createdAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o400 });
}

export function setBaseline(suite: string, runId: string, name = "default", root?: string): void {
  const run = findRun(runId, root);
  if (run.manifest.suite !== suite) throw new Error(`bench: run ${runId} belongs to suite ${run.manifest.suite}, not ${suite}`);
  if (run.manifest.status !== "complete") throw new Error(`bench: run ${runId} is not complete`);
  verifyArtifacts(run);
  const path = baselinePath(suite, name, root);
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: BENCH_VERSION, suite, name, runId, updatedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, path);
}

export function getBaseline(suite: string, name = "default", root?: string): string | null {
  const path = baselinePath(suite, name, root);
  if (!existsSync(path)) return null;
  const entry = JSON.parse(readFileSync(path, "utf8")) as { version: number; suite: string; name: string; runId: string };
  if (entry.version !== BENCH_VERSION || entry.suite !== suite || entry.name !== name || !UUID.test(entry.runId)) throw new Error(`bench: invalid baseline pointer ${path}`);
  const run = findRun(entry.runId, root);
  if (run.manifest.suite !== suite || run.manifest.status !== "complete") throw new Error(`bench: baseline points to unavailable run ${entry.runId}`);
  verifyArtifacts(run);
  return entry.runId;
}

function readObservations(dir: string): BenchObservation[] {
  const doc = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as { version: number; observations: BenchObservation[] };
  if (doc.version !== BENCH_VERSION || !Array.isArray(doc.observations)) throw new Error(`bench: invalid metrics file in ${dir}`);
  validateObservations(doc.observations);
  return doc.observations;
}

function aggregate(rows: BenchObservation[]): BenchAggregate {
  const mean = (field: "quality" | "cost" | "latencyMs") => {
    const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, n: values.length };
  };
  const errors = rows.filter((row) => row.error !== undefined).length;
  return { attempts: rows.length, errors, errorRate: rows.length ? errors / rows.length : null, quality: mean("quality"), cost: mean("cost"), latencyMs: mean("latencyMs") };
}

function delta(a: number | null, b: number | null): number | null { return a === null || b === null ? null : b - a; }

function compatibilityFailures(a: BenchManifest, b: BenchManifest): string[] {
  const failures: string[] = [];
  if (a.suite !== b.suite) failures.push("suite");
  if (a.feature !== b.feature) failures.push("feature");
  if (a.paid !== b.paid) failures.push("execution mode");
  for (const key of ["corpus", "models", "protocol"] as const) if (a.fingerprints[key] !== b.fingerprints[key]) failures.push(`${key} fingerprint`);
  return failures;
}

export function compareRuns(baselineId: string, candidateId: string, root?: string): BenchComparison {
  const baseline = findRun(baselineId, root);
  const candidate = findRun(candidateId, root);
  for (const run of [baseline, candidate]) if (run.manifest.status !== "complete") throw new Error(`bench: run ${run.manifest.id} is not complete`);
  verifyArtifacts(baseline);
  verifyArtifacts(candidate);
  const failures = compatibilityFailures(baseline.manifest, candidate.manifest);
  if (baseline.manifest.paid || candidate.manifest.paid) {
    const runtimeModels = (run: { dir: string; manifest: BenchManifest }): string[] => {
      const file = join(run.dir, "runtime-models.json");
      if (!existsSync(file)) throw new Error(`bench: runtime model provenance missing for ${run.manifest.id}`);
      const value = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown; complete?: boolean };
      if (value.complete !== true || !Array.isArray(value.models) || value.models.length === 0 || value.models.some((m) => typeof m !== "string" || !m.trim())) throw new Error(`bench: runtime model provenance incomplete for ${run.manifest.id}`);
      return [...new Set(value.models as string[])].sort();
    };
    if (fingerprint(runtimeModels(baseline)) !== fingerprint(runtimeModels(candidate))) failures.push("resolved runtime models");
  }
  if (failures.length) throw new Error(`bench: incompatible runs (${failures.join(", ")})`);
  const left = readObservations(baseline.dir);
  const right = readObservations(candidate.dir);
  const keys = new Set([...left, ...right].map((row) => JSON.stringify([row.config, row.caseId])));
  const cases: CaseComparison[] = [];
  const regressions: Regression[] = [];
  const coverageWarnings: string[] = [];
  const policy = normalizePolicy(candidate.manifest.regressionPolicy);
  for (const key of keys) {
    const [config, caseId] = JSON.parse(key) as [string, string];
    const a = aggregate(left.filter((row) => row.config === config && row.caseId === caseId));
    const b = aggregate(right.filter((row) => row.config === config && row.caseId === caseId));
    const change = {
      quality: delta(a.quality.mean, b.quality.mean), cost: delta(a.cost.mean, b.cost.mean),
      latencyMs: delta(a.latencyMs.mean, b.latencyMs.mean), errorRate: delta(a.errorRate, b.errorRate),
    };
    cases.push({ caseId, config, baseline: a, candidate: b, delta: change });
    if (a.attempts > 0 && b.attempts === 0) {
      regressions.push({ caseId, config, metric: "coverage", delta: -a.attempts, threshold: 0 });
      coverageWarnings.push(`candidate has no attempts for ${config}/${caseId}`);
    } else if (a.quality.n > 0 && b.quality.n === 0) {
      regressions.push({ caseId, config, metric: "coverage", delta: -a.quality.n, threshold: 0 });
      coverageWarnings.push(`candidate has no quality measurement for ${config}/${caseId}`);
    }
    if (a.attempts === 0 && b.attempts > 0) coverageWarnings.push(`baseline has no attempts for ${config}/${caseId}`);
    if (change.quality !== null && change.quality < policy.minQualityDelta) regressions.push({ caseId, config, metric: "quality", delta: change.quality, threshold: policy.minQualityDelta });
    if (change.errorRate !== null && change.errorRate > policy.maxErrorRateIncrease) regressions.push({ caseId, config, metric: "errorRate", delta: change.errorRate, threshold: policy.maxErrorRateIncrease });
    if (policy.maxCostIncrease !== undefined && change.cost !== null && change.cost > policy.maxCostIncrease) regressions.push({ caseId, config, metric: "cost", delta: change.cost, threshold: policy.maxCostIncrease });
    if (policy.maxLatencyIncreaseMs !== undefined && change.latencyMs !== null && change.latencyMs > policy.maxLatencyIncreaseMs) regressions.push({ caseId, config, metric: "latencyMs", delta: change.latencyMs, threshold: policy.maxLatencyIncreaseMs });
  }
  cases.sort((a, b) => a.config.localeCompare(b.config) || a.caseId.localeCompare(b.caseId));
  const settingsChanged = baseline.manifest.fingerprints.settings !== candidate.manifest.fingerprints.settings;
  const warnings = [...(settingsChanged ? ["settings fingerprint differs between baseline and candidate"] : []), ...coverageWarnings];
  return { baselineId, candidateId, compatible: true, settingsChanged, warnings, regressionPolicy: policy, regressions, cases };
}
