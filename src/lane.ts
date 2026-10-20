#!/usr/bin/env bun
// lane: hand one bounded task to another harness in its own git worktree,
// optionally observed in Orca. No model call happens in this process.
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

function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
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

  const index = join(dir, "snapshot.index");
  const callerIndex = resolve(repo, git(repo, "rev-parse", "--git-path", "index").out);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
  const run = (args: string[], input?: string) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env, input, timeout: SNAPSHOT_LIMITS.timeoutMs, killSignal: "SIGKILL" });
  const g = (...args: string[]) => {
    const r = run(args);
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  const short = head.out.slice(0, 12);
  try {
    if (existsSync(callerIndex)) copyFileSync(callerIndex, index);
    else if (g("read-tree", "HEAD") === null) return { ok: false, reason: "could not seed the snapshot index" };

    // `git status` never shows edits to files marked assume-unchanged or
    // skip-worktree, and the copied index keeps those bits, which make `add -A`
    // skip them. Clear them in the copy only, then list such edits so they go
    // through the same submodule and budget checks as visible ones. `ls-files
    // -v` tags skip-worktree "S" and assume-unchanged in lowercase, so "s" is
    // both. A skip-worktree entry absent from disk (sparse checkout) stays.
    const tagged = run(["ls-files", "-v", "-z"]);
    if (tagged.status !== 0) return { ok: false, reason: "git ls-files failed in the caller's repository" };
    const hidden = new Set<string>();
    const assumed: string[] = [];
    const skipped: string[] = [];
    for (const e of (tagged.stdout ?? "").split("\0").filter(Boolean)) {
      const tag = e[0];
      const path = e.slice(2);
      const skip = tag.toUpperCase() === "S" && existsSync(join(repo, path));
      const assume = tag !== tag.toUpperCase();
      if (skip) skipped.push(path);
      if (assume) assumed.push(path);
      if (skip || assume) hidden.add(path);
    }
    const clear = (flag: string, list: string[]) =>
      !list.length || run(["update-index", flag, "-z", "--stdin"], list.join("\0") + "\0").status === 0;
    if (!clear("--no-assume-unchanged", assumed) || !clear("--no-skip-worktree", skipped)) {
      return { ok: false, reason: "could not clear assume-unchanged or skip-worktree bits in the snapshot index" };
    }
    let hiddenEdits: string[] = [];
    if (hidden.size) {
      run(["update-index", "-q", "--refresh"]); // stale stat data alone is not an edit
      const changed = run(["diff-files", "--name-only", "-z"]);
      if (changed.status !== 0) return { ok: false, reason: "git diff-files failed in the caller's repository" };
      hiddenEdits = (changed.stdout ?? "").split("\0").filter((path) => path && hidden.has(path));
    }
    const paths = [...new Set([...statusPaths(entries), ...hiddenEdits])];
    if (!paths.length) return { ok: true, sha: head.out };

    // -z: raw paths, comparable with status paths whatever their characters.
    const staged = run(["ls-files", "-s", "-z"]);
    if (staged.status !== 0) return { ok: false, reason: "git ls-files failed in the caller's repository" };
    const gitlinks = new Set((staged.stdout ?? "").split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1)));
    const dirtySub = paths.filter((path) => gitlinks.has(path));
    if (dirtySub.length) return { ok: false, reason: `dirty submodule ${dirtySub.join(", ")}: commit inside it first` };

    // Budget over everything the snapshot would copy: tracked edits, hidden
    // edits and untracked files.
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

function orcaCall(repo: string, args: string[], timeout = 5000): any {
  if (["ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE", "ORCA_REMOTE_PAIRING"].some(k => process.env[k]?.trim())) {
    throw new Error("Orca remote routing is unsupported for local lanes");
  }
  const r = spawnSync("orca", [...args, "--json"], { cwd: repo, encoding: "utf8", timeout, killSignal: "SIGKILL" });
  let response: any;
  try { response = JSON.parse(r.stdout ?? ""); } catch {}
  if (r.status !== 0 || response?.ok !== true) {
    throw Object.assign(new Error(`Orca ${args.slice(0, 2).join(" ")}: ${response?.error?.code ?? r.error?.message ?? "unavailable"}`), { code: response?.error?.code });
  }
  return response.result;
}

