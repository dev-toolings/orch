#!/usr/bin/env bun
// lane: hand one bounded task to another harness, headless, in its own git
// worktree, and print a short report. No model call happens in this process.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classify, parseWorkerOutput, PREAMBLE, REVIEW_PREAMBLE, type Status, type Usage, workerArgv } from "./harness.ts";
import { HARNESSES, type Harness, loadProfile, type Profile, ROOT } from "./profile.ts";
import { runLogged, workerEnv } from "./proc.ts";
import { releaseSlot, reserveSlot } from "./slots.ts";
import { missingFields, parseSpec, type Spec } from "./spec.ts";

export const stateDir = () => process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// Snapshot budget: past this, `git add -A` would copy a dataset into the
// caller's object store and hold a lane slot for minutes.
export const SNAPSHOT_LIMITS = { files: 20_000, bytes: 512 * 1024 * 1024, timeoutMs: 300_000 };

// The caller's status, unaffected by its config (status.showUntrackedFiles,
// diff.ignoreSubmodules) and without the optional index refresh that would
// rewrite the caller's .git/index.
function statusEntries(cwd: string): string[] | null {
  const r = spawnSync("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-z",
    "--untracked-files=all", "--ignore-submodules=none"], { encoding: "utf8", timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").split("\0").filter(Boolean);
}

// Paths named by `status --porcelain=v1 -z` entries: "XY path", and a rename
// or copy is followed by its origin as a bare entry, which is skipped.
export function statusPaths(entries: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const xy = entries[i].slice(0, 2);
    out.push(entries[i].slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return out;
}

type Base = { ok: true; sha: string; snapshotOf?: string } | { ok: false; reason: string };

// The worker starts from the caller's full working tree. A dirty tree (tracked
// edits, staged or not, force-added and untracked files not ignored) becomes a
// snapshot commit over HEAD, built in a copy of the caller's index so its
// tracked set (force-added ignored files included) survives, while the
// caller's index, HEAD, branches, stash and files stay untouched. A clean tree
// uses HEAD as is. Dirty submodules are refused: a superproject snapshot only
// records their commit pointer.
export function workerBase(repo: string, dir: string): Base {
  const head = git(repo, "rev-parse", "HEAD");
  if (!head.ok) return { ok: false, reason: "no HEAD commit to start from" };
  const entries = statusEntries(repo);
  if (entries === null) return { ok: false, reason: "git status failed in the caller's repository" };
  if (!entries.length) return { ok: true, sha: head.out };

  const paths = statusPaths(entries);
  // -z: raw paths, comparable with status paths whatever their characters.
  const staged = spawnSync("git", ["-C", repo, "ls-files", "-s", "-z"], { encoding: "utf8", timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL" });
  if (staged.status !== 0) return { ok: false, reason: "git ls-files failed in the caller's repository" };
  const gitlinks = new Set((staged.stdout ?? "").split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1)));
  const dirtySub = paths.filter((path) => gitlinks.has(path));
  if (dirtySub.length) return { ok: false, reason: `dirty submodule ${dirtySub.join(", ")}: commit inside it first` };

  // Budget over everything the snapshot would copy: tracked edits and untracked files.
  let bytes = 0;
  for (const f of paths) {
    try {
      const st = statSync(join(repo, f));
      if (st.isFile()) bytes += st.size;
    } catch {}
  }
  if (paths.length > SNAPSHOT_LIMITS.files || bytes > SNAPSHOT_LIMITS.bytes) {
    return { ok: false, reason: `changes too large to snapshot (${paths.length} files, ${Math.round(bytes / 1048576)} MB): gitignore them or commit` };
  }

  const index = join(dir, "snapshot.index");
  const callerIndex = resolve(repo, git(repo, "rev-parse", "--git-path", "index").out);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env, timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL" });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  const short = head.out.slice(0, 12);
  try {
    if (existsSync(callerIndex)) copyFileSync(callerIndex, index);
    else if (g("read-tree", "HEAD") === null) return { ok: false, reason: "could not seed the snapshot index" };
    // The copied index keeps assume-unchanged and skip-worktree bits, which make
    // `add -A` skip a present file's edits. Clear them in the copy only; a
    // skip-worktree entry absent from disk (sparse checkout) stays as is.
    const tagged = spawnSync("git", ["-C", repo, "ls-files", "-v", "-z"], { encoding: "utf8", env, timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL" });
    const assumed: string[] = [];
    const skipped: string[] = [];
    for (const e of (tagged.stdout ?? "").split("\0").filter(Boolean)) {
      const tag = e[0];
      const path = e.slice(2);
      if (tag === "S") {
        if (existsSync(join(repo, path))) skipped.push(path);
      } else if (tag !== tag.toUpperCase()) assumed.push(path);
    }
    const clear = (flag: string, list: string[]) =>
      !list.length || spawnSync("git", ["-C", repo, "update-index", flag, "-z", "--stdin"], {
        input: list.join("\0") + "\0", env, timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL",
      }).status === 0;
    if (!clear("--no-assume-unchanged", assumed) || !clear("--no-skip-worktree", skipped)) {
      return { ok: false, reason: "could not clear assume-unchanged or skip-worktree bits in the snapshot index" };
    }
    const tree = g("add", "-A") !== null ? g("write-tree") : null;
    const sha = tree && g("-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit-tree", tree, "-p", head.out,
      "-m", `lane: snapshot of working tree over ${short}`);
    return sha ? { ok: true, sha, snapshotOf: short } : { ok: false, reason: "snapshot failed or timed out" };
  } finally {
    rmSync(index, { force: true });
  }
}

// The worktree is a bare checkout: no installed dependencies, no gitignored
// local files. Without provisioning, a worker cannot run the project's checks
// and VERIFY fails on the missing toolchain, not on the change. The command
// runs here, before the worker, outside any worker sandbox and with network.
// Order: the spec's SETUP (`none` skips), then the repo's local, unversioned
// `.orch/lane-setup` script, then a root bun.lock (`bun install
// --frozen-lockfile`). LANE_REPO and LANE_WORKTREE are set for the script.
// Only the spec's own command goes through a shell; paths never do.
export function setupCommand(spec: Spec, repo: string): { argv: string[]; display: string; source: string } | null {
  const asked = spec.fields.SETUP?.trim();
  if (asked) return asked === "none" ? null : { argv: ["sh", "-c", asked], display: asked, source: "spec SETUP" };
  const local = join(repo, ".orch", "lane-setup");
  if (existsSync(local)) return { argv: ["sh", local], display: ".orch/lane-setup", source: "repo .orch/lane-setup" };
  if (existsSync(join(repo, "bun.lock"))) {
    return { argv: ["bun", "install", "--frozen-lockfile"], display: "bun install --frozen-lockfile", source: "auto, bun.lock" };
  }
  return null;
}

// Grok workers run under orch's profiles (`--sandbox orch-lane|orch-review`).
// Grok resolves a name the user file lacks from the project's
// .grok/sandbox.toml, which the worktree's repository controls; when both
// define it, the user's wins. So the exact profiles orch installs must be in
// the user file: else fail closed.
export function grokProfileInstalled(home = process.env.HOME ?? homedir()): boolean {
  const user = join(home, ".grok", "sandbox.toml");
  if (!existsSync(user)) return false;
  const want = readFileSync(join(ROOT, "catalog", "grok-sandbox.toml"), "utf8");
  return readFileSync(user, "utf8").includes(want.slice(want.indexOf("[profiles.orch-lane]")).trimEnd());
}

// The profiles deny ~/.grok/bin and ~/.grok/downloads, where grok lives and
// which a worker could otherwise overwrite; Grok re-executes itself inside
// its sandbox, so the worker runs from a pinned copy per version under the
// lane state dir, read-only, outside every path a worker may write.
export function pinnedGrok(): string | null {
  const which = spawnSync("sh", ["-c", "command -v grok"], { encoding: "utf8" });
  if (which.status !== 0) return null;
  const real = realpathSync(which.stdout.trim());
  const dir = join(stateDir(), "bin");
  // Keyed by name, size and mtime: a binary replaced under the same name gets a new copy.
  const st = statSync(real);
  const pinned = join(dir, `${basename(real)}-${st.size}-${Math.trunc(st.mtimeMs)}`);
  if (!existsSync(pinned)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${pinned}.tmp-${process.pid}`;
    copyFileSync(real, tmp);
    chmodSync(tmp, 0o555);
    renameSync(tmp, pinned);
  }
  return pinned;
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function orcaUp(): boolean {
  const r = spawnSync("orca", ["terminal", "list", "--json"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 && !/relay socket/i.test(`${r.stdout}${r.stderr}`);
}

export interface LaneState {
  id: string;
  to: Harness;
  repo: string;
  base: string;
  branch: string;
  worktree: string;
  status: Status;
  changed: boolean;
  usage: Usage;
  started: string;
  ended: string;
}

function fmtUsage(u: Usage): string {
  const parts = Object.entries(u).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(", ") : "not reported";
}

export function bound(report: string, maxBytes: number): string {
  const buf = Buffer.from(report);
  if (buf.length <= maxBytes) return report;
  const note = "\n[report truncated, see LOG]\n";
  return buf.subarray(0, maxBytes - Buffer.byteLength(note)).toString("utf8").replace(/�+$/, "") + note;
}

export async function laneRun(opts: {
  to: Harness;
  specPath: string;
  repo: string;
  profile: Profile;
  effort?: string;
  channel?: string;
}): Promise<{ report: string; state?: LaneState }> {
  const p = opts.profile;
  // Depth 1: a worker runs with ORCH_LANE=1 (workerEnv) and may not start a
  // lane of its own, whatever its harness sandbox would allow. This is what
  // stops a worker from delegating in a loop.
  if (process.env.ORCH_LANE === "1") {
    return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: max_depth ${p.limits.max_depth}: a lane worker cannot start a lane\n` };
  }
  const spec = parseSpec(readFileSync(opts.specPath, "utf8"));
  if (opts.to === "grok" && !grokProfileInstalled()) {
    return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: Grok profiles orch-lane/orch-review missing or modified in ~/.grok/sandbox.toml: run orch install\n" };
  }
  const grokBin = opts.to === "grok" ? pinnedGrok() : undefined;
  if (grokBin === null) return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: grok not found on PATH\n" };
  const missing = missingFields(spec);
  if (missing.length) return { report: `LANE REPORT\nSTATUS: refused-by-lane\nREASON: spec missing ${missing.join(", ")}\n` };

  const top = git(opts.repo, "rev-parse", "--show-toplevel");
  if (!top.ok) return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: not a git repository\n" };
  const repo = top.out;

  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${opts.to}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const sd = stateDir();
  const slot = reserveSlot(sd, p.limits.max_concurrent, id);
  if (slot === null) return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${p.limits.max_concurrent} lanes already running\n` };

  const dir = join(sd, "lanes", id);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const wt = join(dir, "wt");
  const branch = `lane/${id}`;
  const started = new Date().toISOString();
  try {
    const b = workerBase(repo, dir);
    if (!b.ok) return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${b.reason}\n` };
    const base = b.sha;
    if (!git(repo, "worktree", "add", "-q", "-b", branch, wt, base).ok) {
      return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: git worktree add failed\n` };
    }
    let setupLine = "SETUP: none";
    const setup = setupCommand(spec, repo);
    if (setup) {
      const t0 = performance.now();
      const setupLog = join(dir, "setup.log");
      let why: string | null = null;
      try {
        const s = await runLogged(setup.argv, {
          cwd: wt, logPath: setupLog, timeoutMs: 900_000, env: workerEnv({ LANE_REPO: repo, LANE_WORKTREE: wt }),
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
        git(repo, "worktree", "remove", "--force", wt);
        git(repo, "branch", "-D", branch);
        // A state record keeps the diagnostics discoverable, and lane gc removes them.
        const failed: LaneState = {
          id, to: opts.to, repo, base, branch, worktree: wt, status: "unavailable", changed: false, usage: {}, started, ended: new Date().toISOString(),
        };
        writeFileSync(join(dir, "state.json"), JSON.stringify(failed, null, 2));
        return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${why}\nSETUP: ${setup.display} (${setup.source})\nLOG: ${setupLog}\n` };
      }
      setupLine = `SETUP: ${setup.display} (${setup.source}, ok in ${Math.round((performance.now() - t0) / 1000)}s)`;
    }
    const promptPath = join(dir, "prompt.txt");
    writeFileSync(promptPath, PREAMBLE + spec.raw);
    const lastPath = join(dir, "last.txt");
    const logPath = join(dir, "worker.log");
    const choice = p.lanes[opts.to];
    const call = workerArgv(opts.to, choice, {
      cwd: wt, promptPath, effort: opts.effort ?? spec.reasoning, readOnly: false, lastMessagePath: lastPath, bin: grokBin,
    });
    const channel = opts.channel === "orca" || (opts.channel !== "headless" && orcaUp())
      ? "headless (orca relay up; card launch not implemented yet)"
      : "headless";

    const run = await runLogged(call.argv, {
      cwd: wt, logPath, stdinPath: call.stdin ? promptPath : undefined,
      timeoutMs: p.limits.timeout_seconds * 1000, env: workerEnv(),
    });
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const last = existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "";

    // Same forced view as the snapshot: the repo's status config is shared by
    // the worktree and must not hide what the worker created.
    const after = statusEntries(wt);
    const dirty = (after ?? []).join("\n");
    const commits = git(wt, "rev-list", `${base}..HEAD`).out;
    const changed = Boolean(dirty || commits);

    let verifyOk: boolean | null = null;
    let verifyOut = "not run";
    if (spec.verify && !run.timedOut) {
      const verifyLog = join(dir, "verify.log");
      const v = await runLogged(["sh", "-c", spec.verify], {
        cwd: wt, logPath: verifyLog, timeoutMs: 600_000, env: workerEnv(),
      });
      verifyOk = v.code === 0 && !v.timedOut;
      verifyOut = `exit ${v.code}${v.timedOut ? " (timeout)" : ""}\n${tail(readFileSync(verifyLog, "utf8"), 12)}`;
    }

    // Without a reliable status the change cannot be measured: never report it as noop.
    const status = after === null ? "failed" : classify({ ...run, changed, verifyOk, log });
    if (changed && dirty) {
      git(wt, "add", "-A");
      git(wt, "-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit", "-q", "-m",
        `lane ${id}: ${(spec.fields.OBJECTIVE ?? "").split("\n")[0].slice(0, 60)}`);
    }
    const stat = changed ? tail(git(wt, "diff", "--stat", base, "HEAD").out, 12) : "none";
    const { message, usage } = parseWorkerOutput(opts.to, log, last);
    const model = choice.model ?? "inherited";
    const effort = opts.effort ?? spec.reasoning ?? choice.effort ?? "default";

    const state: LaneState = {
      id, to: opts.to, repo, base, branch, worktree: wt, status, changed, usage, started, ended: new Date().toISOString(),
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));

    const report = [
      "LANE REPORT",
      `LANE: ${opts.to} · ${model} · effort ${effort} · ${channel}`,
      `STATUS: ${status}`,
      after === null ? "REASON: git status failed in the worktree after the worker" : "",
      `ID: ${id}`,
      `BASE: ${base} (${b.snapshotOf ? `snapshot of dirty tree over HEAD ${b.snapshotOf}` : "HEAD"})`,
      `BRANCH: ${branch}`,
      setupLine,
      `CHANGES:\n${stat}`,
      `VERIFY: ${verifyOut}`,
      `WORKER SAID: ${message.replace(/\s+/g, " ").trim().slice(0, 400) || "(nothing)"}`,
      `USAGE: ${fmtUsage(usage)}`,
      changed && status === "complete"
        ? b.snapshotOf
          ? `INTEGRATE: git diff --binary --no-ext-diff --no-textconv ${base} ${branch} | git apply && lane gc --drop ${id}`
          : `INTEGRATE: git merge --squash ${branch}  then: lane gc`
        : "",
      `LOG: ${logPath}`,
    ].filter(Boolean).join("\n") + "\n";
    return { report: bound(report, p.limits.report_max_bytes), state };
  } finally {
    releaseSlot(sd, slot);
  }
}

