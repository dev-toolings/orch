// Files a harness or its sandbox creates or edits at the root of a lane
// worktree (Claude Code's sandbox mounts placeholders for the shell and git rc
// files it protects; Claude, Codex and Grok write their own settings folders).
// They are not the worker's change: the watchdog does not count them as drift,
// and the lane never commits them, unless the spec declares them in FILES.
// List taken from Claude Code 2.1.316's protected-file set (sandbox) plus the
// harness folders. Also the transient atomic-write files `<file>.tmp.<pid>.<hex>`
// of Claude Code's Edit/Write tools, owned whatever FILES says. The sandbox also mounts 0-line placeholders over .gitmodules,
// .idea and .vscode (seen in a lane worktree as char devices); they are listed too.
import { spawnSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { inScope } from "./route.ts";

export const HARNESS_OWNED_FILES = [
  ".gitconfig", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases",
  ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".ripgreprc",
  ".mcp.json", ".claude.json", ".gitmodules",
] as const;
export const HARNESS_OWNED_DIRS = [".claude/", ".codex/", ".grok/", ".idea/", ".vscode/"] as const;

// Claude Code's Edit/Write tools write `<file>.tmp.<pid>.<hex>` next to the target
// and rename it over it; a sample taken mid-write must not read as drift.
const TRANSIENT_WRITE = /\.tmp\.\d+\.[0-9a-f]+$/;

export function isHarnessOwned(path: string, declared: string[] = []): boolean {
  const p = path.replace(/^\.\//, "").replace(/^"|"$/g, "");
  if (TRANSIENT_WRITE.test(p)) return true;
  const owned = (HARNESS_OWNED_FILES as readonly string[]).includes(p) || HARNESS_OWNED_DIRS.some((d) => p === d.slice(0, -1) || p.startsWith(d));
  return owned && !inScope(p, declared);
}

// `git add` pathspec: everything but the harness-owned paths not declared in FILES.
// With `wt`, excludes for paths git already ignores are dropped: `git add` exits
// non-zero ("paths are ignored by one of your .gitignore files") when an exclude
// names an ignored path, and an ignored path is never staged by `add -A` anyway.
export function addPathspec(declared: string[] = [], wt?: string): string[] {
  const ignored = (p: string, dir: boolean): boolean => {
    if (!wt) return false;
    const probe = (x: string) => spawnSync("git", ["-C", wt, "check-ignore", "-q", "--", x], { encoding: "utf8" }).status === 0;
    return probe(p) || (dir && (probe(`${p}/`) || probe(`${p}/x`)));
  };
  const out = ["--", "."];
  for (const f of HARNESS_OWNED_FILES) if (!inScope(f, declared) && !ignored(f, false)) out.push(`:(exclude,top)${f}`);
  for (const d of HARNESS_OWNED_DIRS) {
    const name = d.slice(0, -1);
    if (!declared.some((x) => x.startsWith(d)) && !ignored(name, true)) out.push(`:(exclude,top)${name}`);
  }
  out.push(":(exclude,top,glob)**/*.tmp.[0-9]*.[0-9a-f]*");
  return out;
}

/**
 * A Claude worker's Bash sandbox mounts a placeholder over the protected
 * .git/config: an empty, read-only `config.lock` in the git dir. A command
 * killed mid-run (watchdog, timeout) leaves it behind, and every later git
 * config write in that repository fails ("could not lock config file") until
 * it is removed. Git's own lock files are writable; only an empty read-only
 * one written since the worker started is removed.
 */
export function clearSandboxPlaceholders(wt: string, sinceMs: number): string[] {
  const removed: string[] = [];
  const dirs = new Set<string>();
  for (const flag of ["--git-dir", "--git-common-dir"]) {
    const r = spawnSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", flag], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) dirs.add(r.stdout.trim());
  }
  for (const dir of dirs) {
    const lock = join(dir, "config.lock");
    try {
      const st = statSync(lock);
      if (st.isFile() && st.size === 0 && (st.mode & 0o222) === 0 && st.mtimeMs >= sinceMs - 1000) {
        rmSync(lock, { force: true });
        removed.push(lock);
      }
    } catch { /* no lock */ }
  }
  return removed;
}
