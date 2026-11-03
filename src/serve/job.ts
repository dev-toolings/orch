// One `orch serve` job process (execute, verify or review), detached in its
// own process group so it outlives an engine restart: the engine adopts it by
// pid and start time, or marks it interrupted when it died without a receipt.
// The job never writes the task journal; it leaves `receipt.json`, which the
// engine reconciles.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { loadProfile } from "../core/profile.ts";
import { pauseFile } from "../core/kill.ts";
import { atomicJson, processStamp, tasksDir, TaskStore, type JobReceipt } from "../core/tasks.ts";
import { withFileLock } from "../lanes/lock.ts";
import { claudeRuntime } from "./workers.ts";

export const jobDir = (root: string, id: string) => join(tasksDir(root), "jobs", id);

export interface JobContext { rung?: { model: string; effort: string }; budgetUsd: number; timeoutMs: number }

export async function runJob(root: string, id: string): Promise<void> {
  const store = new TaskStore(tasksDir(root)), dir = jobDir(root, id);
  const held = await withFileLock(join(dir, "job.lock"), async () => {
    if (existsSync(join(dir, "receipt.json"))) return;
    const s = store.read(), job = s.jobs[id], task = job ? s.tasks[job.task] : undefined;
    if (!job || !task || !["planned", "running"].includes(job.status) || task.stopped) return;
    // Identity first, under the lock and before any paid work: the engine
    // adopts this owner instead of launching another; PAUSE holds the job
    // unstarted (still planned) so nothing is spent.
    atomicJson(join(dir, "owner.json"), { pid: process.pid, start: processStamp(process.pid) });
    if (existsSync(pauseFile(root))) return;
    await store.started(id, process.pid);
    const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as JobContext;
    let receipt: JobReceipt;
    try {
      if (job.kind === "execute") {
        if (!task.worktree) throw new Error("task has no worktree");
        // A short TMPDIR of its own (107-byte socket limit), gone with the step.
        const tmpDir = mkdtempSync(join(tmpdir(), "orch-task-"));
        try {
          receipt = await claudeRuntime.step({ task, history: store.history(task.id, job.inputs, job.context), dir, worktree: task.worktree,
            tmpDir, home: join(tasksDir(root), "home", task.id), rung: ctx.rung ?? { model: "sonnet", effort: "medium" }, budgetUsd: ctx.budgetUsd, timeoutMs: ctx.timeoutMs });
        } finally { rmSync(tmpDir, { recursive: true, force: true }); }
      } else if (job.kind === "verify") {
        // The adopt path: commit the worktree, then VERIFY in a lane through
        // the lane check path (env allowlist, reach check, VERIFY_TIMEOUT_MS).
        const { adoptNative } = await import("../tasks/adopt.ts");
        const m = task.mandate;
        const { state } = await adoptNative({ repo: m.repo, worktree: task.worktree, files: m.files.join(","), verify: m.verify,
          goal: task.objective.split("\n")[0].slice(0, 200), risk: m.risk === "risky" ? "risky" : "normal", baseBranch: m.baseBranch });
        receipt = { ok: state.status === "complete", lane: state.id, sha: state.verifiedSha, changed: state.changed, ...(state.reason ? { error: state.reason } : {}) };
      } else {
        if (!task.lane) throw new Error("no verified lane to review");
        const { laneReviewLane } = await import("../lane.ts");
        const review = await laneReviewLane(task.lane, { from: "claude", profile: loadProfile("kiba"), goal: task.objective });
        receipt = { ok: review.verdict !== "unknown", verdict: review.verdict, result: review.report.slice(-600) };
      }
    } catch (e) { receipt = { ok: false, error: String(e).slice(0, 2000), cost: null, costComplete: false }; }
    atomicJson(join(dir, "receipt.json"), receipt);
  }, { waitMs: 0 });
  if (held === null) process.exitCode = 2;
}

if (import.meta.main) await runJob(process.argv[2] ?? stateDir(), process.argv[3]);
