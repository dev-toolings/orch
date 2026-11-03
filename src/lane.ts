#!/usr/bin/env -S bun --no-env-file
// lane: hand one bounded task to another harness in its own git worktree.
// No model call happens in this process.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { git } from "./core/git.ts";
import { pinnedGrok, grokProfileInstalled } from "./harness/grok-runtime.ts";
import { addUsage, CLAUDE_CONTINUE, engineUnavailable, classify, classifyLog, finishLine, parseWorkerOutput, REVIEW_PREAMBLE, resolveLaneStatus, sessionCostDelta, sessionId, type Status, type Usage, workerArgv } from "./harness/harness.ts";
import { formatBrief } from "./lanes/brief.ts";
import { checkLane, formatCheck, verifiedCommit } from "./lanes/check.ts";
import { comparePlans, plannerOf } from "./lanes/plan.ts";
import { formatFindings, scoreFindings } from "./lanes/score.ts";
import { bound, tail } from "./core/output.ts";
import { bunCacheDir, stateDir } from "./core/paths.ts";
import { unattendedLeadMode } from "./core/lead-pulse.ts";
import { verifyReach } from "./lanes/reach.ts";
import { projectDir, projectKey } from "./core/project.ts";
import { HARNESSES, type Harness, loadProfile, type ModelChoice, type Profile, type ReviewChoice } from "./core/profile.ts";
import { applyRole, roleChoice, withExplicit } from "./core/roles.ts";
import { HARNESS_IDS, installed, type HarnessId, type Which } from "./harness/registry.ts";
import { laneDepth, onLaneStop, processGroupAlive, runLogged, workerEnv } from "./harness/proc.ts";
import { markEngineUnavailable, usableEngines } from "./harness/health.ts";
import { fmtUsage, laneReport, reviewReport } from "./lanes/report.ts";
import { recordSlotGroup, releaseSlot, reserveSlot } from "./lanes/slots.ts";
import { estimateConsultUsd, estimateLaneUsd, estimateUsageUsd } from "./core/paid.ts";
import { detectCodexAuthMode } from "./core/provider-auth.ts";
import { assertSpendAllowed, pauseReason, recordAgainstHold, recordSpend, releaseSpend, reserveSpend, type SpendEntry, type SpendHold } from "./core/policy.ts";
import { liveLaneBudget, type MachineFigures } from "./lanes/budget.ts";
import { EFFORTS, missingFields, parseSpec, type Spec } from "./lanes/spec.ts";
import { appendLedger, lastReview, parseVerdict, readLedger, summarize, type Outcome, type Verdict } from "./lanes/ledger.ts";
import { declaredFiles, inScope, type Risk, routeReport, routeSpec, specFailures, specFeatures } from "./lanes/route.ts";
import { kibaRoute, validateKibaConfig } from "./kiba/rules.ts";
import { addPathspec, clearSandboxPlaceholders, isHarnessOwned } from "./lanes/harness-files.ts";
import { neutralizeWorktreeHooks, protectedTouched, runBaseCommitVerify, VERIFY_TIMEOUT_MS } from "./lanes/protect.ts";
import { gateVerify, prePushFiles } from "./lanes/affected.ts";
import { emptyTiming, formatTiming, type GateTiming } from "./lanes/timing.ts";
import { tryLock, withFileLock } from "./lanes/lock.ts";
import { statusEntries, statusPaths, testRepoRefusal, workerBase } from "./lanes/worktree.ts";
import { orcaAttach, orcaDetach, orcaLaneWorktree, orcaLine, orcaRemoveWorktree, orcaRetire, orcaStatus, type OrcaSaved, type OrcaView } from "./lanes/orca.ts";
import { pruneOrcaGhosts } from "./lanes/orca-prune.ts";
import { ProgressTracker, type ProgressWatch, watchProgress } from "./lanes/progress.ts";
import { outsideWrites } from "./lanes/guard.ts";

// The worktree is a bare checkout: no installed dependencies, no gitignored
// local files. Without provisioning, a worker cannot run the project's checks
// and VERIFY fails on the missing toolchain, not on the change. The command
// runs here, before the worker, outside any worker sandbox and with network.
// Order: the spec's SETUP (`none` skips), then the project's unversioned
// `~/.orch/<project>/lane-setup` script, then a root bun.lock (`bun install
// --frozen-lockfile`). LANE_REPO and LANE_WORKTREE are set for the script.
// Only the spec's own command goes through a shell; paths never do.
export function setupCommand(spec: Spec, repo: string): { argv: string[]; display: string; source: string } | null {
  const asked = spec.fields.SETUP?.trim();
  if (asked) return asked === "none" ? null : { argv: ["sh", "-c", asked], display: asked, source: "spec SETUP" };
  const local = join(projectDir(repo), "lane-setup");
  if (existsSync(local)) return { argv: ["sh", local], display: local, source: "project lane-setup" };
  if (existsSync(join(repo, "bun.lock"))) {
    return { argv: ["bun", "install", "--frozen-lockfile"], display: "bun install --frozen-lockfile", source: "auto, bun.lock" };
  }
  return null;
}

function resolvedPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

