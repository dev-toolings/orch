import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ROOT } from "../core/profile.ts";
import { stateDir } from "../core/paths.ts";

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
