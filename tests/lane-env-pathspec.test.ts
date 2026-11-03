import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneRun } from "../src/lane.ts";
import { loadProfile, type Profile } from "../src/core/profile.ts";

let root: string;
let bin: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_STATE: process.env.ORCH_STATE, ORCH_HOME: process.env.ORCH_HOME, ORCH_LANE: process.env.ORCH_LANE };
const base = loadProfile("max20");
const profile: Profile = { ...base, limits: { ...base.limits, max_concurrent_ceiling: 5, report_max_bytes: 4096, timeout_seconds: 30 } };

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
  chmodSync(p, 0o755);
}
function spec(verify: string) {
  const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, `OBJECTIVE: create out.txt\nFILES: out.txt\nINTERFACES: none\nCONSTRAINTS: touch nothing else\nVERIFY: ${verify}\nACCEPT: out.txt exists\n`);
  return p;
}
function newRepo(name: string, gitignore?: string) {
  const r = join(root, name);
  mkdirSync(r);
  sh(r, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  if (gitignore) {
    writeFileSync(join(r, ".gitignore"), `${gitignore}\n`);
    sh(r, "git add .gitignore && git -c user.email=t@t -c user.name=t commit -q -m ignore");
  }
  return r;
}

beforeAll(() => {
  delete process.env.ORCH_LANE;
  root = mkdtempSync(join(tmpdir(), "lane-env-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  process.env.ORCH_STATE = join(root, "state");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = join(root, "home");
  delete process.env.ORCH_HOME;
  mkdirSync(join(root, "home", ".grok"), { recursive: true });
  writeFileSync(join(root, "home", ".grok", "sandbox.toml"), readFileSync(join(import.meta.dir, "..", "catalog", "grok-sandbox.toml"), "utf8"));
}, 30_000);

afterAll(() => {
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
  for (const k of ["ORCH_STATE", "ORCH_HOME", "ORCH_LANE"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("lane VERIFY env and harness pathspec", () => {
  test("VERIFY sees LANE_WORKTREE (the lane worktree) and LANE_REPO", async () => {
    const repo = newRepo("env-repo");
    fake("codex", "echo hi > out.txt");
    const out = join(root, "verify-env.txt");
    const { state } = await laneRun({
      to: "codex", repo, profile,
      specPath: spec(`test -f out.txt && printf '%s\\n%s\\n' "$LANE_WORKTREE" "$LANE_REPO" > ${out}`),
    });
    expect(state?.status).toBe("complete");
    const [wt, lrepo] = readFileSync(out, "utf8").trim().split("\n");
    expect(wt).toBe(state!.worktree);
    expect(wt).toBeTruthy();
    expect(lrepo).toBe(state!.repo);
  });

  test("a repo that gitignores .claude: the commit succeeds, the change is committed, no harness file is", async () => {
    const repo = newRepo("ignore-repo", ".claude");
    fake("codex", "echo hi > out.txt; mkdir -p .claude; echo '{}' > .claude/settings.local.json; echo x > .zshrc");
    const { state, report } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(report).not.toContain("git add failed");
    expect(state?.status).toBe("complete");
    const files = sh(repo, `git ls-tree -r --name-only ${state!.branch}`).stdout.split("\n");
    expect(files).toContain("out.txt");
    expect(files.filter((f) => f.startsWith(".claude") || f === ".zshrc")).toEqual([]);
  });
});
