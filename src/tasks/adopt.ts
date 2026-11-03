import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { git } from "../core/git.ts";
import { stateDir } from "../core/paths.ts";
import { projectKey } from "../core/project.ts";
import { numstat, saveLane, setupCommand, type LaneState } from "../lane.ts";
import { checkLane, verifiedCommit } from "../lanes/check.ts";
import { appendLedger } from "../lanes/ledger.ts";
import { neutralizeWorktreeHooks, runFreshSetup } from "../lanes/protect.ts";
import { inScope, specFeatures } from "../lanes/route.ts";
import type { Spec } from "../lanes/spec.ts";
import { statusEntries, testRepoRefusal } from "../lanes/worktree.ts";

export interface AdoptOptions {
  repo: string;
  worktree?: string;
  branch?: string;
  files: string;
  verify: string;
  goal?: string;
  risk?: "low" | "normal" | "risky";
  takeWorktree?: boolean;
  baseBranch?: string;
}

function requiredGit(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (!result.ok) throw new Error(`git ${args[0]}: ${result.err || result.out}`);
  return result.out;
}

// The branch the work started from: --base-branch, else the named creation
// ref git recorded. Never guessed from whichever branch the caller has checked
// out now: a switch in between would target the wrong branch (Codex review).
function startingBranch(repo: string, source: string, explicit?: string): string {
  const created = git(repo, "reflog", "show", "--format=%gs", `refs/heads/${source}`).out
    .split("\n").findLast((line) => line.startsWith("branch: Created from "))?.slice("branch: Created from ".length);
  for (const candidate of [explicit, created?.replace(/^refs\/heads\//, "")]) {
    if (!candidate || candidate === source || candidate === "HEAD") continue;
    if (git(repo, "show-ref", "--verify", `refs/heads/${candidate}`).ok) return candidate;
    if (candidate === explicit) throw new Error(`--base-branch ${explicit} is not a local branch`);
  }
  throw new Error(`cannot tell which branch ${source} started from; pass --base-branch`);
}

// The checkout a lane keeps for review, delivery and gc: never a disposable
// native one (Claude Code removes .claude/worktrees/*), but the main worktree.
function durableRepo(repo: string, native?: string): string {
  if (repo !== native && !/\/\.claude\/worktrees\//.test(`${repo}/`)) return repo;
  const main = git(repo, "worktree", "list", "--porcelain").out.split("\n")
    .find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  return main && existsSync(main) ? realpathSync(main) : repo;
}

export async function adoptNative(opts: AdoptOptions): Promise<{ state: LaneState; report: string }> {
  if (Boolean(opts.worktree) === Boolean(opts.branch)) throw new Error("provide exactly one of --worktree or --branch");
  if (!opts.files.trim() || !opts.verify.trim()) throw new Error("--files and --verify are required");
  if (opts.risk && !["low", "normal", "risky"].includes(opts.risk)) throw new Error("--risk must be low, normal or risky");
  if (opts.takeWorktree && !opts.worktree) throw new Error("--take-worktree requires --worktree");
  const native = opts.worktree ? realpathSync(resolve(opts.worktree)) : undefined;
  const repo = durableRepo(realpathSync(requiredGit(resolve(opts.repo), "rev-parse", "--show-toplevel")), native);
  const refusal = testRepoRefusal(repo);
  if (refusal) throw new Error(refusal);
  if (native) {
    if (realpathSync(requiredGit(native, "rev-parse", "--show-toplevel")) !== native) throw new Error("--worktree must name a checkout root");
    const common = (cwd: string) => realpathSync(requiredGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (common(native) !== common(repo)) throw new Error("worktree belongs to another repository");
    if (opts.takeWorktree && (native === repo || !requiredGit(native, "rev-parse", "--git-dir").includes("worktrees/"))) {
      throw new Error("--take-worktree requires a separate linked worktree");
    }
  }
  const source = native ? requiredGit(native, "branch", "--show-current") : opts.branch!;
  if (!source || !git(repo, "show-ref", "--verify", `refs/heads/${source}`).ok) throw new Error("adoption requires a local branch, not detached HEAD");
  const baseBranch = startingBranch(repo, source, opts.baseBranch);
  const objective = opts.goal?.trim() || `Adopt native work from ${source}`;
  const fields = {
    OBJECTIVE: objective, FILES: opts.files, VERIFY: opts.verify, KIND: opts.risk === "risky" ? "risky" : "normal",
    RISK: opts.risk === "risky" ? "declared" : "", INTERFACES: "existing native work",
    CONSTRAINTS: "Adopt the existing commit through the lane gate", ACCEPT: "VERIFY passes; delivery passes the lane gate",
  };
  const spec: Spec = { fields, verify: opts.verify, raw: Object.entries(fields).map(([k, v]) => `${k}: ${v.replace(/\n/g, "\n ")}`).join("\n") + "\n" };
  const features = specFeatures(spec);
  if (!features.files.length) throw new Error("--files must contain lane FILES paths or globs");
  if (native) {
    const dirty = statusEntries(native);
    if (dirty === null) throw new Error("cannot inspect native worktree");
    if (dirty.length) {
      requiredGit(native, "add", "-A");
      requiredGit(native, "-c", "user.name=agent-local", "-c", "user.email=agent-local@localhost",
        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `adopt: ${objective.split("\n")[0].slice(0, 100)}`);
    }
    if (statusEntries(native)?.length !== 0) throw new Error("native worktree is still dirty (commit submodule changes first)");
  }
  const sha = requiredGit(repo, "rev-parse", `refs/heads/${source}^{commit}`);
  const base = requiredGit(repo, "merge-base", sha, `refs/heads/${baseBranch}`);
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-adopt-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const sd = stateDir(), dir = join(sd, "lanes", id), branch = `lane/${id}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wt = opts.takeWorktree ? native! : join(dir, "wt");
  if (opts.takeWorktree) requiredGit(wt, "checkout", "-q", "-b", branch, sha);
  else requiredGit(repo, "worktree", "add", "-q", "-b", branch, wt, sha);
  neutralizeWorktreeHooks(wt, join(dir, "no-hooks"));
  writeFileSync(join(dir, "spec.md"), spec.raw);
  const diff = numstat(wt, base);
  const setup = setupCommand(spec, repo);
  const state: LaneState = {
    id, to: "claude", repo, base, baseBranch, branch, worktree: wt, status: "running",
    changed: diff.files.length > 0, usage: {}, started: new Date().toISOString(), ended: "", pid: process.pid,
    snapshot: true, session: process.env.ORCH_SESSION, declared: features.files, risk: features.risk,
    touched: diff.files, objective, verify: opts.verify, setupArgv: setup?.argv ?? [], verifyOk: null,
  };
  saveLane(dir, state);
  let output: string;
  try {
    // SETUP and VERIFY run in a child process group recorded as workerPgid
    // before the wait: if adoption dies, reapDeadLanes kills that group before
    // it removes the checkout, as for a lane started by laneRun.
    const resultPath = join(dir, "adopt-verify.json");
    const child = spawn(process.execPath, ["--no-env-file", import.meta.path, "verify-child", dir, sha], { detached: true, stdio: "ignore", env: process.env });
    if (!child.pid) throw new Error("adoption VERIFY process did not start");
    state.workerPgid = child.pid;
    saveLane(dir, state);
    await new Promise<void>((done) => child.once("exit", () => done()));
    if (!existsSync(resultPath)) throw new Error("adoption VERIFY ended without a result");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { verifyOk: boolean; output: string; verifiedSha?: string };
    rmSync(resultPath, { force: true });
    state.verifyOk = result.verifyOk;
    output = result.output;
    if (result.verifiedSha) state.verifiedSha = result.verifiedSha;
  } catch (error) { state.verifyOk = false; output = String(error); }
  delete state.workerPgid;
  state.status = state.verifyOk && state.verifiedSha ? "complete" : "failed";
  state.ended = new Date().toISOString();
  if (state.status === "failed") state.reason = state.verifyOk ? "VERIFY changed the tracked tree or HEAD" : output;
  saveLane(dir, state);
  writeFileSync(join(dir, "verify.log"), output + "\n");
  appendLedger({
    kind: "run", id, at: state.ended, repo: projectKey(repo), to: "claude", model: "native", effort: "default",
    channel: "native", status: state.status, changed: state.changed, verifyOk: state.verifyOk ?? null,
    verifiedSha: state.verifiedSha, features, diff, outOfScope: diff.files.filter((f) => !inScope(f, features.files)),
    durationS: Math.round((Date.parse(state.ended) - Date.parse(state.started)) / 1000), usage: {},
  }, sd);
  const report = ["TASK ADOPT", `ID: ${id}`, `STATUS: ${state.status}`, `VERIFY: ${state.verifyOk ? "ok" : "fail"}`,
    `SHA: ${state.verifiedSha ?? "unverified"}`, ...(state.reason ? [`REASON: ${state.reason}`] : []),
    ...(state.risk?.length ? [`NEXT: lane review --lane ${id} --profile kiba`] : []),
    `NEXT: lane integrate ${id} --branch <b> --message-file <f>`, ""].join("\n");
  return { state, report };
}

// Child side of adoption: the exact lane check path (allowlisted environment,
// reach check, VERIFY_TIMEOUT_MS), no browser or harness launched.
function verifyChild(dir: string, sha: string): void {
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as LaneState;
  let result: { verifyOk: boolean; output: string; verifiedSha?: string };
  try {
    const setupError = runFreshSetup(state.setupArgv ?? [], state.worktree, state.repo);
    if (setupError) result = { verifyOk: false, output: setupError };
    else {
      const checked = checkLane(state, { browser: null });
      result = { verifyOk: checked.verifyOk === true, output: checked.refused ?? checked.verifyOut,
        ...(checked.verifyOk ? { verifiedSha: verifiedCommit(state.worktree, sha) } : {}) };
    }
  } catch (error) { result = { verifyOk: false, output: String(error) }; }
  writeFileSync(join(dir, "adopt-verify.json"), JSON.stringify(result));
}

export async function taskCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "adopt") throw new Error("usage: orch task adopt (--worktree <path> | --branch <name>) --files <glob,...> --verify <cmd> [--repo <path>] [--goal <text>] [--risk low|normal|risky] [--base-branch <b>] [--take-worktree]");
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, branch: { type: "string" }, files: { type: "string" }, verify: { type: "string" },
    repo: { type: "string" }, goal: { type: "string" }, risk: { type: "string" }, "take-worktree": { type: "boolean" },
    "base-branch": { type: "string" },
  } });
  const { state, report } = await adoptNative({ ...values, repo: values.repo ?? process.cwd(), files: values.files ?? "",
    verify: values.verify ?? "", risk: values.risk as AdoptOptions["risk"], takeWorktree: values["take-worktree"],
    baseBranch: values["base-branch"] });
  process.stdout.write(report);
  if (state.status !== "complete") process.exitCode = 2;
}

if (import.meta.main && process.argv[2] === "verify-child") verifyChild(process.argv[3], process.argv[4]);