export function saveLane(dir: string, state: LaneState): void {
  // One temporary file per writer: the lane, the dash and every watchdog may
  // write the same record, and a shared name makes one rename fail.
  const tmp = join(dir, `state.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, "state.json"));
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLane(dir: string): LaneState | null {
  try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as LaneState; } catch { return null; }
}

// One owner at a time for a lane's checkout: its own finalizer, lane follow,
// the reaper and gc (flock on <lane dir>/owner.lock, released when the holder
// dies). Returns the release, or null when still held after waitMs.
function lockLane(dir: string, waitMs = 0): (() => void) | null {
  let fd: number;
  try { fd = openSync(join(dir, "owner.lock"), "a"); } catch { return null; }
  const end = Date.now() + waitMs;
  for (;;) {
    let got = false;
    try { got = tryLock(fd); } catch { break; }
    if (got) return () => { try { closeSync(fd); } catch {} };
    if (Date.now() >= end) break;
    Bun.sleepSync(50);
  }
  try { closeSync(fd); } catch {}
  return null;
}

// Rescue git calls are bounded and never sign or run hooks: they also run in
// a stop handler that must end.
function gitBounded(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// Commits what an interrupted worker left in its worktree onto the lane
// branch, so the checkout can go without losing anything. Harness files stay
// out, as in a normal run. ok false: the work is only in the worktree, keep it.
// changed is unknown (undefined) when the worktree is already gone.
export function rescueWorktree(wt: string, base: string, id: string, declared: string[], why: string): { ok: boolean; changed?: boolean; saved: number } {
  if (!existsSync(wt)) return { ok: true, saved: 0 };
  const st = statusEntries(wt);
  if (st === null) return { ok: false, changed: true, saved: 0 };
  const own = statusPaths(st).filter((p) => !isHarnessOwned(p, declared));
  if (own.length) {
    const added = gitBounded(wt, "add", "-A", ...addPathspec(declared, wt));
    const committed = added.ok && gitBounded(wt, "-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit", "-q", "--no-verify", "-m",
      `lane ${id}: ${why}, uncommitted work saved`).ok;
    if (!committed) return { ok: false, changed: true, saved: 0 };
  }
  return { ok: true, changed: gitBounded(wt, "rev-list", "-n1", `${base}..HEAD`).out.length > 0, saved: own.length };
}

// Decides the checkout of a finished lane, under its owner lock: a lane past
// its snapshot keeps a dirty checkout (someone's work, never committed here);
// a lane cut short gets its leftovers committed on the branch; then the
// checkout goes. Records the decision (cleaned) so no pass repeats it.
function settleWorktree(dir: string, s: LaneState, why: string): { s: LaneState; note?: string; kept?: string } {
  if (!existsSync(s.worktree) || resolvedPath(s.worktree) === resolvedPath(s.repo)) {
    if (!s.cleaned) { s = { ...s, cleaned: true }; saveLane(dir, s); }
    return { s };
  }
  const done = s.snapshot || s.status === "complete" || s.status === "noop";
  let note: string | undefined;
  let kept: string | undefined;
  if (done) {
    const st = statusEntries(s.worktree);
    if (st === null) kept = "worktree status failed";
    else if (statusPaths(st).some((p) => !isHarnessOwned(p, s.declared ?? []))) kept = "dirty worktree";
  } else {
    const rescue = rescueWorktree(s.worktree, s.base, s.id, s.declared ?? [], why);
    if (!rescue.ok) kept = statusEntries(s.worktree) === null ? "worktree status failed" : "dirty worktree, rescue commit failed";
    else if (rescue.saved) {
      s = { ...s, changed: true };
      note = `saved ${rescue.saved} uncommitted file(s) of ${s.id} on ${s.branch}`;
    }
  }
  if (!kept && !cutWorktree(s, "any")) kept = "git worktree remove failed";
  // Settled: cut, or a finished lane's checkout kept on purpose (someone's
  // work). A failure (status, rescue, remove) stays pending for the next pass.
  s = { ...s, ...(!kept || kept === "dirty worktree" && done ? { cleaned: true } : {}) };
  saveLane(dir, s);
  return { s, note, kept };
}

// Removes a lane's recorded temp dir (its TMPDIR, src/harness/proc.ts) and
// clears the record. Only a dir named orch-lane-*: never anyone else's.
function dropTmpDir(dir: string, s: LaneState): LaneState {
  if (!s.tmpDir) return s;
  if (basename(s.tmpDir).startsWith("orch-lane-")) rmSync(s.tmpDir, { recursive: true, force: true });
  const { tmpDir: _gone, ...rest } = s;
  saveLane(dir, rest);
  return rest;
}

// Closes the Orca display of a finished lane from its record. Idempotent.
function retireDisplay(dir: string, s: LaneState): LaneState {
  if (!s.orca || s.orca.retired) return s;
  const kept = existsSync(s.worktree);
  const note = kept ? `${s.status}: worktree kept, lane gc --drop ${s.id}` : `${s.status}`;
  if (!orcaRetire(s.orca, `${s.to}: ${note}`, s.status === "complete" || s.status === "noop" ? "completed" : "in-review")) return s;
  const next = { ...s, orca: { ...s.orca, retired: true } };
  saveLane(dir, next);
  return next;
}

// The one writer for lanes whose process is gone without a finished cleanup
// (SIGKILL of the lane or of its finalizer): a worker group left behind is
// killed, a running record ends failed, leftovers go on the branch, the
// checkout is cut and the Orca display retired. A lane whose process still
// lives is its own finalizer's. Under the lane's owner lock (a follow holds
// it), re-read under it.
export function reapDeadLanes(root = stateDir(), only?: { intent?: string }): LaneState[] {
  const dir = join(root, "lanes");
  if (!existsSync(dir)) return [];
  const reaped: LaneState[] = [];
  for (const id of readdirSync(dir)) {
    const laneDir = join(dir, id);
    const first = readLane(laneDir);
    if (!first || (only?.intent && first.intent !== only.intent)) continue;
    if (first.pid && alive(first.pid)) continue;
    const pending = first.status === "running" || !first.cleaned || (first.orca && !first.orca.retired) || Boolean(first.tmpDir);
    if (!pending || (first.status === "running" && !first.pid)) continue;
    const release = lockLane(laneDir);
    if (!release) continue;
    try {
      let s = readLane(laneDir);
      if (!s || (s.pid && alive(s.pid))) continue;
      if (s.status === "running") {
        // The lane process is gone but its worker may not be: nobody would
        // ever read its result, and it would keep writing. Next pass finalizes.
        if (processGroupAlive(s.workerPgid)) {
          try { process.kill(-s.workerPgid!, "SIGKILL"); } catch {}
          continue;
        }
        s = { ...s, status: "failed", ended: new Date().toISOString(), reason: "lane process died" };
        saveLane(laneDir, s);
        reaped.push(s);
      }
      if (!s.cleaned) {
        const r = settleWorktree(laneDir, s, s.reason ?? "lane process died");
        s = r.s;
        const extra = [r.note, r.kept ? `worktree kept: ${r.kept}` : undefined].filter(Boolean).join("; ");
        if (extra && !(s.reason ?? "").includes(extra)) { s = { ...s, reason: `${s.reason ?? ""}; ${extra}`.replace(/^; /, "") }; saveLane(laneDir, s); }
        const i = reaped.findIndex((x) => x.id === s!.id);
        if (i >= 0) reaped[i] = s;
      }
      // A temp dir left by a dead lane or follow (its owner lock is free).
      s = dropTmpDir(laneDir, s);
      retireDisplay(laneDir, s);
    } catch { /* a reaper pass never fails its caller */ } finally {
      release();
    }
  }
  return reaped;
}

// A finished lane keeps only its branch: the result is committed there and
// INTEGRATE reads the branch, so the checkout goes now. With "harness", only
// harness and sandbox files (src/lanes/harness-files.ts) may be left; with
// "any", the result is already on the branch and what is left is VERIFY or
// tool output. A worktree git cannot read stays for gc. Never touch a
// worktree that is the repo itself. True once the checkout is gone.
function cutWorktree(state: LaneState, leftovers: "harness" | "any" = "harness"): boolean {
  if (resolvedPath(state.worktree) === resolvedPath(state.repo)) return false;
  if (!existsSync(state.worktree)) return true;
  const st = statusEntries(state.worktree);
  if (st === null) return false;
  if (leftovers === "harness" && statusPaths(st).some((p) => !isHarnessOwned(p, state.declared ?? []))) return false;
  return removeWorktree(state.repo, state.worktree);
}

// Orca first for a checkout in its workspace directory (it then forgets the
// card), git otherwise or when Orca refuses. Bounded: it also runs in a stop
// handler that must end.
function removeWorktree(repo: string, wt: string): boolean {
  if (orcaRemoveWorktree(repo, wt)) return true;
  return spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt],
    { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).status === 0;
}

export interface LaneState {
  id: string;
  to: Harness;
  repo: string;
  base: string;
  // The caller repo's branch when the lane started: a delivered lane's PR
  // targets it (laneIntegrate with deliver).
  baseBranch?: string;
  branch: string;
  worktree: string;
  status: Status | "running";
  changed: boolean;
  reason?: string;
  usage: Usage;
  model?: string;
  effort?: string;
  // The Kiba intent this lane runs for (ORCH_KIBA_INTENT), for the live views.
  intent?: string;
  peakRssMb?: { worker?: number; verify?: number };
  session?: string;
  started: string;
  ended: string;
  pid?: number;
  workerPgid?: number;
  // Read by the integration gate: VERIFY result, paths the spec declared,
  // risk it carries, files the change touched.
  verifyOk?: boolean | null;
  verifiedSha?: string;
  declared?: string[];
  risk?: Risk[];
  touched?: string[];
  objective?: string;
  verify?: string;
  // Argv of the SETUP this lane ran; the base-commit gate replays it.
  setupArgv?: string[];
  gate?: GateTiming;
  workerSession?: string;
  // Writes outside the worktree seen in the worker log (src/lanes/guard.ts).
  escapes?: { written: string[]; denied: string[] };
  // The Orca child and observer terminal of this lane (src/lanes/orca.ts);
  // retired once the terminal is closed, by the lane or else by the reaper.
  orca?: OrcaSaved & { retired?: boolean };
  // The worker's change is on the branch: what the worktree still holds is
  // VERIFY or tool output, never committed by a rescue.
  snapshot?: boolean;
  // The checkout's fate is settled (cut, or kept for a stated reason): no
  // reaper pass repeats it. Unset while a cleanup may be pending.
  cleaned?: boolean;
  // The worker's own temp dir (its TMPDIR, under the system temp dir: a short
  // path keeps Claude Code's sandbox sockets under the 107-byte limit).
  // Removed when the lane ends, else by the reaper or gc.
  tmpDir?: string;
}

function depthRefusal(label: "LANE REPORT" | "LANE REVIEW" | "LANE ASK" | "LANE CONTEST" | "LANE JUDGE", maxDepth: number): string | null {
  // Read-only advisor: a worker may call `lane ask`, and that consult must
  // not spawn further lanes (consult itself is already read-only).
  const depth = laneDepth();
  if (depth >= 1 && label === "LANE ASK") return null;
  if (depth < maxDepth) return null;
  const why = depth >= 1
    ? `max_depth ${maxDepth}: a lane worker cannot start a lane`
    : `max_depth ${maxDepth}: lanes are disabled`;
  return `${label}\nSTATUS: refused-by-lane\nREASON: ${why}\n`;
}

function controlRefusal(
  label: "LANE REPORT" | "LANE REVIEW" | "LANE ASK" | "LANE CONTEST" | "LANE JUDGE" | "LANE GC",
  maxDepth: number,
  spend?: { extraUsd?: number; watched?: boolean },
): string | null {
  if (label !== "LANE GC") {
    const depth = depthRefusal(label, maxDepth);
    if (depth) return depth;
  } else if (process.env.ORCH_LANE === "1") {
    return gcDepthRefusal(maxDepth);
  }
  const paused = pauseReason();
  if (paused) return `${label}\nSTATUS: paused\nREASON: ${paused}\n`;
  try { assertSpendAllowed({ label: label.toLowerCase(), extraUsd: spend?.extraUsd, watched: spend?.watched }); }
  catch (error) { return `${label}\nSTATUS: refused-by-lane\nREASON: ${(error as Error).message}\n`; }
  return null;
}

function gcDepthRefusal(maxDepth: number): string | null {
  return process.env.ORCH_LANE === "1"
    ? `LANE GC\nSTATUS: refused-by-lane\nREASON: max_depth ${maxDepth}: a lane worker cannot garbage collect lanes\n`
    : null;
}

function settleHold(holdId: string | undefined, entry: SpendEntry, state: string): void {
  if (holdId) recordAgainstHold(holdId, entry, state);
  else if (entry.usd > 0 || entry.tokens) recordSpend(entry, state);
}

function codexIsPaid(): boolean {
  return detectCodexAuthMode() === "api-key";
}

function estimatedUsdForHarness(harness: HarnessId, effort?: string): number {
  if (harness === "codex" && !codexIsPaid()) return 0;
  return estimateLaneUsd(effort);
}

function actualUsdForHarness(harness: HarnessId, usage: Usage, model?: string): number {
  if (harness === "codex" && !codexIsPaid()) return 0;
  return estimateUsageUsd({ ...usage, provider: harness, model: model ?? undefined });
}

function usageTokensOf(usage: Usage): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? usage.cached ?? 0,
    cacheWrite: usage.cacheCreation ?? 0,
  };
}

export function lanePrePush(opts: { repo: string; base?: string; verify?: string }): { report: string; ok: boolean } {
  const files = prePushFiles(opts.repo, opts.base ?? "HEAD");
  const verify = opts.verify ?? "bun test";
  const scoped = gateVerify(verify, files, { exists: (p) => existsSync(join(opts.repo, p)) });
  const t0 = performance.now();
  const run = spawnSync("sh", ["-c", scoped.command], { cwd: opts.repo, encoding: "utf8", timeout: 180_000 });
  const runMs = Math.round(performance.now() - t0);
  const ok = run.status === 0;
  const tailOut = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().slice(-800);
  return {
    ok,
    report: [
      "LANE PRE-PUSH",
      `FILES: ${files.join(", ") || "none"}`,
      `VERIFY: ${scoped.command}`,
      `SCOPE: ${scoped.full ? "full" : `affected ${scoped.affected.join(", ")}`}`,
      formatTiming({ waitMs: 0, setupMs: 0, runMs }),
      `STATUS: ${ok ? "ok" : `exit ${run.status}`}`,
      tailOut,
    ].filter(Boolean).join("\n") + "\n",
  };
}

export function leadHarness(h?: string, env: NodeJS.ProcessEnv = process.env): Harness {
  const valid = (value?: string): value is Harness => !!value && (HARNESSES as string[]).includes(value);
  if (env.ORCH_LEAD === "1" && valid(env.ORCH_HARNESS)) return env.ORCH_HARNESS;
  if (valid(h)) return h;
  return valid(env.ORCH_HARNESS) ? env.ORCH_HARNESS : "claude";
}

// A lane or consultation that finds the lane budget full waits for a slot
// (polled, the budget re-read each time since the machine load moves) for at
// most limits.slot_wait_seconds (default 600) instead of failing at once; a
// PAUSE ends the wait. Returns the slot, or null with the refusal reason.
export const SLOT_WAIT_DEFAULT_SECONDS = 600;
async function waitLaneSlot(state: string, limits: Profile["limits"], id: string, machine?: MachineFigures): Promise<{ slot: number } | { slot: null; reason: string }> {
  const waitMs = Math.max(0, limits.slot_wait_seconds ?? SLOT_WAIT_DEFAULT_SECONDS) * 1000;
  const start = Date.now();
  for (;;) {
    const budget = liveLaneBudget(limits, machine);
    const slot = reserveSlot(state, budget.budget, id);
    if (slot !== null) return { slot };
    const waited = Math.round((Date.now() - start) / 1000);
    const full = `lane budget ${budget.budget} (limited by ${budget.limitedBy}) already running${waited > 0 ? `, waited ${waited}s` : ""}`;
    const paused = pauseReason();
    if (paused) return { slot: null, reason: `${full}; ${paused}` };
    const remaining = start + waitMs - Date.now();
    if (remaining <= 0) return { slot: null, reason: full };
    await Bun.sleep(Math.min(1000, remaining));
  }
}

async function reserveVerifySlot(state: string, max: number, id: string, timeoutMs: number): Promise<{ slot: number; timeoutMs: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slot = reserveSlot(state, max, id, "verify-slots");
    if (slot !== null) {
      const remaining = deadline - Date.now();
      if (remaining > 0) return { slot, timeoutMs: remaining };
      releaseSlot(state, slot, "verify-slots");
      return null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await Bun.sleep(Math.min(2000, remaining));
  }
  return null;
}

// Files the lane commit touched, with line counts; binary files count 0.
export function numstat(wt: string, base: string): { files: string[]; insertions: number; deletions: number } {
  const r = git(wt, "diff", "--numstat", "--no-renames", base, "HEAD");
  const out = { files: [] as string[], insertions: 0, deletions: 0 };
  if (!r.ok) return out;
  for (const line of r.out.split("\n")) {
    const [add, del, ...path] = line.split("\t");
    if (!path.length) continue;
    out.files.push(path.join("\t"));
    out.insertions += Number(add) || 0;
    out.deletions += Number(del) || 0;
  }
  return out;
}

// Resumes of a Claude run that ended without a LANE line, inside its timeout.
const MAX_CONTINUATIONS = 2;

export async function laneRun(opts: {
  to: HarnessId;
  specPath: string;
  repo: string;
  profile: Profile;
  effort?: string;
  model?: string;
  machine?: MachineFigures;
  skipReserve?: boolean;
  spendHold?: string;
  watched?: boolean;
}): Promise<{ report: string; state?: LaneState }> {
  const p = opts.profile;
  const estimate = estimatedUsdForHarness(opts.to, opts.effort);
  const depth = controlRefusal("LANE REPORT", p.limits.max_depth, {
    extraUsd: opts.skipReserve ? 0 : estimate,
    watched: opts.watched,
  });
  if (depth) return { report: depth };
  if (!installed(opts.to)) {
    const present = HARNESS_IDS.filter((h) => installed(h));
    return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${opts.to} is not installed (installed: ${present.join(", ") || "none"})\n` };
  }
  const spec = parseSpec(readFileSync(opts.specPath, "utf8"));
  if (opts.to === "grok" && !grokProfileInstalled()) {
    return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: Grok profiles orch-lane/orch-review missing or modified in ~/.grok/sandbox.toml: run orch install\n" };
  }
  const grokBin = opts.to === "grok" ? pinnedGrok() : undefined;
  if (grokBin === null) return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: grok not found on PATH\n" };
  const missing = missingFields(spec);
  if (missing.length) return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: spec missing ${missing.join(", ")}\n` };
  const banned = protectedTouched(declaredFiles(spec.fields.FILES));
  if (banned.length) {
    return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: protected path: ${banned.join(", ")}\n` };
  }

  const top = git(opts.repo, "rev-parse", "--show-toplevel");
  if (!top.ok) return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: not a git repository\n" };
  const repo = top.out;
  const guard = testRepoRefusal(repo);
  if (guard) return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: ${guard}\n` };

  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${opts.to}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const sd = stateDir();
  let hold: SpendHold | undefined;
  if (!opts.skipReserve) {
    try {
      hold = reserveSpend({ usd: estimate, source: `lane:${id}`, label: "lane report", watched: opts.watched, state: sd });
    } catch (error) {
      return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: ${(error as Error).message}\n` };
    }
  }
  const waited = await waitLaneSlot(sd, p.limits, id, opts.machine);
  if (waited.slot === null) {
    if (hold) releaseSpend(hold.id, sd);
    return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${waited.reason}\n` };
  }
  const slot = waited.slot;

  const dir = join(sd, "lanes", id);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  // Under Orca the checkout lives where Orca can remove it (lanes/orca.ts).
  const wt = orcaLaneWorktree(repo, id) ?? join(dir, "wt");
  const branch = `lane/${id}`;
  const started = new Date().toISOString();
  let live: LaneState | undefined;
  // The terminal record once saved: a stop signal never overwrites it.
  let final: LaneState | undefined;
  let orcaView: OrcaView | null = null;
  let progress: ProgressWatch | undefined;
  let verifySlot: number | undefined;
  let laneTmp: string | undefined;
  // setup: nothing of the worker yet; worker: its change may be uncommitted;
  // snapshotted: its change is on the branch (or there was none), and what
  // the worktree still holds is VERIFY or tool output.
  let phase: "setup" | "worker" | "snapshotted" = "setup";
  const logPath = join(dir, "worker.log");
  const record = (): LaneState | undefined => final ?? live;
  const saveFinal = (s: LaneState): void => {
    final = { ...s, ...(record()?.orca ? { orca: record()!.orca } : {}), ...(phase === "snapshotted" ? { snapshot: true } : {}), ...(laneTmp ? { tmpDir: laneTmp } : {}) };
    saveLane(dir, final);
  };
  // Display fields only, written onto the record on disk: once the lane has
  // a terminal record, a follow may have rewritten it meanwhile, and this
  // process's copy must never overwrite that.
  const patchOrca = (orca: NonNullable<LaneState["orca"]>): void => {
    const r = record();
    if (r) r.orca = orca;
    const disk = final ? readLane(dir) : r;
    if (disk) saveLane(dir, { ...disk, orca });
  };
  // Closes the Orca observer and records it, so the reaper does not retry it.
  const detachDisplay = async (): Promise<void> => {
    if (!orcaView) return;
    const closed = await orcaDetach(orcaView);
    const r = record();
    if (closed && r?.orca && !r.orca.retired) patchOrca({ ...r.orca, retired: true });
  };
  // Every way out of a started lane ends here (normal end, error, stop
  // signal): display closed, worktree cut when nothing would be lost, slots
  // and spend released. Idempotent; the stop path awaits it before exiting.
  let finishing: Promise<void> | undefined;
  const finishLane = (leftovers: "harness" | "any"): Promise<void> => finishing ??= (async () => {
    progress?.stop();
    const r = final;
    if (r) orcaStatus(orcaView, `${opts.to}: ${r.status}`, r.status === "complete" || r.status === "noop" ? "completed" : "in-review");
    await detachDisplay();
    // A follow may already own the checkout: then the reaper settles it later.
    const release = r && r.status !== "running" ? lockLane(dir, 10_000) : null;
    if (release) {
      try {
        // A follow that ran while we waited may have left its own work: then
        // the reaper settles the checkout (rescue first), never this cut.
        const followed = readdirSync(dir).some((f) => /^follow-\d+\.txt$/.test(f));
        const disk = readLane(dir);
        if (!followed && disk && cutWorktree(disk, leftovers)) {
          saveLane(dir, { ...disk, cleaned: true });
          if (final) final.cleaned = true;
        }
      } finally { release(); }
    }
    if (laneTmp) rmSync(laneTmp, { recursive: true, force: true });
    if (verifySlot !== undefined) releaseSlot(sd, verifySlot, "verify-slots");
    if (hold) releaseSpend(hold.id, sd);
    hold = undefined;
    releaseSlot(sd, slot);
  })();
  try {
    const b = workerBase(repo, dir);
    if (!b.ok) return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${b.reason}\n` };
    const base = b.sha;
    const baseBranch = git(repo, "branch", "--show-current").out || undefined;
    laneTmp = mkdtempSync(join(tmpdir(), "orch-lane-"));
    // declared from the start: Kiba's watchdog checks drift while the lane runs.
    live = { id, to: opts.to, repo, base, ...(baseBranch ? { baseBranch } : {}), branch, worktree: wt, status: "running", changed: true, tmpDir: laneTmp,
      usage: {}, started, ended: "", session: process.env.ORCH_SESSION, pid: process.pid, declared: declaredFiles(spec.fields.FILES),
      ...(process.env.ORCH_KIBA_INTENT ? { intent: process.env.ORCH_KIBA_INTENT } : {}) };
    mkdirSync(dirname(wt), { recursive: true });
    if (!git(repo, "worktree", "add", "-q", "-b", branch, wt, base).ok) {
      return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: git worktree add failed\n` };
    }
    neutralizeWorktreeHooks(wt, join(dir, "no-hooks"));
    saveLane(dir, live);
    // Ends a lane cut short (stop signal, PAUSE): the worker's processes are
    // already stopped, so what it left is committed on the branch and the
    // checkout can go without losing anything. Returns the cut rule.
    const interrupt = (status: "failed" | "unavailable", why: string): "harness" | "any" => {
      if (final || !live) return phase === "worker" ? "harness" : "any";
      const rescue = phase === "worker"
        ? rescueWorktree(wt, base, id, live.declared ?? [], why)
        : { ok: true, changed: phase === "setup" ? false : live.changed, saved: 0 };
      saveFinal({
        ...live, status, changed: rescue.changed ?? live.changed, ended: new Date().toISOString(),
        reason: `${why}${rescue.saved ? `; ${rescue.saved} uncommitted file(s) saved on ${branch}` : ""}${rescue.ok ? "" : "; worktree kept, its work is not committed"}`,
      });
      return rescue.ok ? "any" : "harness";
    };
    onLaneStop(async (signal) => { await finishLane(interrupt("failed", `lane stopped by ${signal}`)); });
    // Claude and Codex stream events for progress.json.
    const choice = withExplicit(p.lanes[opts.to], roleChoice("edit", opts.to, p, repo), { model: opts.model });
    progress = watchProgress({
      dir,
      logPath: opts.to === "grok" ? undefined : logPath,
      tracker: new ProgressTracker({ harness: opts.to, model: choice.model ?? null, effort: opts.effort ?? spec.reasoning ?? choice.effort ?? null, started, cwd: wt, verify: spec.fields.VERIFY }),
    });
    const onSpawn = (pgid: number) => {
      live!.workerPgid = pgid;
      saveLane(dir, live!);
      recordSlotGroup(sd, slot, pgid);
    };
    orcaView = orcaAttach({
      repo, worktree: wt, id, to: opts.to, logPath,
      onShown: (saved) => patchOrca(saved),
    });
    let setupLine = "SETUP: none";
    const timing = emptyTiming();
    const setup = setupCommand(spec, repo);
    if (setup) {
      orcaStatus(orcaView, `${opts.to}: setup`, "in-progress");
      const t0 = performance.now();
      const setupLog = join(dir, "setup.log");
      let why: string | null = null;
      try {
        const s = await runLogged(setup.argv, {
          cwd: wt, logPath: setupLog, timeoutMs: 900_000, env: workerEnv({ LANE_REPO: repo, LANE_WORKTREE: wt }),
          onSpawn,
        });
        if (s.code !== 0 || s.timedOut) {
          why = `setup failed, exit ${s.code}${s.timedOut ? " (timeout)" : ""}\n${tail(existsSync(setupLog) ? readFileSync(setupLog, "utf8") : "", 12)}`;
        } else {
          // Setup output must stay out of the result: a file git sees or a
          // commit it made would be reported as the worker's change.
          const left = statusEntries(wt);
          const moved = git(wt, "rev-parse", "HEAD").out !== base;
          if (left === null) why = "git status failed in the worktree after setup";
          else if (left.length) why = `setup left files git tracks (gitignore them or drop them):\n${tail(left.join("\n"), 8)}`;
          else if (moved) why = "setup made a commit in the worktree";
        }
      } catch (e) {
        why = `setup could not run: ${(e as Error).message}`;
      }
      if (why) {
        await detachDisplay();
        removeWorktree(repo, wt);
        git(repo, "branch", "-D", branch);
        // A state record keeps the diagnostics discoverable, and lane gc removes them.
        const failed: LaneState = {
          id, to: opts.to, repo, base, branch, worktree: wt, status: "unavailable", changed: false, usage: {}, started, ended: new Date().toISOString(),
          session: process.env.ORCH_SESSION,
        };
        saveFinal(failed);
        return { report: bound(`LANE REPORT\nSTATUS: unavailable\nREASON: ${why}\nSETUP: ${setup.display} (${setup.source})\nLOG: ${setupLog}\n`, p.limits.report_max_bytes) };
      }
      timing.setupMs = Math.round(performance.now() - t0);
      setupLine = `SETUP: ${setup.display} (${setup.source}, ok in ${Math.round(timing.setupMs / 1000)}s)`;
    }
    const abortIfPaused = async (phase: string) => {
      const paused = pauseReason();
      if (!paused) return null;
      await finishLane(interrupt("unavailable", `paused: ${paused} (${phase})`));
      const next = final;
      return { report: bound(`LANE REPORT\nSTATUS: paused\nREASON: ${paused}\nID: ${id}\nPHASE: ${phase}\n`, p.limits.report_max_bytes), state: next };
    };
    const pausedAfterSetup = await abortIfPaused("setup");
    if (pausedAfterSetup) return pausedAfterSetup;
    const promptPath = join(dir, "prompt.txt");
    writeFileSync(promptPath, formatBrief({ spec, cwd: wt }) + "\n" + spec.raw);
    const lastPath = join(dir, "last.txt");
    progress.phase("worker");
    phase = "worker";
    const call = workerArgv(opts.to, choice, {
      cwd: wt, promptPath, effort: opts.effort ?? spec.reasoning, readOnly: false, lastMessagePath: lastPath, bin: grokBin, tmpDir: laneTmp,
    });
    orcaStatus(orcaView, `${opts.to}: working`, "in-progress");
    const deadline = Date.now() + p.limits.timeout_seconds * 1000;
    const workerStart = Date.now();
    let run = await runLogged(call.argv, {
      cwd: wt, logPath, stdinPath: call.stdin ? promptPath : undefined,
      timeoutMs: p.limits.timeout_seconds * 1000, env: workerEnv({}, { tmpDir: laneTmp }),
      onSpawn,
    });
    // A headless Claude run can end on a progress note with work still owed:
    // resume its session with the open items, never past the lane's timeout.
    let continued = 0;
    let finish: string | null = null;
    let offset = 0;
    let earlier: Usage = {};
    if (opts.to === "claude") {
      const continuePath = join(dir, "continue.txt");
      writeFileSync(continuePath, CLAUDE_CONTINUE);
      for (;;) {
        const sofar = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
        const segment = parseWorkerOutput("claude", sofar.slice(offset), "");
        finish = finishLine(segment.message);
        const sid = sessionId(sofar.slice(offset));
        const left = deadline - Date.now();
        if (engineUnavailable(classifyLog(opts.to, sofar.slice(offset))) || finish || !sid || run.code !== 0 || run.timedOut || continued >= MAX_CONTINUATIONS || left < 60_000) break;
        const pausedContinue = await abortIfPaused("continue");
        if (pausedContinue) return pausedContinue;
        earlier = addUsage(earlier, segment.usage);
        offset = sofar.length;
        continued++;
        orcaStatus(orcaView, `${opts.to}: continue ${continued}`, "in-progress");
        run = await runLogged([...call.argv, "--resume", sid], {
          cwd: wt, logPath, stdinPath: continuePath, timeoutMs: left, env: workerEnv({}, { tmpDir: laneTmp }),
          onSpawn,
        });
      }
    }
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const last = existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "";
    // A sandboxed command killed mid-run leaves its .git/config placeholder in the operator's repository.
    clearSandboxPlaceholders(wt, workerStart);

    // Same forced view as the snapshot: the repo's status config is shared by
    // the worktree and must not hide what the worker created.
    const after = statusEntries(wt);
    // Harness and sandbox files (src/lanes/harness-files.ts) are not a change.
    const declaredPaths = specFeatures(spec).files;
    const own = (after ?? []).filter((e, i, all) => !(i > 0 && /^[RC]/.test(all[i - 1])) && !isHarnessOwned(e.slice(3), declaredPaths));
    const dirty = own.join("\n");
    const commits = git(wt, "rev-list", `${base}..HEAD`).out;
    const changed = Boolean(dirty || commits);

    // Commit before VERIFY so its evidence names the commit that was tested.
    let snapshotError: string | undefined;
    if (changed && dirty) {
      const added = git(wt, "add", "-A", ...addPathspec(declaredPaths, wt));
      if (!added.ok) {
        snapshotError = `git add failed:\n${tail(added.err || added.out, 12) || "no error output"}`;
      } else {
        const committed = git(wt, "-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit", "-q", "-m",
          `lane ${id}: ${(spec.fields.OBJECTIVE ?? "").split("\n")[0].slice(0, 60)}`);
        if (!committed.ok) {
          snapshotError = `git commit failed:\n${tail(committed.err || committed.out, 12) || "no error output"}`;
        }
      }
    }
    const verifyTip = git(wt, "rev-parse", "HEAD");
    let verifyOk: boolean | null = null;
    let verifiedSha: string | undefined;
    let verifyOut = "not run";
    let verifyPeakRssMb: number | undefined;
    let verifyScope: string | undefined;
    if (!snapshotError && after !== null) {
      phase = "snapshotted";
      // The reaper reads it if this process dies during VERIFY.
      live.snapshot = true;
      saveLane(dir, live);
    }
    const pausedBeforeVerify = await abortIfPaused("verify");
    if (pausedBeforeVerify) return pausedBeforeVerify;
    const outage = engineUnavailable(classifyLog(opts.to, log));
    if (outage) await markEngineUnavailable(opts.to, outage, sd);
    if (spec.verify && !run.timedOut && !outage) {
      progress.phase("verify");
      orcaStatus(orcaView, `${opts.to}: verify`, "in-progress");
      const verifyLog = join(dir, "verify.log");
      const names = git(wt, "diff", "--name-only", "--no-renames", base, "HEAD");
      const files = names.ok ? names.out.split("\n").filter(Boolean) : [];
      const scoped = gateVerify(spec.verify, files, { exists: (p) => existsSync(join(wt, p)) });
      verifyScope = scoped.full ? "full" : `affected ${scoped.affected.join(", ")}`;
      // A VERIFY that tests another checkout proves nothing: not run, failed.
      const escape = verifyReach(scoped.command, wt, workerEnv({ LANE_REPO: repo, LANE_WORKTREE: wt }));
      const waitStart = performance.now();
      const verify = escape ? null : await reserveVerifySlot(sd, p.limits.verify_concurrent, id, VERIFY_TIMEOUT_MS);
      timing.waitMs = Math.round(performance.now() - waitStart);
      if (escape) {
        verifyOk = false;
        verifyOut = escape;
      } else if (verify === null) {
        verifyOk = false;
        verifyOut = "timeout waiting for verify slot";
      } else {
        verifySlot = verify.slot;
        try {
          const runStart = performance.now();
          const v = await runLogged(["sh", "-c", scoped.command], {
            cwd: wt, logPath: verifyLog, timeoutMs: verify.timeoutMs, env: workerEnv({ LANE_REPO: repo, LANE_WORKTREE: wt }),
            onSpawn: (pgid) => {
              onSpawn(pgid);
              recordSlotGroup(sd, verify.slot, pgid, "verify-slots");
            },
          });
          timing.runMs = Math.round(performance.now() - runStart);
          verifyPeakRssMb = v.peakRssMb;
          verifyOk = v.code === 0 && !v.timedOut;
          if (verifyOk && verifyTip.ok && !snapshotError) {
            // Untracked leftovers (caches, build output) are not in the
            // commit; a tracked file VERIFY rewrote means it tested other content.
            verifiedSha = verifiedCommit(wt, verifyTip.out);
          }
          verifyOut = `exit ${v.code}${v.timedOut ? " (timeout)" : ""}\n${tail(readFileSync(verifyLog, "utf8"), 12)}`;
        } finally {
          releaseSlot(sd, verify.slot, "verify-slots");
          verifySlot = undefined;
        }
      }
    }

    // Without a reliable status the change cannot be measured: never report it as noop.
    let status: Status = after === null ? "failed" : classify({ ...run, changed, verifyOk, log: classifyLog(opts.to, log) });
    let reason = after === null ? "git status failed in the worktree after the worker" : snapshotError;
    if (snapshotError) status = "failed";
    // Write guard, detection side (src/lanes/guard.ts): a write that landed
    // outside the worktree fails the lane, whatever VERIFY said.
    const escapes = outsideWrites(opts.to, log, wt);
    if (escapes.written.length) {
      status = "failed";
      const why = `wrote outside its worktree: ${escapes.written.slice(0, 8).join(", ")}`;
      reason = reason ? `${reason}; ${why}` : why;
    }
    if (outage) { status = "unavailable"; reason = `${opts.to}: ${outage.reason}`; }
    const resolved = resolveLaneStatus({
      status, verifyOk, changed,
      finish: opts.to === "claude" ? finish : undefined,
      continued,
    });
    status = resolved.status;
    if (resolved.reason) reason = reason ? `${reason}; ${resolved.reason}` : resolved.reason;
    const stat = changed ? tail(git(wt, "diff", "--stat", base, "HEAD").out, 12) : "none";
    const parsed = parseWorkerOutput(opts.to, log.slice(offset), last);
    const message = parsed.message;
    const usage = continued ? addUsage(earlier, parsed.usage) : parsed.usage;
    const model = parsed.model ?? choice.model ?? "inherited";
    const effort = opts.effort ?? spec.reasoning ?? choice.effort ?? "default";
    const peakRssMb = {
      ...(run.peakRssMb === undefined ? {} : { worker: run.peakRssMb }),
      ...(verifyPeakRssMb === undefined ? {} : { verify: verifyPeakRssMb }),
    };

    const features = specFeatures(spec);
    const diff = numstat(wt, base);
    const outOfScope = diff.files.filter((f) => !inScope(f, features.files));
    const workerSession = sessionId(log);
    const state: LaneState = {
      id, to: opts.to, repo, base, ...(baseBranch ? { baseBranch } : {}), branch, worktree: wt, status, changed, usage, started, ended: new Date().toISOString(),
      reason, session: process.env.ORCH_SESSION, workerSession,
      ...(process.env.ORCH_KIBA_INTENT ? { intent: process.env.ORCH_KIBA_INTENT } : {}),
      ...(choice.model ? { model: choice.model } : {}),
      ...(effort !== "default" ? { effort } : {}),
      ...(Object.keys(peakRssMb).length ? { peakRssMb } : {}),
      verifyOk, verifiedSha, declared: features.files, risk: features.risk, touched: diff.files,
      ...(escapes.written.length || escapes.denied.length ? { escapes } : {}),
      objective: (spec.fields.OBJECTIVE ?? "").trim().slice(0, 2000), verify: spec.verify, gate: timing,
      // [] when no setup ran (SETUP: none, or nothing to install): a later
      // fresh checkout (lane check, base-commit verify) runs none either.
      setupArgv: setup?.argv ?? [],
    };
    appendLedger({
      kind: "run", id, at: state.ended, repo: projectKey(repo), to: opts.to, model, effort, channel: "headless", status, changed, verifyOk, verifiedSha,
      features, diff, outOfScope, durationS: Math.round((Date.parse(state.ended) - Date.parse(started)) / 1000), usage,
      gate: timing, ...(continued ? { continued } : {}),
    }, sd);
    const provider = opts.to;
    const usd = actualUsdForHarness(provider, usage, model);
    settleHold(opts.spendHold ?? hold?.id, {
      at: state.ended,
      usd,
      source: `lane:${id}`,
      provider,
      model,
      session: workerSession,
      project: projectKey(repo),
      tokens: usageTokensOf(usage),
    }, sd);
    if (hold && hold.id !== opts.spendHold) releaseSpend(hold.id, sd);
    hold = undefined;

    const report = laneReport({
      to: opts.to, model, effort, status, reason, id, base, snapshotOf: b.snapshotOf,
      branch, setupLine, stat, verifyOut, message, usage, changed, logPath, peakRssMb, outOfScope,
      gate: timing, verifyScope, ...(orcaView ? { orca: orcaLine(orcaView) } : {}),
    });
    const bounded = bound(report, p.limits.report_max_bytes);
    writeFileSync(join(dir, "report.txt"), bounded);
    saveFinal(state);
    await finishLane(phase === "snapshotted" ? "any" : "harness");
    return { report: bounded, state: final ?? state };
  } catch (e) {
    const reason = (e as Error).message;
    if (live && !final) saveFinal({ ...live, status: "unavailable", reason, ended: new Date().toISOString() });
    return { report: bound(`LANE REPORT\nSTATUS: unavailable\nREASON: ${reason}\nID: ${id}\nLOG: ${dir}\n`, p.limits.report_max_bytes) };
  } finally {
    // An error or an early return keeps a dirty worktree (nothing was
    // committed for it); the stop handler stays until cleanup is done.
    await finishLane(phase === "snapshotted" ? "any" : "harness");
    onLaneStop(null);
  }
}

type ConsultOpts = {
  from: Harness; to?: HarnessId; repo: string; profile: Profile; risk?: "normal" | "high";
  base?: string; model?: string; effort?: string; search?: boolean;
  skipReserve?: boolean; spendHold?: string; watched?: boolean;
};

function installedReviewers(which?: Which): HarnessId[] {
  return HARNESS_IDS.filter((h) => installed(h, which));
}

function reviewChoiceFor(to: HarnessId, from: Harness, profile: Profile): ReviewChoice {
  const fromChoice = profile.review[from];
  if (fromChoice.to === to) return fromChoice;
  // No review entry aims at this harness: Claude reviews on the lead's model
  // and effort, the others on their lane model with the review role on top
  // (workers default to medium, a reviewer keeps its own). Never the lead's
  // permission mode.
  const { model, effort } = to === "claude" ? profile.lead.claude : applyRole(profile.lanes[to], roleChoice("review", to, profile));
  return { to, model, effort };
}

export function resolveReviewer(
  from: Harness,
  profile: Profile,
  opts: { to?: HarnessId; risk: "normal" | "high" },
  which?: Which,
): { to: HarnessId; choice: ModelChoice; note?: string } | { unavailable: string } {
  const fromChoice = profile.review[from];
  const present = installedReviewers(which);
  const installedNote = present.join(", ") || "none";
  const choose = (to: HarnessId, note?: string) => {
    const entry = reviewChoiceFor(to, from, profile);
    const { high, to: _target, ...normal } = entry;
    const choice = opts.risk === "high" && high ? { ...normal, ...high } : normal;
    return { to, choice, ...(note ? { note } : {}) };
  };

  if (opts.to) {
    if (!installed(opts.to, which)) return { unavailable: `${opts.to} is not installed (installed: ${installedNote})` };
    const sameFamilyOnly = opts.to === from && present.length === 1 && present[0] === from;
    const note = opts.to === from
      ? sameFamilyOnly ? "same family: no other harness installed" : "same family: explicit --to"
      : undefined;
    return choose(opts.to, note);
  }

  const ordered = [...new Set([fromChoice.to, ...(fromChoice.fallback ?? [])])];
  const alternatives = [
    ...ordered.filter((h) => h !== from),
    ...HARNESS_IDS.filter((h) => h !== from && !ordered.includes(h)),
  ];
  const selected = alternatives.find((h) => installed(h, which));
  if (selected) {
    const index = alternatives.indexOf(selected);
    const missing = alternatives.slice(0, index).filter((h) => !installed(h, which));
    const note = missing.length ? `fallback: ${missing.join(", ")} not installed` : undefined;
    return choose(selected, note);
  }

  if (present.length === 1 && present[0] === from) {
    return choose(from, "same family: no other harness installed");
  }
  return { unavailable: `no reviewer harness is installed (installed: ${installedNote})` };
}

export async function laneReview(opts: ConsultOpts & { base: string; goal: string }) {
  return (await laneReviewDetailed(opts)).report;
}

function laneReviewDetailed(opts: ConsultOpts & { base: string; goal: string }) {
  return consultDetailed("REVIEW", opts, `${REVIEW_PREAMBLE}Review the changes from ${opts.base} to the working tree of this repository (git diff ${opts.base}) against this goal:
${opts.goal}

Check that the change does what was asked, nothing missing, nothing unasked smuggled in, and name any risk.
Answer under 300 words: first line "VERDICT: ship | fix-first | rethink", then numbered findings with file and fix.
Score each finding as \`FINDING: <text> | FREQ: n | SEV: n\` (frequency 1-10, severity 1-10). Product >= 5 must be fixed; below 5 is backlog only.
`);
}

