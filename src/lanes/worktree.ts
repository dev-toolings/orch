import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "../core/git.ts";

// Snapshot budget: past this, `git add -A` would copy a dataset into the
// caller's object store and hold a lane slot for minutes.
export const SNAPSHOT_LIMITS = { files: 20_000, bytes: 512 * 1024 * 1024, timeoutMs: 300_000 };

// The caller's status, unaffected by its config (status.showUntrackedFiles,
// diff.ignoreSubmodules) and without the optional index refresh that would
// rewrite the caller's .git/index.
export function statusEntries(cwd: string): string[] | null {
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

export type Base = { ok: true; sha: string; snapshotOf?: string } | { ok: false; reason: string };

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