export async function laneReview(opts: { from: Harness; to?: Harness; base: string; goal: string; repo: string; profile: Profile }) {
  const rc = opts.profile.review[opts.from];
  const to = opts.to ?? rc.to;
  if (to === "grok" && !grokProfileInstalled()) return "LANE REVIEW\nSTATUS: unavailable\nREASON: Grok profiles orch-lane/orch-review missing or modified in ~/.grok/sandbox.toml: run orch install\n";
  const grokBin = to === "grok" ? pinnedGrok() : undefined;
  if (grokBin === null) return "LANE REVIEW\nSTATUS: unavailable\nREASON: grok not found on PATH\n";
  const dir = join(stateDir(), "reviews", `${Date.now()}-${to}`);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const promptPath = join(dir, "prompt.txt");
  writeFileSync(promptPath, `${REVIEW_PREAMBLE}Review the changes from ${opts.base} to the working tree of this repository (git diff ${opts.base}) against this goal:
${opts.goal}

Check that the change does what was asked, nothing missing, nothing unasked smuggled in, and name any risk.
Answer under 300 words: first line "VERDICT: ship | fix-first | rethink", then numbered findings with file and fix.
`);
  const lastPath = join(dir, "last.txt");
  const logPath = join(dir, "worker.log");
  const call = workerArgv(to, rc, { cwd: opts.repo, promptPath, readOnly: true, lastMessagePath: lastPath, bin: grokBin });
  const run = await runLogged(call.argv, {
    cwd: opts.repo, logPath, stdinPath: call.stdin ? promptPath : undefined,
    timeoutMs: opts.profile.limits.timeout_seconds * 1000, env: workerEnv(),
  });
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const { message, usage } = parseWorkerOutput(to, log, existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "");
  const head = `REVIEW REPORT\nREVIEWER: ${to} · ${rc.model ?? "inherited"}\nEXIT: ${run.code}${run.timedOut ? " (timeout)" : ""}\nUSAGE: ${fmtUsage(usage)}\nLOG: ${logPath}\n`;
  return bound(`${head}${message.trim()}\n`, opts.profile.limits.report_max_bytes);
}