// A second opinion from another model on a question (no diff), through the same
// read-only reviewer choice, slot, timeout and closed stdin as a review: the lead
// never calls a harness binary by hand (a backgrounded `codex exec` blocks on stdin).
export function laneAsk(opts: ConsultOpts & { question: string }) {
  return consult("ASK", opts, `${REVIEW_PREAMBLE}Answer this question from the orchestrating session. Read the repository if it helps.

${opts.question.trim()}
`);
}

type ConsultKind = "REVIEW" | "ASK" | "CONTEST" | "JUDGE";

// One read-only consultation, with what a contest needs beyond the report:
// whether an answer came back, who gave it, and the answer itself.
interface Consulted { usage?: Usage; report: string; ok: boolean; status: string; message: string; to?: HarnessId; model?: string | null; effort?: string }

const CONTEST_PROMPT = (question: string) => `${REVIEW_PREAMBLE}Several models answer this question independently; another model then compares the
answers and looks for contradictions. Answer on your own. Read the repository if the question is about it,
and say what you checked. Under 400 words: first line "ANSWER: <one sentence>", then your reasoning, then
"ASSUMPTIONS:" with what your answer depends on.

${question.trim()}
`;

const JUDGE_PROMPT = (question: string, answers: { label: string; message: string }[], verdict = false) => `${REVIEW_PREAMBLE}You arbitrate between ${answers.length} independent answers to the question below, written by different
models. You do not know which model wrote which; do not guess. Judge on evidence, not on confidence or
length: when a claim is about this repository, check it. Under 400 words, in this format:
CONSENSUS: what every answer agrees on, or "none".
CONTRADICTIONS: numbered; for each, what each answer says, then "-> <letter> is right: <evidence>" or
"-> UNRESOLVED: <the trade-off the operator must decide>". Write "none" if there is none.
DECISION: ${verdict ? '"GO" (implement the spec as written) or "CHANGE: <the edits the spec needs>", then why, in two sentences.' : "the answer you would act on, in two sentences."}
FOR THE OPERATOR: decisions only a human can take, or "none".

QUESTION:
${question.trim()}

${answers.map((a) => `ANSWER ${a.label}:\n${a.message.trim()}`).join("\n\n")}
`;

