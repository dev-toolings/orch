#!/usr/bin/env bun
// lane: hand one bounded task to another harness, headless, in its own git
// worktree, and print a short report. No model call happens in this process.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classify, parseWorkerOutput, PREAMBLE, REVIEW_PREAMBLE, type Status, type Usage, workerArgv } from "./harness.ts";
import { HARNESSES, type Harness, loadProfile, type Profile } from "./profile.ts";
import { runLogged, workerEnv } from "./proc.ts";
import { releaseSlot, reserveSlot } from "./slots.ts";
import { missingFields, parseSpec } from "./spec.ts";

export const stateDir = () => process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// The worker starts from the caller's full working tree. A dirty tree (tracked
// edits, staged or not, and untracked files not ignored) becomes a snapshot
// commit over HEAD, built through a private index so the caller's index, HEAD,
// branches, stash and files stay untouched. A clean tree uses HEAD as is.
function workerBase(repo: string, dir: string): { sha: string; snapshotOf?: string } | null {
  const head = git(repo, "rev-parse", "HEAD");
  if (!head.ok) return null;
  if (!git(repo, "status", "--porcelain").out) return { sha: head.out };
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "snapshot.index") };
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  const short = head.out.slice(0, 12);
  const tree = g("read-tree", "HEAD") !== null && g("add", "-A") !== null ? g("write-tree") : null;
  const sha = tree && g("-c", "user.name=lane", "-c", "user.email=lane@localhost", "commit-tree", tree, "-p", head.out,
    "-m", `lane: snapshot of working tree over ${short}`);
  rmSync(join(dir, "snapshot.index"), { force: true });
  return sha ? { sha, snapshotOf: short } : null;
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
  const spec = parseSpec(readFileSync(opts.specPath, "utf8"));
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
    if (!b) return { report: "LANE REPORT\nSTATUS: unavailable\nREASON: could not resolve or snapshot the base\n" };
    const base = b.sha;
    if (!git(repo, "worktree", "add", "-q", "-b", branch, wt, base).ok) {
      return { report: `LANE REPORT\nSTATUS: unavailable\nREASON: git worktree add failed\n` };
    }
    const promptPath = join(dir, "prompt.txt");
    writeFileSync(promptPath, PREAMBLE + spec.raw);
    const lastPath = join(dir, "last.txt");
    const logPath = join(dir, "worker.log");
    const choice = p.lanes[opts.to];
    const call = workerArgv(opts.to, choice, {
      cwd: wt, promptPath, effort: opts.effort ?? spec.reasoning, readOnly: false, lastMessagePath: lastPath,
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

    const dirty = git(wt, "status", "--porcelain").out;
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

    const status = classify({ ...run, changed, verifyOk, log });
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
      `ID: ${id}`,
      `BASE: ${base} (${b.snapshotOf ? `snapshot of dirty tree over HEAD ${b.snapshotOf}` : "HEAD"})`,
      `BRANCH: ${branch}`,
      `CHANGES:\n${stat}`,
      `VERIFY: ${verifyOut}`,
      `WORKER SAID: ${message.replace(/\s+/g, " ").trim().slice(0, 400) || "(nothing)"}`,
      `USAGE: ${fmtUsage(usage)}`,
      changed && status === "complete"
        ? b.snapshotOf
          ? `INTEGRATE: git diff ${base} ${branch} | git apply  then: lane gc --drop ${id}`
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
  const call = workerArgv(to, rc, { cwd: opts.repo, promptPath, readOnly: true, lastMessagePath: lastPath });
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
