// The per-project folder: ~/.orch/<project>/ holds what orch keeps about one
// repository (project notes, specs, lane-setup), outside the repository so no
// checkout carries an `.orch/` folder. <project> is the main worktree's folder
// name, the same from every linked worktree and the brain's projectKey.
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.ts";

export const projectsRoot = () => join(process.env.ORCH_HOME ?? process.env.HOME ?? homedir(), ".orch");

export function repoRoot(cwd: string): string {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const commonDir = common.ok ? common.out : "";
  if (commonDir && basename(commonDir) === ".git") return dirname(commonDir);
  const root = git(cwd, "rev-parse", "--show-toplevel");
  return root.ok ? root.out : cwd;
}

export const projectKey = (cwd = process.cwd()) => basename(repoRoot(cwd));

export const projectDir = (cwd = process.cwd(), root = projectsRoot()) => join(root, projectKey(cwd));

// The folder orch used before, inside the repository.
export const legacyDir = (cwd = process.cwd()) => join(repoRoot(cwd), ".orch");

const kindOf = (p: string) => {
  try {
    const s = lstatSync(p);
    return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
  } catch { return null; }
};
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (a: string, b: string) => { const r = relative(a, b); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

// The warning for a <repo>/.orch left behind: nothing reads it any more, so its
// notes and specs are silently lost and its files end up in commits. Shown by
// kiba at launch, orch doctor and orch mem. None from HOME itself, where the
// old folder is the projects root.
export function legacyNotice(cwd = process.cwd(), root = projectsRoot()): string | null {
  const from = legacyDir(cwd);
  if (kindOf(from) !== "dir" || inside(real(from), real(root)) || inside(real(root), real(from))) return null;
  const tracked = git(repoRoot(cwd), "ls-files", ".orch");
  const commit = tracked.ok && tracked.out ? ", then commit the removal of its tracked files" : "";
  return `${from} is no longer read (project data lives in ${projectDir(cwd, root)}): run orch migrate${commit}`;
}

// Moves <repo>/.orch/** into ~/.orch/<project>/, file by file and never over
// an existing path (hard link then unlink, copy across devices). A file
// already there with the same content drops the old copy; anything else that
// does not fit (a different file, a link, a file where a folder goes) is a
// conflict: both stay and the line says so. Refused when one folder holds the
// other (`orch migrate` run from HOME itself). Files git tracks show as
// deleted afterwards: committing that is the operator's.
export function migrateProject(cwd = process.cwd(), opts: { dry?: boolean; root?: string } = {}): { lines: string[]; conflicts: number } {
  const from = legacyDir(cwd);
  const to = projectDir(cwd, opts.root);
  if (!existsSync(from)) return { lines: [`nothing to migrate: no ${from}`], conflicts: 0 };
  const toReal = join(real(opts.root ?? projectsRoot()), basename(to));
  if (inside(real(from), toReal) || inside(toReal, real(from))) return { lines: [`refused: ${from} and ${to} overlap, run orch migrate from the repository`], conflicts: 1 };
  const lines: string[] = [];
  let conflicts = 0;
  const conflict = (line: string) => { conflicts++; lines.push(`conflict  ${line}, both kept`); };
  const walk = (rel: string) => {
    for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      const src = join(from, r);
      const dst = join(to, r);
      const srcKind = kindOf(src);
      const dstKind = kindOf(dst);
      try {
        if (srcKind === "dir") {
          if (dstKind === null || dstKind === "dir") walk(r);
          else conflict(`${r}: ${dst} is not a folder`);
        } else if (srcKind !== "file") {
          conflict(`${r}: not a regular file, move it by hand`);
        } else if (dstKind === "file" && readFileSync(dst).equals(readFileSync(src))) {
          lines.push(`${opts.dry ? "would drop" : "dropped"}  ${r} (same in ${to})`);
          if (!opts.dry) unlinkSync(src);
        } else if (dstKind !== null) {
          conflict(`${r}: ${dst} differs`);
        } else {
          if (!opts.dry) {
            mkdirSync(dirname(dst), { recursive: true });
            try { linkSync(src, dst); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
              copyFileSync(src, dst, constants.COPYFILE_EXCL);
            }
            unlinkSync(src);
          }
          lines.push(`${opts.dry ? "would move" : "moved"}  ${r}`);
        }
      } catch (error) {
        conflicts++;
        lines.push(`error  ${r}: ${(error as Error).message}`);
      }
    }
    if (!opts.dry && !readdirSync(join(from, rel)).length) rmdirSync(join(from, rel));
  };
  walk("");
  const tracked = git(repoRoot(cwd), "ls-files", ".orch");
  if (!opts.dry && tracked.ok && tracked.out) lines.push(`git tracked files under .orch/ now show as deleted: commit their removal`);
  lines.push(`${opts.dry ? "would migrate" : "migrated"} ${from} -> ${to}${conflicts ? ` (${conflicts} left in place)` : ""}`);
  return { lines, conflicts };
}
