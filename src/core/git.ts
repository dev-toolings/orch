import { spawnSync } from "node:child_process";

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