function orcaParent(repo: string): { id: string; repoId: string } | null {
  try {
    const w = orcaCall(repo, ["worktree", "current"]).worktree;
    // The observer reads local lane files. Never route it to another host,
    // nor silently parent it to the terminal's unrelated current workspace.
    return w?.hostId === "local" && w.path === repo && typeof w.id === "string" && typeof w.repoId === "string" ? w : null;
  } catch { return null; }
}

function saveLane(dir: string, state: LaneState): void {
  const tmp = join(dir, "state.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, "state.json"));
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// This PTY is a status observer, never the worker. Orca 1.4.229's OSC 9999
// ingress supplies sidebar agent rows even for headless Claude, which Orca's
// process detector deliberately excludes. Keep the worker under runLogged:
// no Orca environment, launch flags, hooks or PTY lifetime can weaken it.
async function observeInOrca(dir: string, state: LaneState): Promise<string | undefined> {
  const script = join(dir, "observe.mjs");
  writeFileSync(script, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const dir = ${JSON.stringify(dir)};
const clean = s => String(s).replace(/[\\x00-\\x1f\\x7f]/g, ' ').slice(0, 500);
let previous = '', last = 0;
while (existsSync(dir + '/state.json')) {
  const s = JSON.parse(readFileSync(dir + '/state.json', 'utf8'));
  let running = s.status === 'running';
  if (running) { try { process.kill(s.pid, 0); } catch { running = false; } }
  const label = running ? 'running' : s.status === 'running' ? 'interrupted' : s.status;
  if (label !== previous || Date.now() - last > 10000) {
    const payload = { state: running ? 'working' : 'done', agentType: s.to,
      prompt: 'lane ' + s.id, lastAssistantMessage: running ? undefined : clean(s.reason || label) };
    process.stdout.write('\\x1b]0;lane ' + label + ' - ' + s.to + '\\x07');
    process.stdout.write('\\x1b]9999;' + JSON.stringify(payload) + '\\x07');
    if (label !== previous) console.log('LANE ' + s.id + ': ' + label);
    previous = label; last = Date.now();
  }
  writeFileSync(dir + '/observer.ready', 'ready');
  if (!running) {
    if (existsSync(dir + '/report.txt')) console.log(readFileSync(dir + '/report.txt', 'utf8').replace(/[\\x00-\\x08\\x0b-\\x1f\\x7f]/g, ''));
    break;
  }
  await new Promise(r => setTimeout(r, 250));
}
`);
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  // The PTY's login shell may inherit Orca's environment. Clear it before
  // starting even the observer; the actual worker uses workerEnv separately.
  const command = ["/usr/bin/env", "-i", ...Object.entries(workerEnv()).map(([k, v]) => `${k}=${v}`), process.execPath, script].map(quote).join(" ");
  const t = orcaCall(state.repo, ["terminal", "create", "--worktree", state.orca!.selector, "--command", command], 30_000).terminal;
  if (typeof t?.handle !== "string") throw new Error("Orca observer returned no terminal handle");
  state.orca!.terminal = t.handle;
  saveLane(dir, state);
  const until = Date.now() + 5000;
  while (!existsSync(join(dir, "observer.ready")) && Date.now() < until) await Bun.sleep(50);
  if (!existsSync(join(dir, "observer.ready"))) throw new Error("Orca observer did not acknowledge startup");
  return t.handle;
}

function removeOrca(state: LaneState): void {
  const selector = state.orca!.selector;
  try {
    const w = orcaCall(state.repo, ["worktree", "show", "--worktree", selector]).worktree;
    // Recover a creation whose reply was lost before we recorded its path
    // or renamed its branch. Persist before removal can become asynchronous.
    if (selector.startsWith("name:")) {
      if (typeof w?.path !== "string" || typeof w?.branch !== "string") throw new Error("Orca cleanup identity unavailable");
      state.worktree = w.path;
      state.branch = w.branch.replace(/^refs\/heads\//, "");
      saveLane(join(stateDir(), "lanes", state.id), state);
    }
  }
  catch (e) {
    if (["worktree_not_found", "selector_not_found"].includes((e as { code?: string }).code ?? "") && !existsSync(state.worktree)) return;
    throw e;
  }
  orcaCall(state.repo, ["terminal", "close", "--worktree", selector, "--all"], 30_000);
  orcaCall(state.repo, ["worktree", "rm", "--worktree", selector, "--force"], 30_000);
  // Orca can acknowledge asynchronous removal. Retain the ledger until the
  // checkout is actually gone, so a later gc can finish branch cleanup.
  if (existsSync(state.worktree)) throw new Error("Orca worktree removal pending; run lane gc again");
}

export interface LaneState {
  id: string;
  to: Harness;
  repo: string;
  base: string;
  branch: string;
  worktree: string;
  status: Status | "running";
  changed: boolean;
  reason?: string;
  usage: Usage;
  started: string;
  ended: string;
  channel?: "headless" | "orca";
  pid?: number;
  orca?: { selector: string; terminal?: string };
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

function depthRefusal(label: "LANE REPORT" | "LANE REVIEW", maxDepth: number): string | null {
  return process.env.ORCH_LANE === "1"
    ? `${label}\nSTATUS: refused-by-lane\nREASON: max_depth ${maxDepth}: a lane worker cannot start a lane\n`
    : null;
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
  const depth = depthRefusal("LANE REPORT", p.limits.max_depth);
  if (depth) return { report: depth };
  if (opts.channel !== undefined && !["headless", "orca"].includes(opts.channel)) {
    return { report: "LANE REPORT\nSTATUS: refused-by-lane\nREASON: channel must be headless or orca\n" };
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
  let wt = join(dir, "wt");
  const branch = `lane/${id}`;
  const started = new Date().toISOString();
  let live: LaneState | undefined;
  let channel = "headless";
  let channelReason = "";
  try {
    const b = workerBase(repo, dir);
    if (!b.ok) return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: ${b.reason}\n` };
    const base = b.sha;
    live = { id, to: opts.to, repo, base, branch, worktree: wt, status: "running", changed: true,
      usage: {}, started, ended: "", pid: process.pid, channel: "headless" };
    const parent = opts.channel === "headless" ? null : orcaParent(repo);
    if (parent) {
      // Persist ownership before the mutation: a lost create response must
      // leave a selector gc can recover, never an untracked Orca resource.
      live.orca = { selector: `name:lane-${id}` };
      saveLane(dir, live);
      let created: any;
      try {
        created = orcaCall(repo, ["worktree", "create", "--repo", `id:${parent.repoId}`,
          "--name", `lane-${id}`, "--parent-worktree", `id:${parent.id}`, "--base-branch", base, "--setup", "skip"], 30_000).worktree;
      } catch (e) {
        // A response can be lost after creation. Adopt only this unique lane,
        // never repeat the mutation or launch a second worker.
        try { created = orcaCall(repo, ["worktree", "show", "--worktree", live.orca.selector]).worktree; }
        catch { throw e; }
      }
      if (!created?.path || !created?.id || !existsSync(created.path)) throw new Error("Orca returned no local worktree");
      wt = created.path;
      live.worktree = wt;
      live.orca.selector = `id:${created.id}`;
      // Track the actual branch even if the rename fails, for safe gc.
      live.branch = git(wt, "branch", "--show-current").out;
      saveLane(dir, live);
      if (!git(wt, "branch", "-m", branch).ok) throw new Error("could not name the Orca lane branch");
      live.branch = branch;
      saveLane(dir, live);
      try {
        // --setup skip also suppresses default-tab commands. All terminals
        // in this just-created workspace are ours and can be closed safely.
        orcaCall(repo, ["terminal", "close", "--worktree", live.orca.selector, "--all"], 30_000);
        await observeInOrca(dir, live);
        channel = live.channel = "orca";
      } catch (e) {
        channelReason = `${(e as Error).message}; worker remains headless`;
      }
    } else if (!git(repo, "worktree", "add", "-q", "-b", branch, wt, base).ok) {
      return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: git worktree add failed\n` };
    }
    saveLane(dir, live);
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
        if (live.orca) removeOrca(live);
        else git(repo, "worktree", "remove", "--force", wt);
        git(repo, "branch", "-D", branch);
        // A state record keeps the diagnostics discoverable, and lane gc removes them.
        const failed: LaneState = {
          id, to: opts.to, repo, base, branch, worktree: wt, status: "unavailable", changed: false, usage: {}, started, ended: new Date().toISOString(),
          channel: live.channel,
        };
        saveLane(dir, failed);
        return { report: bound(`LANE REPORT\nSTATUS: unavailable\nREASON: ${why}\nSETUP: ${setup.display} (${setup.source})\nLOG: ${setupLog}\n`, p.limits.report_max_bytes) };
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
    let status: Status = after === null ? "failed" : classify({ ...run, changed, verifyOk, log });
    let reason = after === null ? "git status failed in the worktree after the worker" : undefined;
    if (changed && dirty) {
      const added = git(wt, "add", "-A");
      if (!added.ok) {
        status = "failed";
        reason = `git add failed:\n${tail(added.err || added.out, 12) || "no error output"}`;
      } else {
        const committed = git(wt, "-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit", "-q", "-m",
          `lane ${id}: ${(spec.fields.OBJECTIVE ?? "").split("\n")[0].slice(0, 60)}`);
        if (!committed.ok) {
          status = "failed";
          reason = `git commit failed:\n${tail(committed.err || committed.out, 12) || "no error output"}`;
        }
      }
    }
    const stat = changed ? tail(git(wt, "diff", "--stat", base, "HEAD").out, 12) : "none";
    const { message, usage } = parseWorkerOutput(opts.to, log, last);
    const model = choice.model ?? "inherited";
    const effort = opts.effort ?? spec.reasoning ?? choice.effort ?? "default";

    const state: LaneState = {
      id, to: opts.to, repo, base, branch, worktree: wt, status, changed, usage, started, ended: new Date().toISOString(),
      reason, channel: live.channel, orca: live.orca,
    };

    const report = [
      "LANE REPORT",
      `LANE: ${opts.to} · ${model} · effort ${effort} · ${channel}`,
      channelReason ? `CHANNEL: ${channelReason}` : "",
      `STATUS: ${status}`,
      reason ? `REASON: ${reason}` : "",
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
    const bounded = bound(report, p.limits.report_max_bytes);
    writeFileSync(join(dir, "report.txt"), bounded);
    saveLane(dir, state);
    return { report: bounded, state };
  } catch (e) {
    const reason = (e as Error).message;
    if (live) saveLane(dir, { ...live, status: "unavailable", reason, ended: new Date().toISOString() });
    return { report: bound(`LANE REPORT\nSTATUS: unavailable\nREASON: ${reason}\nID: ${id}\nLOG: ${dir}\n`, p.limits.report_max_bytes) };
  } finally {
    releaseSlot(sd, slot);
  }
}

export async function laneReview(opts: { from: Harness; to?: Harness; base: string; goal: string; repo: string; profile: Profile; risk?: "normal" | "high" }) {
  const depth = depthRefusal("LANE REVIEW", opts.profile.limits.max_depth);
  if (depth) return depth;
  const risk = opts.risk ?? "normal";
  const fromChoice = opts.profile.review[opts.from];
  const to = opts.to ?? fromChoice.to;
  // A model id belongs to one harness: with --to, take the choice of a review
  // entry aimed at that harness, else let the harness pick its own model.
  const review = Object.values(opts.profile.review);
  const entry = to === fromChoice.to ? fromChoice : review.find((r) => r.to === to) ?? { to };
  const { high, ...normal } = entry;
  const rc = risk === "high" && high ? { ...normal, ...high } : normal;
  if (to === "grok" && !grokProfileInstalled()) return "LANE REVIEW\nSTATUS: unavailable\nREASON: Grok profiles orch-lane/orch-review missing or modified in ~/.grok/sandbox.toml: run orch install\n";
  const grokBin = to === "grok" ? pinnedGrok() : undefined;
  if (grokBin === null) return "LANE REVIEW\nSTATUS: unavailable\nREASON: grok not found on PATH\n";
  const sd = stateDir();
  const id = `${Date.now()}-${to}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const slot = reserveSlot(sd, opts.profile.limits.max_concurrent, id);
  if (slot === null) return `LANE REVIEW\nSTATUS: unavailable\nREASON: ${opts.profile.limits.max_concurrent} lanes already running\n`;
  try {
    const dir = join(sd, "reviews", id);
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
    const head = `REVIEW REPORT\nREVIEWER: ${to} · ${rc.model ?? "inherited"} · effort ${rc.effort ?? "default"} · risk ${risk}\nEXIT: ${run.code}${run.timedOut ? " (timeout)" : ""}\nUSAGE: ${fmtUsage(usage)}\nLOG: ${logPath}\n`;
    return bound(`${head}${message.trim()}\n`, opts.profile.limits.report_max_bytes);
  } finally {
    releaseSlot(sd, slot);
  }
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
    if (s.status === "running" && alive(s.pid)) {
      out.push(`kept ${s.id} (running)`);
      continue;
    }
    // Config-independent status (untracked files and submodules always
    // shown). A worktree that cannot be inspected is kept too: only an
    // explicit --drop forces the removal of unknown or uncommitted work.
    if (s.id !== drop && existsSync(s.worktree)) {
      const st = statusEntries(s.worktree);
      if (st === null || st.length) {
        out.push(`kept ${s.id} (${st === null ? "worktree status failed" : "dirty worktree"})`);
        continue;
      }
    }
    const merged = git(s.repo, "merge-base", "--is-ancestor", s.branch, "HEAD").ok;
    const squashed = s.changed && git(s.repo, "diff", "--quiet", "HEAD", s.branch, "--").ok;
    if (!(merged || squashed || !s.changed || s.id === drop)) {
      out.push(`kept ${s.id} (${s.status}, not integrated)`);
      continue;
    }
    if (s.orca) {
      try { removeOrca(s); }
      catch (e) {
        out.push(`kept ${s.id} (${(e as Error).message})`);
        continue;
      }
    } else if (existsSync(s.worktree) && !git(s.repo, "worktree", "remove", "--force", s.worktree).ok) {
      out.push(`kept ${s.id} (git worktree remove failed)`);
      continue;
    }
    if (git(s.repo, "show-ref", "--verify", "--quiet", `refs/heads/${s.branch}`).ok && !git(s.repo, "branch", "-D", s.branch).ok) {
      out.push(`kept ${s.id} (branch removal failed)`);
      continue;
    }
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
      from: { type: "string" }, drop: { type: "string" }, risk: { type: "string" },
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
    const envHarness = process.env.ORCH_HARNESS;
    const from = isHarness(values.from) ? values.from : isHarness(envHarness) ? envHarness : "claude";
    const usage = 'usage: lane review --base <ref> --goal "<goal>" [--risk normal|high] [--from h] [--to h]';
    if (!values.base || !values.goal) throw new Error(usage);
    if (values.risk !== undefined && values.risk !== "normal" && values.risk !== "high") throw new Error(usage);
    const risk = values.risk === "high" ? "high" : "normal";
    process.stdout.write(await laneReview({ from, to: isHarness(values.to) ? values.to : undefined, base: values.base, goal: values.goal, repo, profile, risk }));
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
