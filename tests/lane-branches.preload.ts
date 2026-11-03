// Suite-wide guard: the orch checkout's lane/* branches and worktrees must be
// the same after `bun test` as before it. A test that forgets its temporary
// repo fails the run here instead of leaving branches behind.
import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

const ORCH = resolve(import.meta.dir, "..");

// The suite runs the same whoever starts it: a lane's VERIFY (ORCH_LANE=1), a
// lead's shell or a plain one. Role markers of the caller would make the code
// under test refuse writes the tests make in their own temporary state; a test
// that needs a role sets it itself.
export const CALLER_ROLE_VARS = ["ORCH_LANE", "ORCH_LANE_DEPTH", "ORCH_LEAD", "ORCH_CONDUCTOR", "ORCH_LEAD_PID", "ORCH_HARNESS"] as const;
for (const key of CALLER_ROLE_VARS) delete process.env[key];

// Lanes the operator's orch runs while the suite runs (a lane's own VERIFY, or
// Kiba dispatching) add and remove lane/* branches and worktrees in the same
// repository. Tests cannot create lane/* branches here (testRepoRefusal), so a
// ref whose lane id is known to a real state dir is not the suite's.
const REAL_STATES = [...new Set([process.env.ORCH_STATE, join(userInfo().homedir, ".local", "state", "orch")].filter((d): d is string => !!d))];
const realLane = (id: string) => REAL_STATES.some((dir) => existsSync(join(dir, "lanes", id)));

function laneId(line: string): string | null {
  return /(?:^|\/|\[)lane\/([^\]\s/]+)/.exec(line)?.[1] ?? /\/lanes\/([^/\s]+)\/wt\b/.exec(line)?.[1] ?? null;
}

export function orchLaneRefs(cwd = ORCH): string {
  const run = (...args: string[]) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : `git ${args[0]} failed: ${r.stderr.trim()}`;
  };
  // Only lane refs count: a worktree the operator or Orca adds meanwhile (a
  // fix branch, a worker checkout) is not the suite's and must not fail it.
  const keep = (text: string, sep: string) => text.split(sep).filter((chunk) => {
    const id = laneId(chunk);
    return id && !realLane(id);
  }).join(sep);
  return `${keep(run("branch", "--list", "lane/*", "--format=%(refname:short)"), "\n")}\n--worktrees--\n${keep(run("worktree", "list", "--porcelain"), "\n\n")}`;
}

const before = orchLaneRefs();

afterAll(() => {
  const after = orchLaneRefs();
  if (after !== before) {
    throw new Error(`the test suite changed lane/* branches or worktrees of ${ORCH}\n--- before\n${before}\n--- after\n${after}`);
  }
});
