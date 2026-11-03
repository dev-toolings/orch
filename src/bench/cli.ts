import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compareRuns, getBaseline, history, invalidateRun, setBaseline } from "./index.ts";
import { PARITY_STORE_SUITE } from "./suites/native-parity-fixture.ts";

const USAGE = `orch bench run <suite> [runner options] [--allow-paid] [--dry-run]
orch bench run memory-contract [--ref <gitref>] [--dry-run]
orch bench baseline set <suite> <run-id> [name]
orch bench compare <run-id> <run-id>
orch bench history <suite>
orch bench invalidate <run-id> --reason <reason>`;

interface RunnerAdapter { script: string; paid: boolean }

// native-parity keeps its runs and baselines under the suite key its sealed
// baseline native-parity-1 was recorded with (PARITY_STORE_SUITE).
const storeSuite = (suite: string) => suite === "native-parity" ? PARITY_STORE_SUITE : suite;

const adapters: Record<string, RunnerAdapter> = {
  memoire: { script: join(import.meta.dir, "../checks/memoire.ts"), paid: true },
  conso: { script: join(import.meta.dir, "../checks/conso.ts"), paid: true },
};

function logComparison(baselineId: string, candidateId: string): void {
  const result = compareRuns(baselineId, candidateId);
  console.log(`baseline ${result.baselineId}  candidate ${result.candidateId}`);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  if (!result.cases.length) {
    console.log("no case metrics");
    return;
  }
  console.log("config  case  quality (n)  cost (n)  latency ms (n)  errors/attempts  delta quality / cost / latency / error rate");
  for (const row of result.cases) {
    const fmt = (value: number | null, digits = 3) => value === null ? "-" : value.toFixed(digits);
    const d = row.delta;
    console.log(`${row.config}  ${row.caseId}  ${fmt(row.baseline.quality.mean)} (${row.baseline.quality.n}) -> ${fmt(row.candidate.quality.mean)} (${row.candidate.quality.n})  ${fmt(row.baseline.cost.mean)} (${row.baseline.cost.n}) -> ${fmt(row.candidate.cost.mean)} (${row.candidate.cost.n})  ${fmt(row.baseline.latencyMs.mean, 1)} (${row.baseline.latencyMs.n}) -> ${fmt(row.candidate.latencyMs.mean, 1)} (${row.candidate.latencyMs.n})  ${row.baseline.errors}/${row.baseline.attempts} -> ${row.candidate.errors}/${row.candidate.attempts}  ${fmt(d.quality)} / ${fmt(d.cost)} / ${fmt(d.latencyMs, 1)} / ${fmt(d.errorRate)}`);
  }
  if (result.regressions.length) {
    console.log("regressions:");
    for (const item of result.regressions) console.log(`  ${item.config}/${item.caseId} ${item.metric} delta ${item.delta.toFixed(4)} crossed threshold ${item.threshold.toFixed(4)}`);
    process.exitCode = 1;
  } else console.log("no regressions detected by the candidate policy");
}