// Fisher-Yates on a copy: the judge must not learn who answered from the order.
function shuffled<T>(items: T[], random = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface ContestOpts {
  repo: string; profile: Profile; question: string; to?: HarnessId[]; risk?: "normal" | "high";
  judge?: { model?: string; effort?: string }; random?: () => number; verdict?: boolean;
  skipReserve?: boolean; spendHold?: string; watched?: boolean;
}

export interface ContestResult { report: string; decided: boolean; verdict?: "GO" | "CHANGE"; operator: string[] }

// What the judge leaves to a human: every UNRESOLVED contradiction and every
// FOR THE OPERATOR line that is not "none".
export function operatorPoints(judge: string): string[] {
  const unresolved = [...judge.matchAll(/->\s*UNRESOLVED:\s*(.+)/g)].map((m) => `unresolved: ${m[1].trim()}`);
  const section = /^\**FOR THE OPERATOR:?\**:?\s*([\s\S]*)$/m.exec(judge)?.[1] ?? "";
  const lines = section.split("\n").map((l) => l.replace(/^[\s*-]+/, "").trim()).filter(Boolean);
  const own = lines.length === 1 && /^none\b\.?$/i.test(lines[0]) ? [] : lines.filter((l) => !/^none\b/i.test(l));
  return [...unresolved, ...own];
}

// The same question to several harnesses at once (read-only, none sees the
// others), then a judge on another model compares the anonymized answers and
// names each contradiction: who is right and why, or what the operator must
// decide. At least two answers are needed; without them no judge is called.
export async function laneContest(opts: ContestOpts): Promise<ContestResult> {
  const label = "LANE CONTEST";
  const contestantHarnesses = opts.to ?? opts.profile.contest?.to ?? HARNESS_IDS;
  const estimate = contestantHarnesses.reduce((sum, harness) => {
    if (harness === "codex" && !codexIsPaid()) return sum;
    return sum + estimateConsultUsd(opts.risk ?? "normal");
  }, 0) + estimateConsultUsd("high");
  const depth = controlRefusal(label, opts.profile.limits.max_depth, {
    extraUsd: opts.skipReserve ? 0 : estimate,
    watched: opts.watched,
  });
  if (depth) return { report: depth, decided: false, operator: [] };
  const wanted = [...new Set(opts.to ?? opts.profile.contest?.to ?? HARNESS_IDS)];
  const present = wanted.filter((h) => installed(h));
  const missing = wanted.filter((h) => !present.includes(h));
  const absentNote = missing.length ? `NOT INSTALLED: ${missing.join(", ")}\n` : "";
  if (present.length < 2) return { report: `${label}\nSTATUS: unavailable\nREASON: a contest needs two installed harnesses (asked: ${wanted.join(", ")})\n${absentNote}`, decided: false, operator: [] };

  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(stateDir(), "contests", id);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "question.md"), opts.question);
  // at most the lane budget at once; a contestant waits for a slot (waitLaneSlot), then is reported
  const contestBudget = liveLaneBudget(opts.profile.limits);
  if (contestBudget.budget < 1) {
    return { report: `${label}\nSTATUS: unavailable\nREASON: lane budget 0 (limited by ${contestBudget.limitedBy})\n${absentNote}`, decided: false, operator: [] };
  }
  const width = Math.max(1, Math.min(present.length, contestBudget.budget));
  const results: Consulted[] = new Array(present.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < present.length) {
      const i = next++;
      results[i] = await consultDetailed("CONTEST", {
        from: "claude", to: present[i], repo: opts.repo, profile: opts.profile, risk: opts.risk,
        skipReserve: opts.skipReserve, spendHold: opts.spendHold, watched: opts.watched,
      }, CONTEST_PROMPT(opts.question));
    }
  }));

  const answered = shuffled(results.filter((r) => r.ok), opts.random).map((r, i) => ({ ...r, label: String.fromCharCode(65 + i) }));
  const who = (r: Consulted) => `${r.to} · ${r.model ?? "inherited"} · effort ${r.effort ?? "default"}`;
  for (const a of answered) writeFileSync(join(dir, `${a.label}.md`), `${who(a)}\n\n${a.message}`);
  writeFileSync(join(dir, "mapping.json"), JSON.stringify(Object.fromEntries(answered.map((a) => [a.label, who(a)])), null, 2) + "\n");
  const failed = results.flatMap((r, i) => {
    const reason = /^REASON: (.*)$/m.exec(r.report)?.[1];
    return r.ok ? [] : [`${present[i]} (${r.status}${reason ? `: ${reason}` : ""})`];
  });
  const contestants = [
    ...answered.map((a) => `${a.label} = ${who(a)}`),
    ...(failed.length ? [`no answer: ${failed.join(", ")}`] : []),
  ].join("\n");
  let usage = results.reduce<Usage>((sum, r) => addUsage(sum, r.usage ?? {}), {});
  const head = () => `CONTEST REPORT\nQUESTION: ${opts.question.trim().split("\n")[0].slice(0, 160)}\nCONTESTANTS:\n${contestants}\n${absentNote}USAGE: ${fmtUsage(usage)}\n`;
  if (answered.length < 2) {
    return { report: bound(`${head()}STATUS: unavailable\nREASON: ${answered.length} answer(s), a contest needs two: no judge called\nANSWERS: ${dir}\n`, opts.profile.limits.report_max_bytes), decided: false, operator: [] };
  }

  // an unset --model or --effort keeps the profile's judge
  const pinned = Object.fromEntries(Object.entries(opts.judge ?? {}).filter(([, v]) => v !== undefined));
  const judgeChoice = { ...opts.profile.contest?.judge, ...pinned };
  const judged = await consultDetailed("JUDGE", {
    from: "claude", to: "claude", repo: opts.repo, profile: opts.profile, model: judgeChoice.model ?? undefined, effort: judgeChoice.effort,
    skipReserve: opts.skipReserve, spendHold: opts.spendHold, watched: opts.watched,
  }, JUDGE_PROMPT(opts.question, answered, opts.verdict));
  usage = addUsage(usage, judged.usage ?? {});
  writeFileSync(join(dir, "judge.md"), judged.message);
  const judgeLine = `JUDGE: claude · ${judged.model ?? "inherited"} · effort ${judged.effort ?? "default"} (${judged.status})\n`;
  const tailLines = `ANSWERS: ${dir}\n`;
  if (!judged.ok) {
    return { report: bound(`${head()}${judgeLine}STATUS: judge-failed\n${judged.report.replace(/^USAGE:.*\n/gm, "")}${tailLines}`, opts.profile.limits.report_max_bytes), decided: false, operator: [] };
  }
  const verdict = /^\**DECISION:?\**:?\s*\**\s*(GO|CHANGE)\b/m.exec(judged.message)?.[1] as "GO" | "CHANGE" | undefined;
  return { report: bound(`${head()}${judgeLine}STATUS: judged\n${judged.message.trim()}\n${tailLines}`, opts.profile.limits.report_max_bytes), decided: true, verdict, operator: operatorPoints(judged.message) };
}

// A risky spec (RISK field or risky path) before any code: is it right as
// written? The judge answers GO or CHANGE. `go` only on GO with nothing left
// for the operator; anything else stops lane auto before the run.
export async function laneContestSpec(opts: {
  specPath: string; repo: string; profile: Profile; to?: HarnessId[];
  judge?: { model?: string; effort?: string }; random?: () => number;
  skipReserve?: boolean; spendHold?: string; watched?: boolean;
}):
  Promise<ContestResult & { go: boolean; why: string }> {
  const raw = readFileSync(opts.specPath, "utf8");
  const features = specFeatures(parseSpec(raw));
  const question = `Should this spec be implemented as written? A lead is about to hand it to a coding agent. It is risky (${features.risk.join(", ") || "none declared"}).
Read the files it names. Look for a wrong approach, a missing step (migration order, rollback, auth or permission check,
compatibility for existing callers), a FILES list that misses a file, a VERIFY that would not catch the risk.
Start your answer with "ANSWER: GO" or "ANSWER: CHANGE: <the edits>".

SPEC (${opts.specPath}):
${raw.trim()}
`;
  const c = await laneContest({
    repo: opts.repo, profile: opts.profile, question, to: opts.to, judge: opts.judge, random: opts.random, verdict: true,
    skipReserve: opts.skipReserve, spendHold: opts.spendHold, watched: opts.watched,
  });
  const why = !c.decided ? "no judged contest"
    : c.verdict !== "GO" ? `verdict ${c.verdict ?? "missing"}`
    : c.operator.length ? `${c.operator.length} point(s) for the operator`
    : "GO";
  return { ...c, go: why === "GO", why };
}

async function consult(kind: ConsultKind, opts: ConsultOpts, prompt: string): Promise<string> {
  return (await consultDetailed(kind, opts, prompt)).report;
}

