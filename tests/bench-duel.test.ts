// bench/duel: the orch serve arm runs the production engine end to end (task,
// worker, VERIFY gate, local delivery, merge) and the judge scores it like
// the session arms. Fake claude only: no model call.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { judge, serveFiles, serveObjective, summarize, type ArmRun } from "../bench/duel/run.ts";
import type { ServeFeatureConfig, ServeFeatureResult } from "../bench/duel/serve-arm.ts";
import { createToyRepo, loadWorkload } from "../bench/versus/workload.ts";
import { fakeClaude, tempEnv } from "./e2e/kiba/harness.ts";

const CLAMP = `export function clamp(x: number, min: number, max: number): number {\n  if (min > max) throw new Error("min > max");\n  return Math.min(max, Math.max(min, x));\n}\n`;

test("serve arm: one feature goes through worker, gate and local delivery, then is judged", () => {
  const fx = tempEnv();
  try {
    const w = loadWorkload(), t = w.tasks.find((x) => x.id === "T2")!;
    const repo = createToyRepo(w, "toy-", fx.root);
    for (const args of [["checkout", "-q", "-b", "develop"], ["config", "user.name", "agent-local"], ["config", "user.email", "agent-local@localhost"]]) spawnSync("git", args, { cwd: repo, env: fx.env });
    const math = readFileSync(join(repo, "src/math.ts"), "utf8");
    fakeClaude(fx, { files: { "src/math.ts": `${math}\n${CLAMP}`, "tests/clamp.test.ts": `import { expect, test } from "bun:test";\nimport { clamp } from "../src/math.ts";\ntest("clamp", () => expect(clamp(5, 0, 3)).toBe(3));\n` }, costUSD: 0.2, result: "clamp added" });
    const since = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const c: ServeFeatureConfig = { root: fx.env.ORCH_STATE!, repo, base: "develop", objective: serveObjective(t), files: serveFiles(t), verify: "bun test",
      risky: false, timeoutMs: 120_000, nudge: "go", out: join(fx.root, "result.json"), log: join(fx.root, "engine.log") };
    writeFileSync(join(fx.root, "config.json"), JSON.stringify(c));
    const p = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "../bench/duel/serve-arm.ts"), join(fx.root, "config.json")], { cwd: repo, env: fx.env, encoding: "utf8", timeout: 150_000 });
    const r = JSON.parse(readFileSync(c.out, "utf8")) as ServeFeatureResult;
    expect({ exit: p.status, state: r.state, delivered: r.delivered, merged: r.merged, cost: r.cost, complete: r.costComplete }).toEqual({ exit: 0, state: "ended", delivered: true, merged: true, cost: 0.2, complete: true });
    expect(judge(repo, t, since)).toEqual({ accepted: true, suiteGreen: true, outside: [] });
  } finally { fx.cleanup(); }
}, 180_000);

test("summary: quality counts, totals and ratios against plain claude", () => {
  const f = (cost: number, seconds: number, accepted: boolean) => ({ task: "T", seconds, cost, costComplete: true, accepted, suiteGreen: accepted, outside: [], nudges: 0, timedOut: false, models: ["m"] });
  const runs: ArmRun[] = [
    { arm: "claude", rep: 1, repo: "", features: [f(1, 10, true), f(1, 10, false)], finalAccepted: { a: true, b: false } },
    { arm: "serve", rep: 1, repo: "", features: [f(0.5, 15, true), f(1, 15, true)], finalAccepted: { a: true, b: true } },
  ];
  const [claude, serve] = summarize(runs);
  expect([claude!.accepted, claude!.finalAccepted, serve!.accepted, serve!.finalAccepted]).toEqual([1, 1, 2, 2]);
  expect([serve!.cost, serve!.costVsClaude, serve!.timeVsClaude]).toEqual([1.5, -0.25, 0.5]);
});