/** Entry point for `orch bench ...`. Runner-specific options pass through unchanged. */
export async function bench(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "run") {
    const [suite, ...runnerArgs] = rest;
    if (!suite) throw new Error("bench run: suite is required");
    if (suite === "native-parity" || suite === "superagent-parity") {
      if (suite === "superagent-parity") console.error("note: suite superagent-parity is deprecated; use native-parity");
      const { runNativeParity } = await import("./suites/native-parity.ts");
      await runNativeParity(runnerArgs);
      return;
    }
    if (suite === "memory-contract") {
      if (runnerArgs.some((arg) => arg === "--out" || arg.startsWith("--out="))) throw new Error("bench run: custom output paths are disabled; every run gets an exclusive directory");
      let ref: string | undefined;
      let dryRun = false;
      for (let index = 0; index < runnerArgs.length; index++) {
        const arg = runnerArgs[index];
        if (arg === "--dry-run") dryRun = true;
        else if (arg === "--ref") {
          if (ref !== undefined || !runnerArgs[index + 1] || runnerArgs[index + 1].startsWith("--")) throw new Error("bench run memory-contract: --ref requires one Git ref");
          ref = runnerArgs[++index];
        } else if (arg.startsWith("--ref=")) {
          if (ref !== undefined || !arg.slice("--ref=".length)) throw new Error("bench run memory-contract: --ref requires one Git ref");
          ref = arg.slice("--ref=".length);
        } else if (arg === "--allow-paid") throw new Error("bench run memory-contract: this suite is offline and does not need --allow-paid");
        else throw new Error(`bench run memory-contract: unsupported option ${arg}`);
      }
      const { runMemoryContract } = await import("./suites/memory-contract.ts");
      const result = await runMemoryContract({ ref, dryRun });
      console.log(`${result.run.suite}  ${result.run.id}  ${result.run.dryRun ? "planned" : "complete"}  ${result.run.outDir}`);
      for (const row of result.observations) console.log(`${row.caseId}  quality ${row.quality ?? "-"}  cost ${row.cost ?? "-"}  ${row.latencyMs?.toFixed(1) ?? "-"} ms${row.error ? `  ERROR ${row.error}` : ""}`);
      return;
    }
    const adapter = adapters[suite];
    if (!adapter) throw new Error(`bench run: unknown suite ${suite}; available suites: ${[...Object.keys(adapters), "memory-contract", "native-parity"].join(", ")}`);
    const allowPaid = runnerArgs.includes("--allow-paid");
    const dryRun = runnerArgs.includes("--dry-run");
    const readOnlyUsage = suite === "conso" && runnerArgs.includes("--live");
    if (adapter.paid && !allowPaid && !dryRun && !readOnlyUsage) throw new Error(`bench run ${suite}: this suite can incur model charges; pass --allow-paid to run or --dry-run to preview`);
    if (runnerArgs.some((arg) => arg === "--out" || arg.startsWith("--out="))) throw new Error("bench run: custom output paths are disabled; every run gets an exclusive directory");
    const forwarded = runnerArgs.filter((arg) => arg !== "--allow-paid");
    const result = spawnSync(process.execPath, ["--no-env-file", adapter.script, ...forwarded], { stdio: "inherit" });
    if (result.error) throw new Error(`bench run ${suite}: could not start runner: ${result.error.message}`);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  if (command === "baseline") {
    if (rest[0] !== "set") throw new Error("bench baseline: expected `set <suite> <run-id> [name]`");
    if (rest.length < 3 || rest.length > 4) throw new Error("bench baseline set: expected <suite> <run-id> [name]");
    const [, suite, runId, name] = rest;
    if (!suite || !runId) throw new Error("bench baseline set: suite and run id are required");
    setBaseline(storeSuite(suite), runId, name);
    console.log(`baseline ${suite}/${name ?? "default"}: ${runId}`);
    return;
  }
  if (command === "compare") {
    const [baselineId, candidateId] = rest;
    if (!baselineId || !candidateId || rest.length !== 2) throw new Error("bench compare: expected <baseline-run-id> <candidate-run-id>");
    logComparison(baselineId, candidateId);
    return;
  }
  if (command === "invalidate") {
    const [id, flag, reason] = rest;
    if (rest.length !== 3 || flag !== "--reason" || !reason?.trim()) throw new Error("bench invalidate: expected <run-id> --reason <reason>");
    invalidateRun(id, reason);
    console.log(`invalidated ${id}: ${reason}`);
    return;
  }
  if (command === "history") {
    const [suite] = rest;
    if (!suite || rest.length !== 1) throw new Error("bench history: expected <suite>");
    const baseline = getBaseline(storeSuite(suite));
    const runs = history(storeSuite(suite));
    if (!runs.length) console.log(`no runs for ${suite}`);
    for (const run of runs) console.log(`${run.id}  ${(run.invalidation ? "invalid" : run.status).padEnd(8)} ${run.createdAt}  ${run.feature}  ${run.source.ref ?? run.source.revision}${baseline === run.id ? "  baseline" : ""}`);
    return;
  }
  console.log(USAGE);
  process.exitCode = 2;
}