async function consultDetailed(kind: ConsultKind, opts: ConsultOpts, prompt: string): Promise<Consulted> {
  const refuse = (report: string, status = "unavailable"): Consulted => ({ report, ok: false, status, message: "" });
  const label = `LANE ${kind}` as const;
  const estimate = opts.to === "codex" && !codexIsPaid() ? 0 : estimateConsultUsd(opts.risk ?? "normal");
  const depth = controlRefusal(label, opts.profile.limits.max_depth, {
    extraUsd: opts.skipReserve ? 0 : estimate,
    watched: opts.watched,
  });
  if (depth) return refuse(depth, depth.includes("STATUS: paused") ? "paused" : "refused-by-lane");
  const risk = opts.risk ?? "normal";
  const resolution = resolveReviewer(opts.from, opts.profile, { to: opts.to, risk });
  if ("unavailable" in resolution) return refuse(`${label}\nSTATUS: unavailable\nREASON: ${resolution.unavailable}\n`);
  // --model and --effort override the profile's reviewer choice for this call only.
  const { to, note } = resolution;
  // ASK is a read/explore consult: cheap model by default. An explicit
  // --model / --effort always wins over the role overlay.
  const rc = withExplicit(
    resolution.choice,
    kind === "ASK" ? roleChoice("explore", to, opts.profile, opts.repo) : {},
    { model: opts.model, effort: opts.effort },
  );
  if (to === "grok" && !grokProfileInstalled()) return refuse(`${label}\nSTATUS: unavailable\nREASON: Grok profiles orch-lane/orch-review missing or modified in ~/.grok/sandbox.toml: run orch install\n`);
  const grokBin = to === "grok" ? pinnedGrok() : undefined;
  if (grokBin === null) return refuse(`${label}\nSTATUS: unavailable\nREASON: grok not found on PATH\n`);
  const sd = stateDir();
  const id = `${Date.now()}-${to}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  let hold: SpendHold | undefined;
  if (!opts.skipReserve) {
    try {
      hold = reserveSpend({ usd: estimate, source: `consult:${kind}:${id}`, label: label.toLowerCase(), watched: opts.watched, state: sd });
    } catch (error) {
      return refuse(`${label}\nSTATUS: refused-by-lane\nREASON: ${(error as Error).message}\n`, "refused-by-lane");
    }
  }
  const waited = await waitLaneSlot(sd, opts.profile.limits, id);
  if (waited.slot === null) {
    if (hold) releaseSpend(hold.id, sd);
    return refuse(`${label}\nSTATUS: unavailable\nREASON: ${waited.reason}\n`);
  }
  const slot = waited.slot;
  try {
    const dir = join(sd, kind === "REVIEW" ? "reviews" : kind === "ASK" ? "asks" : "contests", id);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const promptPath = join(dir, "prompt.txt");
    writeFileSync(promptPath, prompt);
    const lastPath = join(dir, "last.txt");
    const logPath = join(dir, "worker.log");
    const call = workerArgv(to, rc, { cwd: opts.repo, promptPath, readOnly: true, lastMessagePath: lastPath, bin: grokBin, search: opts.search });
    const run = await runLogged(call.argv, {
      cwd: opts.repo, logPath, stdinPath: call.stdin ? promptPath : undefined,
      timeoutMs: opts.profile.limits.timeout_seconds * 1000,
      env: workerEnv(),
      onSpawn: (pgid) => recordSlotGroup(sd, slot, pgid),
    });
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const parsed = parseWorkerOutput(to, log, existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "");
    const { message, usage } = parsed;
    const model = parsed.model ?? rc.model ?? undefined;
    settleHold(opts.spendHold ?? hold?.id, {
      at: new Date().toISOString(),
      usd: actualUsdForHarness(to, usage, model ?? undefined),
      source: `consult:${kind}:${id}`,
      provider: to,
      model: model ?? "inherited",
      project: projectKey(opts.repo),
      tokens: usageTokensOf(usage),
    }, sd);
    if (hold && hold.id !== opts.spendHold) releaseSpend(hold.id, sd);
    hold = undefined;
    const outage = engineUnavailable(classifyLog(to, log));
    if (outage) {
      await markEngineUnavailable(to, outage, sd);
      return { ...refuse(`${label}\nSTATUS: unavailable\nREASON: ${to}: ${outage.reason}\nLOG: ${logPath}\n`), usage };
    }
    const report = bound(reviewReport({ kind, to, model, effort: rc.effort, risk, exitCode: run.code, timedOut: run.timedOut, usage, logPath, message, note }), opts.profile.limits.report_max_bytes);
    const status = run.timedOut ? "timeout"
      : run.code === 127 ? "exit 127: the harness or its interpreter (node for codex) is not on PATH"
      : run.code !== 0 ? `exit ${run.code}` : message.trim() ? "ok" : "empty answer";
    return { report, ok: status === "ok", status, message, to, model, effort: rc.effort, usage };
  } finally {
    if (hold) releaseSpend(hold.id, sd);
    releaseSlot(sd, slot);
  }
}

// `lane watch [--id <lane>] [--interval s] [--once]`: live table of running
// lanes from progress.json, with the Kiba intent each one serves.
export async function laneWatch(args: string[], root = stateDir(), write: (s: string) => void = (s) => { process.stdout.write(s); }): Promise<void> {
  const { values } = parseArgs({ args, options: { id: { type: "string" }, interval: { type: "string" }, once: { type: "boolean" } }, allowPositionals: false });
  const { watchTable } = await import("./kiba/live.ts");
  const every = Math.max(1, Number(values.interval ?? 2) || 2) * 1000;
  if (values.once) { write(`${watchTable(root, values.id)}\n`); return; }
  for (;;) {
    write(`\x1b[H\x1b[2J${new Date().toLocaleTimeString("fr-FR")}  lane watch (Ctrl-C to quit)\n\n${watchTable(root, values.id)}\n`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export function listLanes(root = stateDir()): LaneState[] {
  const dir = join(root, "lanes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => {
    const f = join(dir, id, "state.json");
    return existsSync(f) ? [JSON.parse(readFileSync(f, "utf8")) as LaneState] : [];
  });
}

export interface LaneOrphan { id: string; dir: string; worktree: boolean; repo?: string; dirty: number | null }

// Grace for a run between mkdir of its lane directory and its first record.
const ORPHAN_GRACE_MS = 5 * 60_000;

// A lane directory with no state.json: a run killed before it saved its
// record (versions before d37f519 saved it only at the end). listLanes cannot
// see it, so status and gc list it here. The id carries the creating pid: a
// recent directory whose creator is alive is a run still starting.
export function listOrphans(): LaneOrphan[] {
  const root = join(stateDir(), "lanes");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((id): LaneOrphan[] => {
    const dir = join(root, id);
    if (!statSync(dir).isDirectory() || existsSync(join(dir, "state.json"))) return [];
    if (alive(Number(id.split("-")[2]) || undefined) && Date.now() - statSync(dir).mtimeMs < ORPHAN_GRACE_MS) return [];
    const wt = join(dir, "wt");
    if (!existsSync(wt)) return [{ id, dir, worktree: false, dirty: 0 }];
    const common = git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const st = statusEntries(wt);
    return [{ id, dir, worktree: true, repo: common.ok ? dirname(common.out) : undefined, dirty: st === null ? null : st.length }];
  });
}

// An orphan without a worktree holds only logs and goes. One with a worktree
// may hold the only copy of a worker's result: it stays until --drop names it.
function gcOrphan(o: LaneOrphan, drop: string | undefined, out: string[]): void {
  if (o.worktree && o.id !== drop) {
    const dirty = o.dirty === null ? "status unknown" : `${o.dirty} uncommitted`;
    out.push(`kept orphan ${o.id} (no lane record, repo ${o.repo ?? "unknown"}, ${dirty}; lane gc --drop ${o.id} removes it)`);
    return;
  }
  if (o.worktree && o.repo) {
    const wt = join(o.dir, "wt");
    if (!git(o.repo, "worktree", "remove", "--force", wt).ok) {
      out.push(`kept orphan ${o.id} (git worktree remove failed)`);
      return;
    }
    const branch = `lane/${o.id}`;
    if (git(o.repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok && !git(o.repo, "branch", "-D", branch).ok) {
      out.push(`kept orphan ${o.id} (branch removal failed)`);
      return;
    }
  }
  rmSync(o.dir, { recursive: true, force: true });
  out.push(`removed orphan ${o.id}${o.worktree ? "" : " (logs only)"}`);
}

function forgetCallerRepoLane(s: LaneState, out: string[]): void {
  rmSync(join(stateDir(), "lanes", s.id), { recursive: true, force: true });
  out.push(`forgot ${s.id} (worktree is the caller repo: lane record removed, repo and branch untouched)`);
}

// One lane record: removed (and its outcome logged) only once nothing is lost.
function gcLane(s: LaneState, drop: string | undefined, out: string[], by: "gc" | "integrate" = "gc", superseded = false, delivered?: DeliveryOutcome): boolean {
  // A follow, the lane's finalizer or a reaper owns the checkout right now.
  const release = lockLane(join(stateDir(), "lanes", s.id));
  if (!release) {
    out.push(`kept ${s.id} (busy)`);
    return false;
  }
  try { return gcLaneOwned(s, drop, out, by, superseded, delivered); } finally { release(); }
}

// delivered: the branch a lane's change was committed to (laneIntegrate with
// deliver); its lane branch then goes like a dropped one, recorded integrated.
function gcLaneOwned(s: LaneState, drop: string | undefined, out: string[], by: "gc" | "integrate", superseded: boolean, delivered?: DeliveryOutcome): boolean {
  const recorded = readLedger().filter((r) => r.kind === "outcome" && r.id === s.id).at(-1);
  if (!delivered && recorded?.kind === "outcome" && recorded.outcome === "integrated" && recorded.branch && recorded.delivery) delivered = { branch: recorded.branch, ...recorded.delivery };
  if ((s.status === "running" && alive(s.pid)) || processGroupAlive(s.workerPgid)) {
    out.push(`kept ${s.id} (running)`);
    return false;
  }
  // A record whose worktree is the caller repo owns nothing removable: the
  // checkout and its branch belong to the operator.
  // Forget the record only, so it never needs a manual rm.
  if (resolvedPath(s.worktree) === resolvedPath(s.repo)) {
    forgetCallerRepoLane(s, out);
    return false;
  }
  // Config-independent status (untracked files and submodules always
  // shown). A worktree that cannot be inspected is kept too: only an
  // explicit --drop forces the removal of unknown or uncommitted work.
  const dir = join(stateDir(), "lanes", s.id);
  if (s.id !== drop && existsSync(s.worktree)) {
    // A lane cut short has its leftovers committed on its branch (nothing is
    // lost) and its checkout cut: a kept checkout shows as a dormant child in
    // Orca. A lane past its snapshot keeps a dirty checkout (someone's work).
    const r = settleWorktree(dir, s, `${s.status}, gc`);
    s = r.s;
    if (r.note) out.push(r.note);
    if (r.kept) {
      out.push(`kept ${s.id} (${r.kept})`);
      return false;
    }
  }
  s = dropTmpDir(dir, s);
  // The Orca observer is closed before the record (its only handle) goes.
  s = retireDisplay(dir, s);
  // An explicit --drop goes on even so (Orca gone for good, say).
  if (s.orca && !s.orca.retired && s.id !== drop) {
    out.push(`kept ${s.id} (Orca observer terminal not closed yet)`);
    return false;
  }
  // Neither branch nor checkout left (deleted by hand, or the repo moved on):
  // the record protects nothing and would be kept as "not integrated" forever.
  const hasBranch = git(s.repo, "show-ref", "--verify", "--quiet", `refs/heads/${s.branch}`).ok;
  if (s.id !== drop && !hasBranch && !existsSync(s.worktree) && !delivered) {
    rmSync(join(stateDir(), "lanes", s.id), { recursive: true, force: true });
    appendLedger({ kind: "outcome", id: s.id, at: new Date().toISOString(), outcome: s.changed ? "dropped" : "nochange", by });
    out.push(`removed ${s.id} (branch and worktree already gone)`);
    return true;
  }
  const merged = git(s.repo, "merge-base", "--is-ancestor", s.branch, "HEAD").ok;
  const squashed = s.changed && git(s.repo, "diff", "--quiet", "HEAD", s.branch, "--").ok;
  const applied = s.status === "complete" && s.changed && s.id !== drop && !merged && !squashed
    && spawnSync("sh", ["-c",
      'git -C "$1" diff --binary --no-ext-diff --no-textconv "$2" "$3" | git -C "$1" apply --reverse --check',
      "lane-gc", s.repo, s.base, s.branch,
    ], { encoding: "utf8" }).status === 0;
  if (!(merged || squashed || applied || delivered || !s.changed || s.id === drop)) {
    out.push(`kept ${s.id} (${s.status}, not integrated)`);
    return false;
  }
  if (existsSync(s.worktree) && !removeWorktree(s.repo, s.worktree)) {
    out.push(`kept ${s.id} (git worktree remove failed)`);
    return false;
  }
  if (git(s.repo, "show-ref", "--verify", "--quiet", `refs/heads/${s.branch}`).ok && !git(s.repo, "branch", "-D", s.branch).ok) {
    out.push(`kept ${s.id} (branch removal failed)`);
    return false;
  }
  const outcome: Outcome = !s.changed ? "nochange" : merged || squashed || applied || delivered ? "integrated" : superseded && s.id === drop ? "superseded" : "dropped";
  rmSync(join(stateDir(), "lanes", s.id), { recursive: true, force: true });
  if (!delivered || recorded?.kind !== "outcome" || !recorded.delivery) appendLedger({ kind: "outcome", id: s.id, at: new Date().toISOString(), outcome, by, repo: s.repo, ...(delivered ? { branch: delivered.branch, delivery: { commit: delivered.commit, pushed: delivered.pushed === true, ...(delivered.prUrl ? { prUrl: delivered.prUrl } : {}) } } : {}) });
  out.push(`removed ${s.id}${applied ? " (applied)" : delivered ? ` (delivered to ${delivered.branch})` : ""}`);
  return true;
}

// Removes only what a lane created, and only once nothing is lost: the branch
// is integrated, its patch reverses cleanly from the repo tree, or it produced no change.
export function laneGc(drop?: string, opts: { superseded?: boolean; cacheOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  purgeWorkerCache(out);
  if (opts.cacheOnly) return out;
  // Pinned grok copies of older versions (about 300 MB each): keep the current one only.
  const binDir = join(stateDir(), "bin");
  if (existsSync(binDir)) {
    const current = spawnSync("sh", ["-c", "command -v grok"]).status === 0 ? basename(pinnedGrok() ?? "") : "";
    for (const f of readdirSync(binDir)) {
      if (f !== current) {
        rmSync(join(binDir, f), { force: true });
        out.push(`removed pinned ${f}`);
      }
    }
  }
  for (const s of listLanes()) gcLane(s, drop, out, "gc", opts.superseded);
  for (const o of listOrphans()) gcOrphan(o, drop, out);
  return out;
}

// The workers' shared bun cache (src/harness/proc.ts) only grows; the next
// install refills it. A running lane may be installing from it: wait for none.
export function purgeWorkerCache(out: string[], state = stateDir()): void {
  const dir = bunCacheDir(state);
  if (!existsSync(dir)) return;
  const running = listLanes(state).filter((s) => s.status === "running").length;
  if (running) {
    out.push(`kept worker bun cache: ${running} lane(s) running`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  out.push("removed worker bun cache");
}

// The default branch is the operator's: an autonomous integration lands on a
// feature branch, or on it only from a lead in bypassPermissions or auto mode
// (laneIntegrate). main, master and whatever origin/HEAD names count.
function protectedBranch(repo: string, branch: string): boolean {
  if (branch === "main" || branch === "master") return true;
  const remote = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  return remote.ok && remote.out.replace(/^origin\//, "") === branch;
}

// Integrations apply to one shared working tree: one at a time, under a
// kernel lock (src/lanes/lock.ts) that dies with its holder.
const withIntegrateLock = <T>(fn: () => T) => withFileLock(join(stateDir(), "integrate.lck"), fn);

export interface IntegrateResult { report: string; integrated: boolean }

// Delivery: the lane's verified change becomes one commit on a branch of its
// own, pushed, with a PR to the branch the lane started from. The caller's
// checkout is never touched, so any number of lanes deliver side by side;
// merging stays the operator's (2026-11-02: five tickets would otherwise
// land mixed and uncommitted in one working tree).
export interface Deliver { branch: string; message: string; push?: boolean; pr?: boolean }

/** Why a delivery branch name is refused, or null. */
export function deliverBranchProblem(repo: string, branch: string, resumedCommit?: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.startsWith("lane/")) return `branch ${JSON.stringify(branch)}: use <type>/<ticket>-<slug> (letters, digits, . _ - /; not lane/)`;
  if (!git(repo, "check-ref-format", "--branch", branch).ok) return `branch ${branch}: not a valid git branch name`;
  if (protectedBranch(repo, branch) || branch === "develop") return `branch ${branch}: a delivery never targets a shared branch`;
  const existing = git(repo, "rev-parse", "--verify", `refs/heads/${branch}`);
  if (existing.ok && existing.out !== resumedCommit) return `branch ${branch} already exists: pick another name, nothing is overwritten`;
  return null;
}

function remoteDefaultBranch(repo: string): string | undefined {
  const r = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  return r.ok && r.out ? r.out.replace(/^origin\//, "") : undefined;
}

interface DeliveryState {
  verifiedSha: string; base: string; branch: string; message: string; commit: string;
  pushed?: boolean; prUrl?: string;
}
type DeliveryOutcome = Pick<DeliveryState, "branch" | "commit" | "pushed" | "prUrl">;

function readDelivery(dir: string): DeliveryState | undefined {
  const path = join(dir, "delivery.json");
  if (!existsSync(path)) return undefined;
  const saved = JSON.parse(readFileSync(path, "utf8")) as DeliveryState;
  if (![saved.verifiedSha, saved.base, saved.branch, saved.message, saved.commit].every((v) => typeof v === "string" && v.length)) throw new Error("invalid delivery checkpoint");
  return saved;
}

function saveDelivery(dir: string, saved: DeliveryState): void {
  const path = join(dir, "delivery.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Checkpoint before each external effect. A retry reuses the same commit and
// branch, verifies the remote ref, then discovers an already-created PR.
function deliverLane(s: LaneState, d: Deliver, dir: string, previous?: DeliveryState): { lines: string[]; ok: boolean; complete: boolean } {
  const failed = (line: string) => ({ ok: false, complete: false, lines: [line] });
  let saved = previous;
  if (saved && (saved.verifiedSha !== s.verifiedSha || saved.base !== s.base || saved.branch !== d.branch || saved.message !== d.message.trim())) return failed("delivery checkpoint differs: resume with the same branch and commit message");
  const msgFile = join(dir, "deliver-message.txt");
  writeFileSync(msgFile, d.message.endsWith("\n") ? d.message : `${d.message}\n`);
  if (!saved) {
    const commit = spawnSync("git", ["-C", s.repo, "commit-tree", `${s.verifiedSha}^{tree}`, "-p", s.base, "-F", msgFile], { encoding: "utf8" });
    const sha = (commit.stdout ?? "").trim();
    if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return failed(`commit failed: ${tail(commit.stderr || commit.stdout || "", 4)}`);
    saved = { verifiedSha: s.verifiedSha!, base: s.base, branch: d.branch, message: d.message.trim(), commit: sha };
    saveDelivery(dir, saved);
  }
  const sha = saved.commit;
  if (git(s.repo, "rev-parse", `${sha}^{tree}`).out !== git(s.repo, "rev-parse", `${s.verifiedSha}^{tree}`).out
    || git(s.repo, "rev-parse", `${sha}^`).out !== s.base) return failed("delivery checkpoint no longer names the verified tree on its base");
  const existing = git(s.repo, "rev-parse", "--verify", `refs/heads/${d.branch}`);
  if (!existing.ok) {
    const made = git(s.repo, "branch", d.branch, sha);
    if (!made.ok) return failed(`branch ${d.branch} failed: ${made.err.split("\n")[0]}`);
  } else if (existing.out !== sha) return failed(`delivery branch ${d.branch} changed: nothing is overwritten`);
  const lines = [`BRANCH: ${d.branch}`, `COMMIT: ${sha.slice(0, 12)} on ${s.base.slice(0, 12)} (one commit, the verified tree)`];
  const pending = () => ({ ok: true, complete: false, lines: [...lines, "NEXT: repeat lane integrate with the same branch and message to resume delivery; do not re-run the worker"] });
  const hasOrigin = git(s.repo, "remote", "get-url", "origin").ok;
  let pushed = false;
  if (d.push === false) lines.push("PUSH: skipped (--no-push)");
  else if (!hasOrigin) { lines.push("PUSH: pending (no origin remote)"); return pending(); }
  else {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const remote = spawnSync("git", ["-C", s.repo, "ls-remote", "--heads", "origin", `refs/heads/${d.branch}`], { encoding: "utf8", timeout: 30_000, env });
    if (remote.status !== 0) { lines.push(`PUSH: pending: cannot inspect origin (${remote.status})`); return pending(); }
    const remoteSha = remote.stdout.trim().split(/\s+/)[0];
    if (remoteSha && remoteSha !== sha) { lines.push("PUSH: pending: remote branch already exists with another commit, nothing is overwritten"); return pending(); }
    if (remoteSha === sha) pushed = true;
    else {
      // An empty lease requires a new remote ref, including a race after ls-remote.
      const push = spawnSync("git", ["-C", s.repo, "push", "--porcelain", `--force-with-lease=refs/heads/${d.branch}:`, "-u", "origin", `refs/heads/${d.branch}:refs/heads/${d.branch}`],
        { encoding: "utf8", timeout: 120_000, env });
      pushed = push.status === 0;
      if (!pushed) { lines.push(`PUSH: failed: ${tail(push.stderr || push.stdout || `exit ${push.status}`, 3)}`); return pending(); }
    }
    saved.pushed = true;
    saveDelivery(dir, saved);
    lines.push(`PUSH: origin/${d.branch}`);
  }
  const target = s.baseBranch && !s.baseBranch.startsWith("lane/") ? s.baseBranch : remoteDefaultBranch(s.repo);
  if (d.pr === false || d.push === false) lines.push(`PR: skipped (${d.pr === false ? "--no-pr" : "--no-push"})`);
  else if (!target) { lines.push("PR: pending (no base branch known)"); return pending(); }
  else if (spawnSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).status !== 0) { lines.push("PR: pending (gh not on PATH)"); return pending(); }
  else {
    // A create may have succeeded before a timeout or crash. Discover it first.
    const viewed = spawnSync("gh", ["pr", "list", "--head", d.branch, "--base", target, "--state", "all", "--json", "url,state", "--limit", "1"],
      { cwd: s.repo, encoding: "utf8", timeout: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    if (viewed.status !== 0) { lines.push(`PR: pending: cannot inspect existing PR (${viewed.status})`); return pending(); }
    let prs: { url?: string; state?: string }[];
    try { prs = JSON.parse(viewed.stdout); if (!Array.isArray(prs)) throw new Error(); }
    catch { lines.push("PR: pending: invalid response while inspecting existing PR"); return pending(); }
    const found = prs.find((p) => p.state === "OPEN" || p.state === "MERGED");
    if (found?.url && /^https?:\/\/\S+$/.test(found.url)) {
      saved.prUrl = found.url;
      saveDelivery(dir, saved);
      lines.push(`PR: ${found.url} (into ${target}; merging is the operator's)`);
      return { ok: true, complete: true, lines };
    }
    if (prs.length) { lines.push("PR: pending: the existing PR is closed, reopen it before resuming"); return pending(); }
    const [subject, ...rest] = d.message.trim().split("\n");
    const notes = [
      `orch lane ${s.id}: VERIFY \`${s.verify ?? "none"}\` passed on the delivered tree.`,
      ...(/worker blocked: [^;]*/.exec(s.reason ?? "") ? [`Worker note: ${/worker blocked: [^;]*/.exec(s.reason ?? "")![0]}.`] : []),
    ];
    const bodyFile = join(dir, "deliver-pr.md");
    writeFileSync(bodyFile, `${rest.join("\n").trim()}\n\n${notes.join("\n")}\n`.trimStart());
    const pr = spawnSync("gh", ["pr", "create", "--base", target, "--head", d.branch, "--title", subject!, "--body-file", bodyFile],
      { cwd: s.repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    const url = /https?:\/\/\S+/.exec(pr.stdout ?? "")?.[0];
    if (pr.status !== 0 || !url) { lines.push(`PR: failed: ${tail(pr.stderr || pr.stdout || `exit ${pr.status}`, 3)}`); return pending(); }
    saved.prUrl = url;
    saveDelivery(dir, saved);
    lines.push(`PR: ${url} (into ${target}; merging is the operator's)`);
  }
  return { ok: true, complete: true, lines };
}

// The integration gate. A complete lane lands in its caller repo's working
// tree only when VERIFY passed, every touched file is in the spec's FILES,
// a risky spec was reviewed, and the repo is on a feature branch (or on the
// default branch when the calling lead, ORCH_LEAD_PID, runs in
// bypassPermissions or auto mode). Otherwise
// nothing moves and the report names each reason.
export async function laneIntegrate(id: string, deliver?: Deliver): Promise<IntegrateResult> {
  const refused = (why: string[], log = true) => {
    if (log) appendLedger({ kind: "gate", id, at: new Date().toISOString(), reasons: why });
    return { report: `LANE INTEGRATE\nSTATUS: refused\nID: ${id}\n${why.map((w) => `GATE: ${w}`).join("\n")}\n`, integrated: false };
  };
  const result = await withIntegrateLock(() => {
    const s = listLanes().find((l) => l.id === id);
    const saved = readLedger().filter((r) => r.kind === "outcome" && r.id === id).at(-1);
    if (!s || saved?.kind === "outcome" && saved.outcome === "integrated" && saved.delivery) {
      if (deliver && saved?.kind === "outcome" && saved.outcome === "integrated" && saved.repo && saved.delivery && saved.branch === deliver.branch) {
        const d = saved.delivery;
        if (git(saved.repo, "rev-parse", `refs/heads/${saved.branch}`).out !== d.commit
          || git(saved.repo, "show", "-s", "--format=%B", d.commit).out.trim() !== deliver.message.trim()) return refused(["completed delivery differs from the requested branch, commit or message"]);
        if (deliver.push !== false && !d.pushed || deliver.push !== false && deliver.pr !== false && !d.prUrl) return refused(["the recorded delivery completed a narrower request; push or open its PR explicitly"]);
        const cleanup: string[] = [];
        if (s) gcLane(s, id, cleanup, "integrate", false, { branch: saved.branch, ...d });
        return { report: `LANE INTEGRATE\nSTATUS: integrated\nID: ${id}\nDELIVERY: ${d.prUrl ? "pr" : d.pushed ? "pushed" : "local"}\nBRANCH: ${saved.branch}\nCOMMIT: ${d.commit}\nPUSH: ${d.pushed ? `origin/${saved.branch}` : "skipped (--no-push)"}\nPR: ${d.prUrl ?? "skipped"}\nREPLAY: completed delivery, no commit, push or PR repeated\n${cleanup.length ? `GC: ${cleanup.join("; ")}\n` : ""}`, integrated: true };
      }
      return refused(["no lane record with this id (lane status lists them)"], false);
    }
    const why: string[] = [];
    if (s.status !== "complete") why.push(`status ${s.status}, not complete`);
    if (s.escapes?.written.length) why.push(`worker wrote outside its worktree: ${s.escapes.written.slice(0, 8).join(", ")}`);
    if (!s.changed) why.push("no change to integrate");
    if (s.verifyOk !== true) why.push(s.verifyOk === undefined ? "no VERIFY result recorded (lane predates the gate)" : "VERIFY did not pass");
    // Also for a lane recorded before this check: its green may be another checkout's.
    else if (s.verify) {
      const dir = existsSync(s.worktree) ? s.worktree : s.repo;
      const escape = verifyReach(s.verify, dir, { ...process.env, LANE_REPO: s.repo, LANE_WORKTREE: dir });
      if (escape) why.push(`VERIFY ${escape}`);
    }
    if (!s.verifiedSha) why.push("no verified commit recorded (lane predates the gate or VERIFY changed the tree)");
    const tip = git(s.repo, "rev-parse", "--verify", `${s.branch}^{commit}`);
    if (!tip.ok) why.push(`cannot resolve ${s.branch}`);
    else if (s.verifiedSha && tip.out !== s.verifiedSha) why.push("lane branch changed since VERIFY; run a new lane");
    const names = s.verifiedSha ? git(s.repo, "diff", "--name-only", "--no-renames", s.base, s.verifiedSha) : undefined;
    if (names && !names.ok) why.push(`cannot diff verified commit: ${names.err.split("\n")[0]}`);
    const touched = names?.ok ? names.out.split("\n").filter(Boolean) : [];
    if (!s.declared?.length) why.push("no declared FILES recorded");
    else {
      const outside = touched.filter((f) => !inScope(f, s.declared!));
      if (outside.length) why.push(`${outside.length} file(s) outside FILES: ${outside.slice(0, 8).join(", ")}`);
      const banned = protectedTouched(touched);
      if (banned.length) why.push(`protected path: ${banned.slice(0, 8).join(", ")}`);
    }
    if (s.verify && s.verifiedSha && touched.length) {
      const base = runBaseCommitVerify({
        repo: s.repo, base: s.base, sha: s.verifiedSha, verify: s.verify, files: touched,
        setup: s.setupArgv ?? setupCommand({ fields: {} } as unknown as Spec, s.repo)?.argv,
      });
      if (!("skipped" in base) && !base.ok) why.push(`base-commit tests failed: ${base.out.slice(0, 200) || "exit non-zero"}`);
    }
    // Only the latest successful ship for this exact commit authorizes risk.
    if (s.risk?.length) {
      const review = lastReview(readLedger(), id);
      if (review?.verdict !== "ship") why.push(`risk ${s.risk.join(", ")}: ${review ? `last review says ${review.verdict}` : "no review yet"}; lane review --lane ${id} records one`);
      if (review && !review.reviewedSha) why.push("no reviewed commit recorded (lane review predates the gate)");
      else if (review && review.reviewedSha !== tip.out) why.push("lane branch changed since review; review the verified commit again");
      if (review && review.ok !== true) why.push(`review did not succeed: ${review.status ?? "no review run result recorded (lane predates the gate)"}`);
    }
    if (deliver) {
      // Nothing lands in the caller's checkout: its branch does not matter.
      const dir = join(stateDir(), "lanes", id);
      let previous: DeliveryState | undefined;
      try { previous = readDelivery(dir); } catch { return refused(["invalid delivery checkpoint: lane kept for inspection"]); }
      const bad = deliverBranchProblem(s.repo, deliver.branch, previous?.branch === deliver.branch ? previous.commit : undefined);
      if (bad) why.push(bad);
      if (!deliver.message.trim() || deliver.message.trim().split("\n")[0]!.length > 100) why.push("delivery message: a subject line of 1 to 100 characters, then an optional body");
      if (why.length) return refused(why);
      const d = deliverLane(s, deliver, dir, previous);
      if (!d.ok) return refused(d.lines);
      if (!d.complete) return { report: `LANE INTEGRATE\nSTATUS: delivery-pending\nID: ${id}\n${d.lines.join("\n")}\n`, integrated: false };
      const stat = tail(git(s.repo, "diff", "--stat", s.base, s.verifiedSha!).out, 12);
      const out: string[] = [];
      const completed = readDelivery(dir)!;
      const stage = completed.prUrl ? "pr" : completed.pushed ? "pushed" : "local";
      // Completion is durable before cleanup can remove either the lane ref or
      // checkpoint. A crash during GC is resumed from this same receipt.
      appendLedger({ kind: "outcome", id, at: new Date().toISOString(), outcome: "integrated", by: "integrate", repo: s.repo,
        branch: completed.branch, delivery: { commit: completed.commit, pushed: completed.pushed === true, ...(completed.prUrl ? { prUrl: completed.prUrl } : {}) } });
      gcLane(s, id, out, "integrate", false, completed);
      return {
        report: `LANE INTEGRATE\nSTATUS: integrated\nID: ${id}\nINTO: ${deliver.branch} (delivered; ${s.repo} untouched)\nDELIVERY: ${stage}\n${d.lines.join("\n")}\nAPPLIED:\n${stat || touched.join("\n")}\nGC: ${out.join("; ") || "nothing"}\n`,
        integrated: true,
      };
    }
    const branch = git(s.repo, "branch", "--show-current").out;
    if (!branch) why.push("caller repo is on a detached HEAD");
    let unattended: string | null = null;
    if (branch && protectedBranch(s.repo, branch)) {
      unattended = unattendedLeadMode(Number(process.env.ORCH_LEAD_PID));
      if (!unattended) why.push(`caller repo is on ${branch}: the default branch takes a lane only from a lead in bypassPermissions or auto mode`);
      // Nobody reviews an unattended landing: a worker that said it could not
      // check its work (LANE: blocked) needs the operator, whatever VERIFY said.
      const blocked = /(?:^|; )(worker blocked: [^;]*)/.exec(s.reason ?? "")?.[1];
      if (unattended && blocked) why.push(`${blocked.slice(0, 200)}: on ${branch}, a lane its worker reported blocked waits for the operator`);
    }
    if (why.length) return refused(why);

    // Stat and patch use the verified commit even if the branch moves now.
    const sha = s.verifiedSha!;
    const stat = tail(git(s.repo, "diff", "--stat", s.base, sha).out, 12);
    const patch = 'git -C "$1" diff --binary --no-ext-diff --no-textconv "$2" "$3" | git -C "$1" apply';
    const check = spawnSync("sh", ["-c", `${patch} --check`, "lane-integrate", s.repo, s.base, sha], { encoding: "utf8" });
    if (check.status !== 0) return refused([`patch does not apply to the working tree:\n${tail(check.stderr || check.stdout, 8)}`]);
    const apply = spawnSync("sh", ["-c", patch, "lane-integrate", s.repo, s.base, sha], { encoding: "utf8" });
    if (apply.status !== 0) return refused([`git apply failed:\n${tail(apply.stderr || apply.stdout, 8)}`]);
    const out: string[] = [];
    gcLane(s, undefined, out, "integrate");
    return {
      report: `LANE INTEGRATE\nSTATUS: integrated\nID: ${id}\nINTO: ${s.repo} (${branch}, uncommitted${unattended ? `, default branch: lead in ${unattended}` : ""})\nAPPLIED:\n${stat || touched.join("\n")}\nGC: ${out.join("; ") || "nothing"}\n${s.gate ? `${formatTiming(s.gate)}\n` : ""}`,
      integrated: true,
    };
  });
  return result ?? refused(["another integration held the lock for 60s"]);
}

// Review a lane branch in a throwaway detached checkout (the lane's own
// worktree is already cut), then record the verdict for the gate.
export async function laneReviewLane(id: string, opts: {
  from: Harness; to?: HarnessId; profile: Profile; risk?: "normal" | "high"; goal?: string; model?: string; effort?: string;
  skipReserve?: boolean; spendHold?: string; watched?: boolean;
}): Promise<{ report: string; verdict: Verdict }> {
  const s = listLanes().find((l) => l.id === id);
  if (!s) return { report: `LANE REVIEW\nSTATUS: refused-by-lane\nREASON: no lane record ${id}\n`, verdict: "unknown" };
  const wt = join(stateDir(), "lanes", id, "review-wt");
  if (existsSync(wt)) git(s.repo, "worktree", "remove", "--force", wt);
  if (!git(s.repo, "worktree", "add", "-q", "--detach", wt, s.branch).ok) {
    return { report: `LANE REVIEW\nSTATUS: unavailable\nREASON: cannot check out ${s.branch}\n`, verdict: "unknown" };
  }
  try {
    const reviewedSha = git(wt, "rev-parse", "HEAD").out;
    const review = await laneReviewDetailed({
      from: opts.from, to: opts.to ?? (s.to === "codex" ? undefined : "codex"),
      base: s.base, goal: opts.goal ?? s.objective ?? `lane ${id}`, repo: wt, profile: opts.profile,
      risk: opts.risk ?? (s.risk?.length ? "high" : "normal"), model: opts.model, effort: opts.effort,
      skipReserve: opts.skipReserve, spendHold: opts.spendHold, watched: opts.watched,
    });
    const verdict = review.ok ? parseVerdict(review.message) : "unknown";
    const findings = scoreFindings(review.message);
    appendLedger({
      kind: "review", id, at: new Date().toISOString(), to: review.to ?? opts.to ?? "unknown",
      model: review.model ?? "inherited", effort: review.effort ?? "default", verdict, reviewedSha,
      ok: review.ok, status: review.status, ...(findings.length ? { findings } : {}),
    });
    const scored = findings.length ? `${review.report}${formatFindings(findings)}\n` : review.report;
    return { report: scored, verdict };
  } finally {
    git(s.repo, "worktree", "remove", "--force", wt);
  }
}

function restoreLaneWorktree(s: LaneState): { wt: string } | { error: string } {
  if (existsSync(s.worktree)) return { wt: s.worktree };
  const tip = s.verifiedSha || s.branch;
  if (!tip) return { error: "worktree already cut and no branch/commit to restore" };
  const dir = join(stateDir(), "lanes", s.id);
  const wt = s.worktree || join(dir, "wt");
  const guard = testRepoRefusal(s.repo);
  if (guard) return { error: guard };
  mkdirSync(dirname(wt), { recursive: true });
  const added = git(s.repo, "worktree", "add", "-B", s.branch, wt, tip);
  if (!added.ok) {
    const det = git(s.repo, "worktree", "add", "--detach", wt, tip);
    if (!det.ok) return { error: `cannot restore worktree: ${(added.err || det.err || "").trim()}` };
  }
  s.worktree = wt;
  neutralizeWorktreeHooks(wt, join(dir, "no-hooks"));
  saveLane(dir, s);
  return { wt };
}

// A follow owns the lane's checkout for its whole run: the lane's finalizer,
// the reaper and gc never cut it meanwhile.
export async function laneFollow(id: string, text: string, opts: { model?: string; effort?: string } = {}): Promise<string> {
  const dir = join(stateDir(), "lanes", id);
  if (!existsSync(dir)) return `LANE FOLLOW\nSTATUS: refused-by-lane\nREASON: no lane record ${id}\n`;
  const release = lockLane(dir, 15_000);
  if (!release) return `LANE FOLLOW\nSTATUS: refused-by-lane\nREASON: lane ${id} is busy (its finalizer, a reaper or another follow holds it)\n`;
  try { return await laneFollowOwned(id, text, opts); } finally { release(); }
}

async function laneFollowOwned(id: string, text: string, opts: { model?: string; effort?: string }): Promise<string> {
  const s = listLanes().find((l) => l.id === id);
  if (!s) return `LANE FOLLOW\nSTATUS: refused-by-lane\nREASON: no lane record ${id}\n`;
  const dir = join(stateDir(), "lanes", id);
  const restored = restoreLaneWorktree(s);
  if ("error" in restored) return `LANE FOLLOW\nSTATUS: refused-by-lane\nREASON: ${restored.error}\n`;
  const wt = restored.wt;
  const n = readdirSync(dir).filter((f) => f.startsWith("follow-")).length + 1;
  const promptPath = join(dir, `follow-${n}.txt`);
  writeFileSync(promptPath, `FOLLOW-UP to the same worker conversation.\n\n${text.trim()}\n`);
  const lastPath = join(dir, "last.txt");
  const logPath = join(dir, `follow-${n}.log`);
  const verifyLog = join(dir, `follow-${n}-verify.log`);
  const p = loadProfile();
  // Reuse the lane's recorded model/effort; explicit --model/--effort still win.
  // Do not rebuild from the profile edit role (that would swap haiku/low for sonnet/xhigh).
  const choice = withExplicit(
    { model: s.model, effort: s.effort },
    {},
    { model: opts.model, effort: opts.effort },
  );
  const grokBin = s.to === "grok" ? pinnedGrok() ?? undefined : undefined;
  // Its own temp dir for this follow, removed when it ends.
  const followTmp = mkdtempSync(join(tmpdir(), "orch-lane-"));
  // Recorded, so a follow killed before its finally is cleaned by the reaper.
  s.tmpDir = followTmp;
  saveLane(dir, s);
  const call = workerArgv(s.to, choice, {
    cwd: wt, promptPath, effort: choice.effort, readOnly: false, lastMessagePath: lastPath, bin: grokBin, tmpDir: followTmp,
  });
  const argv = s.workerSession && s.to === "claude" ? [...call.argv, "--resume", s.workerSession] : call.argv;
  const sd = stateDir();
  const started = new Date().toISOString();
  let hold: SpendHold | undefined;
  try {
    hold = reserveSpend({ usd: estimatedUsdForHarness(s.to, choice.effort), source: `lane-follow:${id}`, label: "lane follow", state: sd });
  } catch (error) {
    rmSync(followTmp, { recursive: true, force: true });
    return `LANE FOLLOW\nSTATUS: refused-by-lane\nREASON: ${(error as Error).message}\n`;
  }
  const timing = emptyTiming();
  try {
    const run = await runLogged(argv, {
      cwd: wt, logPath, stdinPath: call.stdin ? promptPath : undefined,
      timeoutMs: p.limits.timeout_seconds * 1000, env: workerEnv({}, { tmpDir: followTmp }),
    });
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const last = existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "";
    const parsed = parseWorkerOutput(s.to, log, last);
    const followUsage = sessionCostDelta(s.usage ?? {}, parsed.usage);
    const sid = sessionId(log);
    if (sid) s.workerSession = sid;

    const after = statusEntries(wt);
    const dirty = (after ?? []).filter((e, i, all) => !(i > 0 && /^[RC]/.test(all[i - 1])) && !isHarnessOwned(e.slice(3), s.declared ?? [])).join("\n");
    let snapshotError: string | undefined;
    if (after === null) snapshotError = "git status failed in the worktree after follow";
    else if (dirty) {
      const added = git(wt, "add", "-A", ...addPathspec(s.declared ?? [], wt));
      if (!added.ok) snapshotError = `git add failed:\n${tail(added.err || added.out, 12) || "no error output"}`;
      else {
        const committed = git(wt, "-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit", "-q", "-m",
          `lane ${id} follow: ${text.split("\n")[0].slice(0, 60)}`);
        if (!committed.ok) snapshotError = `git commit failed:\n${tail(committed.err || committed.out, 12) || "no error output"}`;
      }
    }

    const verifyTip = git(wt, "rev-parse", "HEAD");
    let verifyOk: boolean | null = null;
    let verifiedSha: string | undefined = s.verifiedSha;
    let verifyOut = "not run";
    const outage = engineUnavailable(classifyLog(s.to, log));
    if (outage) await markEngineUnavailable(s.to, outage, sd);
    if (s.verify && !run.timedOut && !snapshotError && !outage) {
      const names = git(wt, "diff", "--name-only", "--no-renames", s.base, "HEAD");
      const files = names.ok ? names.out.split("\n").filter(Boolean) : [];
      const scoped = gateVerify(s.verify, files, { exists: (p) => existsSync(join(wt, p)) });
      const escape = verifyReach(scoped.command, wt, workerEnv({ LANE_REPO: s.repo, LANE_WORKTREE: wt }));
      const waitStart = performance.now();
      const verify = escape ? null : await reserveVerifySlot(sd, p.limits.verify_concurrent, `${id}-follow`, VERIFY_TIMEOUT_MS);
      timing.waitMs = Math.round(performance.now() - waitStart);
      if (escape) {
        verifyOk = false;
        verifyOut = escape;
      } else if (verify === null) {
        verifyOk = false;
        verifyOut = "timeout waiting for verify slot";
      } else {
        try {
          const runStart = performance.now();
          const v = await runLogged(["sh", "-c", scoped.command], {
            cwd: wt, logPath: verifyLog, timeoutMs: verify.timeoutMs, env: workerEnv({ LANE_REPO: s.repo, LANE_WORKTREE: wt }),
            onSpawn: (pgid) => recordSlotGroup(sd, verify.slot, pgid, "verify-slots"),
          });
          timing.runMs = Math.round(performance.now() - runStart);
          verifyOk = v.code === 0 && !v.timedOut;
          if (verifyOk && verifyTip.ok) {
            const tip = git(wt, "rev-parse", "HEAD");
            const tracked = git(wt, "diff", "--quiet", "HEAD");
            if (tip.ok && tip.out === verifyTip.out && tracked.ok) verifiedSha = tip.out;
          }
          verifyOut = `exit ${v.code}${v.timedOut ? " (timeout)" : ""}\n${tail(existsSync(verifyLog) ? readFileSync(verifyLog, "utf8") : "", 12)}`;
        } finally {
          releaseSlot(sd, verify.slot, "verify-slots");
        }
      }
    }

    const changed = Boolean(dirty);
    const ended = new Date().toISOString();
    let status: Status;
    let reason = snapshotError;
    if (snapshotError || after === null) {
      status = "failed";
    } else {
      const resolved = resolveLaneStatus({
        status: classify({ ...run, changed, verifyOk, log: classifyLog(s.to, log) }),
        verifyOk, changed,
        finish: s.to === "claude" ? finishLine(parsed.message) : undefined,
      });
      status = resolved.status;
      if (resolved.reason) reason = resolved.reason;
    }
    if (outage) { status = "unavailable"; reason = `${s.to}: ${outage.reason}`; }
    s.verifyOk = verifyOk;
    s.verifiedSha = verifiedSha;
    s.usage = addUsage(s.usage ?? {}, followUsage);
    s.ended = ended;
    s.status = status;
    if (reason) s.reason = reason;
    s.changed = s.changed || changed;
    s.gate = timing;
    saveLane(dir, s);

    const diff = numstat(wt, s.base);
    appendLedger({
      kind: "run", id, at: ended, repo: projectKey(s.repo), to: s.to,
      model: parsed.model ?? choice.model ?? "inherited",
      effort: choice.effort ?? "default",
      channel: "follow",
      status, changed, verifyOk, verifiedSha,
      features: { files: s.declared ?? [], stacks: [], risk: s.risk ?? [], objective: s.objective ?? "" },
      diff, outOfScope: [],
      durationS: Math.round((Date.parse(ended) - Date.parse(started)) / 1000),
      usage: followUsage, gate: timing,
    }, sd);
    settleHold(hold.id, {
      at: ended,
      usd: actualUsdForHarness(s.to, followUsage, (parsed.model ?? choice.model) ?? undefined),
      source: `lane-follow:${id}`,
      provider: s.to,
      model: parsed.model ?? choice.model ?? "inherited",
      session: s.workerSession,
      project: projectKey(s.repo),
      tokens: usageTokensOf(followUsage),
    }, sd);
    hold = undefined;

    const sha = verifiedSha ?? (verifyTip.ok ? verifyTip.out : "");
    return [
      "LANE FOLLOW",
      `ID: ${id}`,
      `STATUS: ${status === "complete" && run.code === 0 ? "ok" : status}`,
      reason ? `REASON: ${reason}` : "",
      `VERIFY: ${verifyOut}`,
      sha ? `SHA: ${sha}` : "",
      `RESUME: ${s.workerSession ?? "new prompt (no session id)"}`,
      `USAGE: ${fmtUsage(followUsage)}`,
      `LOG: ${logPath}`,
    ].filter(Boolean).join("\n") + "\n";
  } finally {
    rmSync(followTmp, { recursive: true, force: true });
    if (hold) releaseSpend(hold.id, sd);
  }
}

export async function lanePlan(opts: { question: string; leadPlan?: string; repo: string; profile: Profile }): Promise<string> {
  const planner = plannerOf(opts.profile, opts.repo);
  const asked = await laneAsk({
    from: leadHarness(), to: planner.to, question: `Read-only architecture / simplification plan. Do not edit files.\n\n${opts.question}`,
    repo: opts.repo, profile: opts.profile, model: planner.model, effort: planner.effort,
  });
  if (!opts.leadPlan?.trim()) {
    return `LANE PLAN\nPLANNER: ${planner.to} · ${planner.model ?? "inherited"} · effort ${planner.effort ?? "default"}\n${asked}`;
  }
  const cmp = comparePlans(opts.leadPlan, asked);
  return `LANE PLAN\nPLANNER: ${planner.to} · ${planner.model ?? "inherited"} · effort ${planner.effort ?? "default"}\nPREFERRED: ${cmp.preferred}  ${cmp.reason}\nDIFF:\n${cmp.diff}\n\nLEAD PLAN:\n${opts.leadPlan.trim()}\n\nPLANNER PLAN:\n${asked}`;
}

export function laneCheck(id: string): string {
  const s = listLanes().find((l) => l.id === id);
  if (!s) return `LANE CHECK\nSTATUS: refused-by-lane\nREASON: no lane record ${id}\n`;
  return formatCheck(id, checkLane(s, { setup: s.setupArgv ?? setupCommand({ fields: {} } as unknown as Spec, s.repo)?.argv }));
}

export function checkExitCode(report: string): number {
  if (/^STATUS: refused-by-lane$/m.test(report) || /^VERIFY: fail$/m.test(report)) return 2;
  return 0;
}

export function installedLaneHarnesses(to?: HarnessId, root = stateDir(), which: (h: HarnessId) => boolean = installed): HarnessId[] {
  const all = HARNESS_IDS.filter((h) => (HARNESSES as string[]).includes(h) && which(h));
  return to ? all : usableEngines(all, root);
}

export function laneRoute(opts: { specPath: string; profile: Profile; to?: HarnessId; installed?: HarnessId[] }) {
  const spec = parseSpec(readFileSync(opts.specPath, "utf8"));
  const features = specFeatures(spec);
  const efforts = Object.fromEntries(HARNESSES.map((h) => {
    const edit = roleChoice("edit", h, opts.profile);
    return [h, edit.effort ?? opts.profile.lanes[h]?.effort];
  }));
  const rows = readLedger();
  let route = routeSpec(features, rows, { installed: opts.installed ? (opts.to ? opts.installed : usableEngines(opts.installed)) : installedLaneHarnesses(opts.to), config: opts.profile.route, to: opts.to, efforts });
  if (opts.profile.kiba) route = kibaRoute(route, features, specFailures(features, rows), validateKibaConfig(opts.profile.kiba, opts.profile.name), spec.fields.KIND);
  return { spec, features, route, report: routeReport(route, features, opts.specPath) };
}

// route, run, gate: one spec end to end. It stops at the first step that
// needs a human or the lead: an inline-sized spec, a lane that is not
// complete, or a gate refusal (risk, scope, VERIFY, default branch).
export async function laneAuto(opts: {
  specPath: string; repo: string; profile: Profile; to?: HarnessId; effort?: string; model?: string; from?: Harness;
  forceLane?: boolean; skipReserve?: boolean; spendHold?: string; watched?: boolean;
  // false (Kiba): stop at "to integrate"; the lead then delivers the lane to
  // a ticket branch of its own (laneIntegrate with deliver).
  integrate?: boolean;
}): Promise<{ report: string; integrated: boolean }> {
  const spend = { extraUsd: opts.skipReserve ? 0 : estimateLaneUsd(opts.effort), watched: opts.watched };
  const depth = controlRefusal("LANE REPORT", opts.profile.limits.max_depth, spend);
  if (depth) return { report: depth, integrated: false };
  const r = laneRoute({ specPath: opts.specPath, profile: opts.profile, to: opts.to });
  if (r.route.action === "self" && !opts.forceLane) {
    return { report: `${r.report}STATUS: self (nothing run: do it inline, or pass --to to force a lane)\n`, integrated: false };
  }
  if (r.route.action === "escalate") {
    return { report: `${r.report}STATUS: escalate (nothing run: this spec failed twice in lanes, the lead takes it back)\n`, integrated: false };
  }
  if (r.route.action === "self" && opts.forceLane && !r.route.to) {
    const forced = opts.to ?? installedLaneHarnesses()[0];
    if (!forced) return { report: `${r.report}STATUS: unavailable\nREASON: no lane harness installed\n`, integrated: false };
    r.route = { ...r.route, action: "lane", to: forced, reasons: [...r.route.reasons, `mission: force lane --to ${forced}`] };
  }
  if (!r.route.to) return { report: `${r.report}STATUS: unavailable\n`, integrated: false };
  let report = r.report;
  const paid = { skipReserve: opts.skipReserve, spendHold: opts.spendHold, watched: opts.watched };
  // a risky spec is put to a contest before any code; only a clean GO goes on
  if (r.features.risk.length) {
    const contest = await laneContestSpec({ specPath: opts.specPath, repo: opts.repo, profile: opts.profile, ...paid });
    report += contest.report;
    if (!contest.go) {
      const points = contest.operator.length ? `\nFOR THE OPERATOR:\n${contest.operator.map((p) => `- ${p}`).join("\n")}` : "";
      return { report: `${report}STATUS: needs-lead (spec contest: ${contest.why}; nothing was run)${points}\nNEXT: edit the spec on CHANGE, bring the operator's points to the operator, then lane auto again\n`, integrated: false };
    }
  }
  // An explicit --effort wins over the route's, which already honours REASONING.
  const run = await laneRun({ to: r.route.to, specPath: opts.specPath, repo: opts.repo, profile: opts.profile,
    effort: opts.effort ?? r.route.effort, model: opts.model ?? r.route.model, ...paid });
  report += run.report;
  if (run.state?.status !== "complete" || !run.state.changed) return { report, integrated: false };
  if (run.state.risk?.length) {
    const review = await laneReviewLane(run.state.id, { from: leadHarness(opts.from), profile: opts.profile, risk: "high", ...paid });
    report += review.report;
  }
  if (opts.integrate === false) {
    return { report: `${report}NEXT: deliver it: lane integrate ${run.state.id} --branch <type>/<ticket>-<slug> --message-file <commit message>\n`, integrated: false };
  }
  const gate = await laneIntegrate(run.state.id);
  report += gate.report;
  return { report, integrated: gate.integrated };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "watch") {
    await laneWatch(rest);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      model: { type: "string" }, lane: { type: "string" }, superseded: { type: "boolean" }, cache: { type: "boolean" }, orca: { type: "boolean" },
      to: { type: "string" }, spec: { type: "string" }, effort: { type: "string" }, profile: { type: "string" },
      repo: { type: "string" }, base: { type: "string" }, goal: { type: "string" },
      drop: { type: "string" }, risk: { type: "string" }, file: { type: "string" }, from: { type: "string" },
      search: { type: "boolean" }, mission: { type: "string" }, concurrency: { type: "string" },
      "lead-plan": { type: "string" }, text: { type: "string" },
      branch: { type: "string" }, "message-file": { type: "string" }, "no-push": { type: "boolean" }, "no-pr": { type: "boolean" },
      "no-integrate": { type: "boolean" },
    },
  });
  const profile = loadProfile(values.profile);
  const repo = resolve(values.repo ?? process.cwd());
  const isHarnessId = (h?: string): h is HarnessId => !!h && (HARNESS_IDS as string[]).includes(h);
  if (values.effort !== undefined && !EFFORTS.has(values.effort)) throw new Error(`--effort must be one of ${[...EFFORTS].join(", ")}`);
  if (cmd === "budget") {
    const budget = liveLaneBudget(profile.limits);
    console.log(budget.budget);
    console.log(`cpu ${budget.cpu} ram ${budget.ram} ceiling ${budget.ceiling} quota ${budget.quota ?? "unlimited"} verify ${profile.limits.verify_concurrent}`);
  } else if (cmd === "run") {
    if (!isHarnessId(values.to) || !values.spec) throw new Error("usage: lane run --to claude|codex|grok --spec <file>");
    const { report } = await laneRun({ to: values.to, specPath: values.spec, repo, profile, effort: values.effort, model: values.model });
    process.stdout.write(report);
    if (/^STATUS: refused-by-lane$/m.test(report)) process.exitCode = 2;
  } else if (cmd === "route") {
    if (!values.spec) throw new Error("usage: lane route --spec <file> [--to h]");
    process.stdout.write(laneRoute({ specPath: values.spec, profile, to: isHarnessId(values.to) ? values.to : undefined }).report);
  } else if (cmd === "auto") {
    if (!values.spec) throw new Error("usage: lane auto --spec <file> [--to h] [--effort e] [--no-integrate]");
    const { report, integrated } = await laneAuto({ specPath: values.spec, repo, profile, to: isHarnessId(values.to) ? values.to : undefined,
      effort: values.effort, model: values.model, from: leadHarness(), integrate: !values["no-integrate"] });
    process.stdout.write(report);
    // --no-integrate: a complete lane is the expected end, not a refusal.
    if (!integrated && !(values["no-integrate"] && /^STATUS: complete$/m.test(report))) process.exitCode = 3;
  } else if (cmd === "batch") {
    if (!values.mission) throw new Error("usage: lane batch --mission <file> [--concurrency n] [--to h] [--effort e]");
    const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
      throw new Error("lane batch: --concurrency must be a positive integer");
    }
    const { laneBatch, batchExitCode } = await import("./lanes/mission.ts");
    const { report, status, nodes } = await laneBatch({
      missionPath: resolve(values.mission), repo, profile,
      to: isHarnessId(values.to) ? values.to : undefined,
      effort: values.effort, model: values.model, from: leadHarness(), concurrency,
    });
    process.stdout.write(report);
    process.exitCode = batchExitCode(status, nodes);
  } else if (cmd === "integrate") {
    const id = positionals[0];
    const usage = "usage: lane integrate <id> [--branch <type>/<ticket>-<slug> --message-file <f> [--no-push] [--no-pr]]";
    if (!id || Boolean(values.branch) !== Boolean(values["message-file"])) throw new Error(usage);
    const deliver = values.branch
      ? { branch: values.branch, message: readFileSync(resolve(values["message-file"]!), "utf8"), push: !values["no-push"], pr: !values["no-pr"] }
      : undefined;
    const { report, integrated } = await laneIntegrate(id, deliver);
    process.stdout.write(report);
    if (!integrated) process.exitCode = 3;
  } else if (cmd === "review" || cmd === "ask") {
    const from = leadHarness(values.from);
    const usage = cmd === "review"
      ? 'usage: lane review --base <ref> --goal "<goal>" | --lane <id> [--goal g] [--risk normal|high] [--from h] [--to h] [--model m] [--effort e]'
      : "usage: lane ask --file <question.md> [--risk normal|high] [--from h] [--to h] [--model m] [--effort e] [--search]";
    if (cmd === "review" ? !values.lane && (!values.base || !values.goal) : !values.file) throw new Error(usage);
    if (values.risk !== undefined && values.risk !== "normal" && values.risk !== "high") throw new Error(usage);
    const risk = values.risk === undefined ? undefined : values.risk === "high" ? "high" : "normal";
    const to = isHarnessId(values.to) ? values.to : undefined;
    const pin = { model: values.model, effort: values.effort };
    process.stdout.write(cmd === "ask"
      ? await laneAsk({ from, to, question: readFileSync(resolve(values.file!), "utf8"), repo, profile, risk, search: values.search, ...pin })
      : values.lane
        ? (await laneReviewLane(values.lane, { from, to, profile, risk, goal: values.goal, ...pin })).report
        : await laneReview({ from, to, base: values.base!, goal: values.goal!, repo, profile, risk, ...pin }));
  } else if (cmd === "contest") {
    const usage = "usage: lane contest --file <question.md> | --spec <spec> [--to codex,grok,claude] [--risk normal|high] [--model m] [--effort e]  (model and effort: the judge's)";
    if (!values.file === !values.spec) throw new Error(usage);
    if (values.risk !== undefined && values.risk !== "normal" && values.risk !== "high") throw new Error(usage);
    const to = values.to?.split(",").map((h) => h.trim()).filter(Boolean);
    const unknown = to?.filter((h) => !isHarnessId(h)) ?? [];
    if (unknown.length) throw new Error(`lane contest: unknown harness ${unknown.join(", ")}; ${usage}`);
    const judge = { model: values.model, effort: values.effort };
    if (values.spec) {
      const c = await laneContestSpec({ specPath: resolve(values.spec), repo, profile, to: to as HarnessId[] | undefined, judge });
      process.stdout.write(`${c.report}SPEC VERDICT: ${c.go ? "GO" : `stop (${c.why})`}\n`);
      if (!c.go) process.exitCode = 3;
    } else {
      const { report, decided } = await laneContest({ repo, profile, question: readFileSync(resolve(values.file!), "utf8"),
        to: to as HarnessId[] | undefined, risk: values.risk === "high" ? "high" : values.risk === "normal" ? "normal" : undefined, judge });
      process.stdout.write(report);
      if (!decided) process.exitCode = 3;
    }
  } else if (cmd === "plan") {
    if (!values.file) throw new Error("usage: lane plan --file <question.md> [--lead-plan <lead.md>]");
    process.stdout.write(await lanePlan({
      question: readFileSync(resolve(values.file), "utf8"),
      leadPlan: values["lead-plan"] ? readFileSync(resolve(values["lead-plan"]), "utf8") : undefined,
      repo, profile,
    }));
  } else if (cmd === "follow") {
    const id = values.lane ?? positionals[0];
    const text = values.text ?? (values.file ? readFileSync(resolve(values.file), "utf8") : "");
    if (!id || !text.trim()) throw new Error("usage: lane follow --lane <id> --text t | --file f [--model m] [--effort e]");
    process.stdout.write(await laneFollow(id, text, { model: values.model, effort: values.effort }));
  } else if (cmd === "check") {
    const id = values.lane ?? positionals[0];
    if (!id) throw new Error("usage: lane check --lane <id>");
    const checkReport = laneCheck(id);
    process.stdout.write(checkReport);
    if (checkExitCode(checkReport)) process.exitCode = checkExitCode(checkReport);
  } else if (cmd === "status") {
    reapDeadLanes();
    for (const s of listLanes()) {
      const gate = s.gate ? `  ${formatTiming(s.gate)}` : "";
      console.log(`${s.id}  ${s.status}  ${s.branch}  ${fmtUsage(s.usage)}${gate}`);
    }
    for (const o of listOrphans()) {
      console.log(`${o.id}  orphan  ${o.repo ?? (o.worktree ? "repo unknown" : "no worktree")}  ${o.dirty === null ? "status unknown" : `${o.dirty} uncommitted`}`);
    }
  } else if (cmd === "stats") {
    const summaries = summarize(readLedger());
    if (!summaries.length) console.log("no lane recorded yet");
    for (const summary of summaries) {
      console.log(`${summary.to.padEnd(7)} runs ${summary.runs}  integrated ${summary.integrated}  failed ${summary.failed}  tokens ~${summary.meanTokens ?? "-"}  duration ${summary.meanDurationS ?? "-"}s  gate refusals ${summary.gateRefusals}`);
    }
  } else if (cmd === "pre-push") {
    const result = lanePrePush({ repo, base: values.base, verify: values.file });
    process.stdout.write(result.report);
    if (!result.ok) process.exitCode = 1;
  } else if (cmd === "affected") {
    const files = prePushFiles(repo, values.base ?? "HEAD");
    const scoped = gateVerify(values.file ?? "bun test", files, { exists: (p) => existsSync(join(repo, p)) });
    process.stdout.write(scoped.full ? "full\n" : `${scoped.affected.join("\n")}\n`);
  } else if (cmd === "gc") {
    if (values.superseded && !values.drop) throw new Error("usage: lane gc [--cache | --orca | --drop <id> [--superseded]]");
    const refusal = controlRefusal("LANE GC", profile.limits.max_depth);
    if (refusal) {
      process.stdout.write(refusal);
      process.exitCode = 2;
    } else if (values.orca) {
      // Records Orca keeps for lane checkouts git removed; Orca must be quit,
      // so a held state is a quiet skip (the routine runs every tick).
      const r = pruneOrcaGhosts({ apply: true });
      if (r.held) console.log(`kept Orca records: Orca is running (pid ${r.held.join(" ")})`);
      else for (const line of r.lines) console.log(line);
    } else {
      for (const line of laneGc(values.drop, { superseded: values.superseded, cacheOnly: values.cache })) console.log(line);
    }
  } else {
    console.log("usage: lane run|route|auto|batch|integrate|review|ask|contest|plan|follow|check|budget|status|stats|watch|pre-push|affected|gc");
    process.exitCode = 2;
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(`lane: ${e.message}`);
  process.exitCode = 1;
});