export function listLanes(): LaneState[] {
  const root = join(stateDir(), "lanes");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((id) => {
    const f = join(root, id, "state.json");
    return existsSync(f) ? [JSON.parse(readFileSync(f, "utf8")) as LaneState] : [];
  });
}

// Removes only what a lane created, and only once nothing is lost: the branch
// is merged into the repo HEAD, or the lane produced no change.
export function laneGc(drop?: string): string[] {
  const out: string[] = [];
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
  for (const s of listLanes()) {
    const merged = git(s.repo, "merge-base", "--is-ancestor", s.branch, "HEAD").ok;
    const squashed = s.changed && git(s.repo, "diff", "--quiet", "HEAD", s.branch, "--").ok;
    if (!(merged || squashed || !s.changed || s.id === drop)) {
      out.push(`kept ${s.id} (${s.status}, not integrated)`);
      continue;
    }
    git(s.repo, "worktree", "remove", "--force", s.worktree);
    git(s.repo, "branch", "-D", s.branch);
    rmSync(join(stateDir(), "lanes", s.id), { recursive: true, force: true });
    out.push(`removed ${s.id}`);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      to: { type: "string" }, spec: { type: "string" }, effort: { type: "string" }, profile: { type: "string" },
      repo: { type: "string" }, channel: { type: "string" }, base: { type: "string" }, goal: { type: "string" },
      from: { type: "string" }, drop: { type: "string" },
    },
  });
  const profile = loadProfile(values.profile);
  const repo = resolve(values.repo ?? process.cwd());
  const isHarness = (h?: string): h is Harness => !!h && (HARNESSES as string[]).includes(h);
  if (cmd === "run") {
    if (!isHarness(values.to) || !values.spec) throw new Error("usage: lane run --to codex|grok|claude --spec <file>");
    const { report } = await laneRun({ to: values.to, specPath: values.spec, repo, profile, effort: values.effort, channel: values.channel });
    process.stdout.write(report);
  } else if (cmd === "review") {
    const from = isHarness(values.from) ? values.from : "claude";
    if (!values.base || !values.goal) throw new Error('usage: lane review --base <ref> --goal "<goal>" [--from h] [--to h]');
    process.stdout.write(await laneReview({ from, to: isHarness(values.to) ? values.to : undefined, base: values.base, goal: values.goal, repo, profile }));
  } else if (cmd === "status") {
    for (const s of listLanes()) console.log(`${s.id}  ${s.status}  ${s.branch}  ${fmtUsage(s.usage)}`);
  } else if (cmd === "gc") {
    for (const line of laneGc(values.drop)) console.log(line);
  } else {
    console.log("usage: lane run|review|status|gc");
    process.exitCode = 2;
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(`lane: ${e.message}`);
  process.exitCode = 1;
});
