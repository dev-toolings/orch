import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneGc, laneReview, laneRun, listLanes, setupCommand } from "../src/lane.ts";
import { bound } from "../src/output.ts";
import { laneReport } from "../src/report.ts";
import { SNAPSHOT_LIMITS, statusPaths } from "../src/worktree.ts";
import { loadProfile, type Profile } from "../src/profile.ts";
import { releaseSlot, reserveSlot } from "../src/slots.ts";

let root: string;
let repo: string;
let bin: string;
const savedPath = process.env.PATH;
const savedHome = process.env.HOME;
const savedState = process.env.ORCH_STATE;
// Hermetic: these tests may run inside a lane VERIFY, where ORCH_LANE=1 is
// inherited and would trip the depth guard of every laneRun below.
const savedLane = process.env.ORCH_LANE;
const profile: Profile = { ...loadProfile("max20"), limits: { max_concurrent: 5, max_depth: 1, report_max_bytes: 4096, timeout_seconds: 30 } };

const SPEC = (verify: string) => `OBJECTIVE: create out.txt
FILES: out.txt
INTERFACES: none
CONSTRAINTS: touch nothing else
VERIFY: ${verify}
ACCEPT: out.txt exists
`;

function sh(cwd: string, cmd: string) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

// Fake harness binary: its behavior is baked into the script.
function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
  chmodSync(p, 0o755);
}

function spec(verify: string) {
  const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(p, SPEC(verify));
  return p;
}

beforeAll(() => {
  delete process.env.ORCH_LANE;
  root = mkdtempSync(join(tmpdir(), "lane-test-"));
  repo = join(root, "repo");
  bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  sh(repo, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  process.env.ORCH_STATE = join(root, "state");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  // Hermetic HOME: Grok lanes need orch's profile, never the operator's files.
  process.env.HOME = join(root, "home");
  mkdirSync(join(root, "home", ".grok"), { recursive: true });
  writeFileSync(join(root, "home", ".grok", "sandbox.toml"), readFileSync(join(import.meta.dir, "..", "catalog", "grok-sandbox.toml"), "utf8"));
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedLane !== undefined) process.env.ORCH_LANE = savedLane;
  process.env.HOME = savedHome;
  if (savedState === undefined) delete process.env.ORCH_STATE;
  else process.env.ORCH_STATE = savedState;
  rmSync(root, { recursive: true, force: true });
});

// A real local git worktree plus a fake Orca control plane. The observer runs
// in a poisoned PTY-like environment; no real Orca or model is ever called.
function fakeOrca(mode = "up") {
  writeFileSync(join(root, "orca-mode"), mode);
  const script = `#!${process.execPath}
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, openSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2), verb = args.slice(0, 2).join(' ');
const flag = k => args[args.indexOf(k) + 1];
const mode = readFileSync(root + '/orca-mode', 'utf8');
appendFileSync(root + '/orca-calls', JSON.stringify(args) + '\\n');
const fail = code => { console.log(JSON.stringify({ok:false,error:{code}})); process.exit(1); };
const ok = result => { console.log(JSON.stringify({ok:true,result})); process.exit(0); };
if (mode === 'down') fail('relay_socket_missing');
if (mode === 'invalid') { console.log('not JSON'); process.exit(0); }
const db = root + '/orca-resources';
const resources = existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) : {};
const persist = () => writeFileSync(db, JSON.stringify(resources));
if (verb === 'worktree current') ok({worktree:{id:'fake::' + process.cwd(),repoId:'fake',path:process.cwd(),hostId:mode === 'remote' ? 'ssh:remote' : 'local'}});
if (verb === 'repo show') ok({repo:{id:'fake',kind:mode === 'folder' ? 'folder' : 'git'}});
if (verb === 'worktree create') {
  const name = flag('--name');
  let path = root + '/orca-' + name;
  if (['repo-path', 'repo-alias', 'repo-subdir', 'standalone', 'unrelated-linked'].includes(mode)) {
    if (mode === 'repo-path') path = process.cwd();
    else if (mode === 'repo-alias') symlinkSync(process.cwd(), path);
    else if (mode === 'repo-subdir') { path = process.cwd() + '/.git'; }
    else {
      mkdirSync(path);
      spawnSync('git', ['init', '-q', path]);
      spawnSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      if (mode === 'unrelated-linked') {
        spawnSync('git', ['-C', path, 'worktree', 'add', '-q', '-b', 'child', path + '-child']);
        path += '-child';
      }
    }
    const w = {id:'fake::' + path,path,branch:spawnSync('git', ['branch', '--show-current'], {encoding:'utf8'}).stdout.trim()};
    resources['id:' + w.id] = {worktree:w};
    resources['name:' + name] = resources['id:' + w.id]; persist();
    ok({worktree:w});
  }
  const r = spawnSync('git', ['worktree','add','-q','-b','fake/' + name,path,flag('--base-branch')]);
  if (r.status !== 0) fail('create_failed');
  const w = {id:'fake::' + path,path,branch:'refs/heads/fake/' + name};
  resources['id:' + w.id] = {worktree:w};
  resources['name:' + name] = resources['id:' + w.id]; persist();
  if (mode === 'lost-create' || mode === 'unknown-create') fail('runtime_unavailable');
  ok({worktree:w});
}
const entry = resources[flag('--worktree')];
if (mode === 'unknown-create') fail('runtime_unavailable');
if (!entry) fail('selector_not_found');
if (verb === 'worktree show') ok({worktree:entry.worktree});
if (verb === 'terminal create') {
  if (mode === 'no-terminal') fail('terminal_unavailable');
  const out = openSync(root + '/observer-output', 'a');
  const child = spawn('/bin/sh', ['-c', flag('--command')], {cwd:entry.worktree.path,
    detached:true, stdio:['ignore',out,out], env:{...process.env,ORCA_SECRET:'pty-secret',SECRET_TOKEN:'pty-secret'}});
  child.unref(); entry.pid = child.pid; persist();
  ok({terminal:{handle:'term_fake'}});
}
if (verb === 'terminal close') {
  if (mode === 'close-fails') fail('stop_unverifiable');
  if (entry.pid) { try { process.kill(-entry.pid, 'SIGKILL'); } catch {} delete entry.pid; persist(); }
  ok({closed:1});
}
if (verb === 'worktree rm') {
  if (mode === 'rm-fails') fail('runtime_unavailable');
  if (mode === 'rm-pending') ok({removed:true,removing:true});
  const r = spawnSync('git', ['worktree','remove','--force',entry.worktree.path]);
  if (r.status !== 0) fail('remove_failed');
  for (const k of Object.keys(resources)) if (resources[k].worktree.id === entry.worktree.id) delete resources[k];
  persist(); ok({removed:true});
}
fail('unsupported');
`;
  writeFileSync(join(bin, "orca"), script);
  chmodSync(join(bin, "orca"), 0o755);
}

describe("Orca lane channel", () => {
  test("auto: visible observer, dirty snapshot, isolated worker, usage and gc", async () => {
    fakeOrca();
    process.env.SECRET_TOKEN = "caller-secret";
    writeFileSync(join(repo, "caller-dirty.txt"), "snapshot input\n");
    fake("codex", "sleep 1; env > env.txt; echo hi > out.txt; echo 'tokens used'; echo 321");
    let state: Awaited<ReturnType<typeof laneRun>>["state"];
    try {
      const pending = laneRun({ to: "codex", specPath: spec("test -f out.txt && test -f caller-dirty.txt"), repo, profile });
      await Bun.sleep(200);
      const running = listLanes().find(s => s.status === "running" && s.orca);
      expect(running).toBeDefined();
      expect(laneGc(running!.id)).toContain(`kept ${running!.id} (running)`);
      const result = await pending;
      state = result.state;
      expect(state?.status).toBe("complete");
      expect(state?.channel).toBe("orca");
      expect(state?.orca?.terminal).toBe("term_fake");
      expect(result.report).toContain("USAGE: total 321");
      expect(Buffer.byteLength(result.report)).toBeLessThanOrEqual(4096);
      expect(result.report).toContain("snapshot of dirty tree");
      const dumped = readFileSync(join(state!.worktree, "env.txt"), "utf8");
      expect(dumped).toContain("ORCH_LANE=1");
      expect(dumped).not.toContain("caller-secret");
      expect(dumped).not.toContain("pty-secret");
      await Bun.sleep(350);
      const output = readFileSync(join(root, "observer-output"), "utf8");
      expect(output).toContain('"state":"working"');
      expect(output).toContain('"state":"done"');
      expect(output).toContain("LANE REPORT");
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
      expect(existsSync(state!.worktree)).toBe(false);
      const calls: string[][] = readFileSync(join(root, "orca-calls"), "utf8").trim().split("\n").map(l => JSON.parse(l));
      const create = calls.find(a => a[0] === "worktree" && a[1] === "create")!;
      expect(create).toContain("--parent-worktree");
      expect(create[create.indexOf("--base-branch") + 1]).toBe(state!.base);
      expect(create[create.indexOf("--setup") + 1]).toBe("skip");
      const command = calls.find(a => a[0] === "terminal" && a[1] === "create")!;
      expect(command[command.indexOf("--command") + 1]).toContain("'-i'");
      expect(calls.some(a => a[0] === "terminal" && a[1] === "close" && a.includes("--all"))).toBe(true);
      expect(calls.some(a => a[0] === "worktree" && a[1] === "rm")).toBe(true);
    } finally {
      delete process.env.SECRET_TOKEN;
      rmSync(join(repo, "caller-dirty.txt"), { force: true });
      if (state) laneGc(state.id);
      rmSync(join(bin, "orca"), { force: true });
    }
  });

  test("explicit headless never contacts an available Orca", async () => {
    fakeOrca();
    const before = readFileSync(join(root, "orca-calls"), "utf8");
    fake("codex", "true");
    try {
      const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile, channel: "headless" });
      expect(state?.channel).toBe("headless");
      expect(state?.orca).toBeUndefined();
      expect(readFileSync(join(root, "orca-calls"), "utf8")).toBe(before);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test.each(["absent", "down", "invalid", "remote", "remote-route"])("explicit orca falls back when %s", async (mode) => {
    if (mode !== "absent") fakeOrca(mode);
    const routed = process.env.ORCA_ENVIRONMENT;
    if (mode === "remote-route") process.env.ORCA_ENVIRONMENT = "another-host";
    fake("codex", "true");
    try {
      const { state, report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile, channel: "orca" });
      expect(state?.status).toBe("noop");
      expect(state?.channel).toBe("headless");
      expect(state?.orca).toBeUndefined();
      expect(report).toContain("headless");
    } finally {
      if (routed === undefined) delete process.env.ORCA_ENVIRONMENT;
      else process.env.ORCA_ENVIRONMENT = routed;
      rmSync(join(bin, "orca"), { force: true });
    }
  });

  test("folder projects fall back to headless before any Orca mutation", async () => {
    fakeOrca("folder");
    const before = readFileSync(join(root, "orca-calls"), "utf8");
    fake("codex", "true");
    try {
      const { state, report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile, channel: "orca" });
      expect(state?.status).toBe("noop");
      expect(state?.channel).toBe("headless");
      expect(state?.orca).toBeUndefined();
      expect(state?.worktree).not.toBe(repo);
      expect(report).toContain("CHANNEL: Orca repo kind folder is not git; worker remains headless");
      const calls = readFileSync(join(root, "orca-calls"), "utf8").slice(before.length).trim().split("\n").map(l => JSON.parse(l).slice(0, 2));
      expect(calls).toEqual([["worktree", "current"], ["repo", "show"]]);
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test.each(["repo-path", "repo-alias", "repo-subdir", "standalone", "unrelated-linked"])("create refuses %s before renaming or starting a worker", async (mode) => {
    fakeOrca(mode);
    const before = readFileSync(join(root, "orca-calls"), "utf8");
    const branch = sh(repo, "git branch --show-current").stdout;
    const marker = join(root, `unsafe-${mode}-worker`);
    fake("codex", `touch ${marker}`);
    let failed: ReturnType<typeof listLanes>[number] | undefined;
    try {
      const { state, report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile, channel: "orca" });
      expect(state).toBeUndefined();
      expect(report).toContain("STATUS: unavailable");
      expect(report).toContain(mode === "repo-path" || mode === "repo-alias"
        ? "Orca worktree resolves to the caller repo" : "Orca returned no distinct linked git worktree");
      expect(sh(repo, "git branch --show-current").stdout).toBe(branch);
      expect(existsSync(marker)).toBe(false);
      failed = listLanes().find(s => report.includes(`ID: ${s.id}\n`));
      expect(failed).toBeDefined();
      // A lost create reply is recovered by name during gc. That recovery
      // must not turn a rejected caller checkout into a removal target.
      if (mode === "repo-path" || mode === "repo-alias") {
        expect(laneGc(failed!.id)).toContain(`kept ${failed!.id} (Orca worktree resolves to the caller repo; refusing to use or remove it)`);
      }
      const calls = readFileSync(join(root, "orca-calls"), "utf8").slice(before.length);
      expect(calls).toContain('["worktree","create"');
      expect(calls).not.toContain('["worktree","rm"');
      expect(calls).not.toContain('["terminal"');
    } finally {
      if (failed) rmSync(join(process.env.ORCH_STATE!, "lanes", failed.id), { recursive: true, force: true });
      rmSync(join(bin, "orca"), { force: true });
    }
  });

  test("gc retains a lane pointing at its repo, including a symlink alias, without Orca removal", () => {
    fakeOrca();
    const before = readFileSync(join(root, "orca-calls"), "utf8");
    const branch = sh(repo, "git branch --show-current").stdout.trim();
    const id = "unsafe-caller-checkout";
    const dir = join(process.env.ORCH_STATE!, "lanes", id);
    const alias = join(root, "caller-repo-alias");
    symlinkSync(repo, alias);
    mkdirSync(dir, { recursive: true });
    try {
      for (const worktree of [repo, alias]) {
        writeFileSync(join(dir, "state.json"), JSON.stringify({
          id, to: "codex", repo, base: "HEAD", branch, worktree, status: "unavailable", changed: false,
          usage: {}, started: "", ended: "", channel: "orca", orca: { selector: `id:fake::${repo}` },
        }));
        expect(laneGc(id)).toContain(`kept ${id} (Orca worktree resolves to the caller repo; refusing to use or remove it)`);
        expect(existsSync(join(dir, "state.json"))).toBe(true);
        expect(existsSync(repo)).toBe(true);
        expect(sh(repo, "git branch --show-current").stdout.trim()).toBe(branch);
      }
      expect(readFileSync(join(root, "orca-calls"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(bin, "orca"), { force: true });
    }
  });

  test.each(["lost-create", "no-terminal"])("%s runs the worker once and retains Orca gc ownership", async (mode) => {
    fakeOrca(mode);
    fake("codex", "echo once >> out.txt");
    try {
      const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile, channel: "orca" });
      expect(state?.status).toBe("complete");
      expect(state?.channel).toBe(mode === "no-terminal" ? "headless" : "orca");
      expect(state?.orca).toBeDefined();
      expect(readFileSync(join(state!.worktree, "out.txt"), "utf8")).toBe("once\n");
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test.each(["close-fails", "rm-fails", "rm-pending"])("gc retains ledger and branch when %s", async (mode) => {
    fakeOrca();
    fake("codex", "true");
    try {
      const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile });
      fakeOrca(mode);
      expect(laneGc(state!.id).some(s => s.startsWith(`kept ${state!.id} (Orca`))).toBe(true);
      expect(existsSync(state!.worktree)).toBe(true);
      expect(listLanes().some(s => s.id === state!.id)).toBe(true);
      expect(sh(repo, `git rev-parse --verify ${state!.branch}`).status).toBe(0);
      fakeOrca();
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test("unknown create outcome stays recoverable without launching a worker", async () => {
    fakeOrca("unknown-create");
    const marker = join(root, "unexpected-worker");
    fake("codex", `touch ${marker}`);
    try {
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile });
      expect(report).toContain("STATUS: unavailable");
      expect(existsSync(marker)).toBe(false);
      const pending = listLanes().find(s => s.orca?.selector.startsWith("name:"))!;
      expect(pending).toBeDefined();
      fakeOrca();
      expect(laneGc(pending.id)).toContain(`removed ${pending.id}`);
      expect(sh(repo, `git branch --list 'fake/lane-${pending.id}'`).stdout.trim()).toBe("");
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test("gc completes a prior asynchronous Orca removal", async () => {
    fakeOrca();
    fake("codex", "true");
    try {
      const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile });
      fakeOrca("rm-pending");
      expect(laneGc(state!.id).some(s => s.includes("removal pending"))).toBe(true);
      // The fake server completes its previously accepted removal later.
      spawnSync("git", ["worktree", "remove", "--force", state!.worktree], { cwd: repo });
      const db = join(root, "orca-resources");
      const resources = JSON.parse(readFileSync(db, "utf8"));
      for (const k of Object.keys(resources)) if (resources[k].worktree.path === state!.worktree) delete resources[k];
      writeFileSync(db, JSON.stringify(resources));
      fakeOrca();
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
      expect(sh(repo, `git rev-parse --verify ${state!.branch}`).status).not.toBe(0);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });

  test("Orca channel keeps process-group timeout and skips VERIFY", async () => {
    fakeOrca();
    const marker = join(root, "orca-late-write");
    fake("codex", `(sleep 2; touch ${marker}) & sleep 30`);
    try {
      const { state, report } = await laneRun({ to: "codex", specPath: spec("echo should-not-run"), repo,
        profile: { ...profile, limits: { ...profile.limits, timeout_seconds: 0.1 } } });
      expect(state?.status).toBe("timeout");
      expect(report).toContain("VERIFY: not run");
      await Bun.sleep(2200);
      expect(existsSync(marker)).toBe(false);
      expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
    } finally { rmSync(join(bin, "orca"), { force: true }); }
  });
});

describe("lane run classes", () => {
  test("complete: change committed on the lane branch, usage parsed", async () => {
    fake("codex", 'echo hi > out.txt; echo "tokens used"; echo "1 234"');
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain("USAGE: total 1234");
    expect(report).toContain(`INTEGRATE: git merge --squash ${state!.branch}`);
    expect(sh(repo, `git show --stat ${state!.branch}`).stdout).toContain("out.txt");
  });

  test("noop: nothing changed and VERIFY passes", async () => {
    fake("codex", "true");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("noop");
  });

  test("refused: nothing changed and VERIFY fails", async () => {
    fake("codex", "echo 'I will not do that'");
    expect((await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile })).state?.status).toBe("refused");
  });

  test("failed: worker exits non-zero after editing", async () => {
    fake("codex", "echo x > out.txt; exit 3");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("failed");
  });

  test("blocked: permission denial without change", async () => {
    fake("codex", "echo 'Permission denied by sandbox' >&2; exit 1");
    expect((await laneRun({ to: "codex", specPath: spec("true"), repo, profile })).state?.status).toBe("blocked");
  });

  test("unavailable: harness binary missing", async () => {
    rmSync(join(bin, "claude"), { force: true });
    const { state } = await laneRun({ to: "claude", specPath: spec("true"), repo, profile });
    expect(state?.status).toBe("unavailable");
  });

  test("timeout: the whole process group is stopped", async () => {
    const marker = join(root, "late-write");
    fake("grok", `(sleep 3; touch ${marker}) & sleep 30`);
    const short = { ...profile, limits: { ...profile.limits, timeout_seconds: 1 } };
    const { state } = await laneRun({ to: "grok", specPath: spec("true"), repo, profile: short });
    expect(state?.status).toBe("timeout");
    await Bun.sleep(3500);
    expect(existsSync(marker)).toBe(false);
  });

  test("secrets in the lead's environment never reach the worker", async () => {
    process.env.SECRET_TOKEN = "s3cr3t";
    fake("codex", "env > env.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo, profile });
    delete process.env.SECRET_TOKEN;
    const dumped = sh(repo, `git show ${state!.branch}:env.txt`).stdout;
    expect(dumped).toContain("PATH=");
    expect(dumped).not.toContain("s3cr3t");
  });

  test("dirty caller tree: worker starts from a snapshot, caller state untouched", async () => {
    const dirty = join(root, "dirty");
    mkdirSync(dirty);
    sh(dirty, "git init -q && echo v1 > shared.txt && git add shared.txt && git -c user.email=t@t -c user.name=t commit -q -m init");
    writeFileSync(join(dirty, "shared.txt"), "v2\n");
    writeFileSync(join(dirty, "component.txt"), "new\n");
    // The lane branch is lane run's own output; everything else of the caller must stay byte-identical.
    const probe = () => sh(dirty, "git status --porcelain; git rev-parse HEAD; git branch -a | grep -v ' lane/'; git stash list").stdout;
    const before = probe();
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: dirty, profile });
    expect(probe()).toBe(before);
    expect(state?.status).toBe("complete");
    expect(readFileSync(join(state!.worktree, "shared.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(state!.worktree, "component.txt"), "utf8")).toBe("new\n");
    const head = sh(dirty, "git rev-parse --short=12 HEAD").stdout.trim();
    expect(report).toContain(`BASE: ${state!.base} (snapshot of dirty tree over HEAD ${head})`);
    expect(sh(dirty, `git diff --name-only ${state!.base} ${state!.branch}`).stdout.trim()).toBe("out.txt");
    expect(laneGc(state!.id)).toContain(`removed ${state!.id}`);
  });

  test("incomplete spec is rejected before any worker starts", async () => {
    const p = join(root, "bad.txt");
    writeFileSync(p, "OBJECTIVE: something\n");
    const { report, state } = await laneRun({ to: "codex", specPath: p, repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("spec missing FILES");
  });
});

describe("report and slots", () => {
  test("laneReport renders the fixed report fields", () => {
    expect(laneReport({
      to: "codex", model: "m", effort: "low", channel: "headless", channelReason: "", status: "complete",
      id: "id", base: "base", branch: "lane/id", setupLine: "SETUP: none", stat: "none", verifyOut: "exit 0",
      message: "done", usage: {}, changed: false, logPath: "/tmp/log",
    })).toBe("LANE REPORT\nLANE: codex · m · effort low · headless\nSTATUS: complete\nID: id\nBASE: base (HEAD)\nBRANCH: lane/id\nSETUP: none\nCHANGES:\nnone\nVERIFY: exit 0\nWORKER SAID: done\nUSAGE: not reported\nLOG: /tmp/log\n");
  });

  test("report is bounded in bytes", () => {
    const r = bound("x".repeat(10_000), 4096);
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(4096);
    expect(r).toContain("truncated");
  });

  test("slots are exclusive and capped", () => {
    const sd = join(root, "slots-test");
    const a = reserveSlot(sd, 2, "a");
    const b = reserveSlot(sd, 2, "b");
    expect([a, b].sort()).toEqual([0, 1]);
    expect(reserveSlot(sd, 2, "c")).toBeNull();
    releaseSlot(sd, a!);
    expect(reserveSlot(sd, 2, "d")).toBe(a);
  });

  test("a slot held by a dead process is reclaimed", () => {
    const sd = join(root, "slots-stale");
    mkdirSync(join(sd, "slots", "0"), { recursive: true });
    writeFileSync(join(sd, "slots", "0", "pid"), "999999999 ghost");
    expect(reserveSlot(sd, 1, "e")).toBe(0);
  });
});

describe("gc", () => {
  test("keeps unintegrated work, removes it once merged", async () => {
    sh(repo, "rm -rf * && git checkout -q -- . 2>/dev/null; true");
    laneGc(); // clear earlier lanes that produced nothing worth keeping
    fake("codex", "echo keep > keep.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f keep.txt"), repo, profile });
    expect(laneGc().some((l) => l.startsWith(`kept ${state!.id}`))).toBe(true);
    sh(repo, `git -c user.email=t@t -c user.name=t merge -q --no-edit ${state!.branch}`);
    expect(laneGc()).toContain(`removed ${state!.id}`);
    expect(existsSync(state!.worktree)).toBe(false);
  });
});

describe("profiles", () => {
  test("both shipped profiles load and never pin a Grok lane model", () => {
    for (const name of ["max20", "lean"]) expect(loadProfile(name).lanes.grok.model ?? null).toBeNull();
  });
});

test("CLAUDE.md core stays under 4 KB (corpus T01)", () => {
  const f = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  if (existsSync(f)) expect(readFileSync(f).length).toBeLessThanOrEqual(4096);
});

describe("lane setup", () => {
  const withSetup = (setup: string) => {
    const p = join(root, `spec-setup-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, `${SPEC("test -f out.txt")}SETUP: ${setup}\n`);
    return p;
  };

  test("SETUP runs in the worktree before the worker, with LANE_REPO and LANE_WORKTREE", async () => {
    fake("codex", 'test -f "$PWD/../setup-ran" && echo hi > out.txt');
    const { report, state } = await laneRun({
      to: "codex", specPath: withSetup('test "$PWD" = "$LANE_WORKTREE" && test -d "$LANE_REPO/.git" && touch ../setup-ran'), repo, profile,
    });
    expect(state?.status).toBe("complete");
    expect(report).toMatch(/SETUP: .* \(spec SETUP, ok in \d+s\)/);
  });

  test("a failing SETUP stops the lane before any worker, and removes its branch", async () => {
    fake("codex", "echo hi > out.txt");
    const branches = () => sh(repo, "git branch --list 'lane/*'").stdout;
    const before = branches();
    const { report, state } = await laneRun({ to: "codex", specPath: withSetup("echo broken toolchain; exit 3"), repo, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("setup failed, exit 3");
    expect(report).toContain("broken toolchain");
    expect(branches()).toBe(before);
  });

  test("a SETUP that leaves files git sees is refused: they would land in the result", async () => {
    fake("codex", "echo hi > out.txt");
    const { report } = await laneRun({ to: "codex", specPath: withSetup("echo x > generated.txt"), repo, profile });
    expect(report).toContain("STATUS: unavailable");
    expect(report).toContain("setup left files git tracks");
    expect(report).toContain("generated.txt");
  });

  test("SETUP: none skips the auto setup", async () => {
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: withSetup("none"), repo, profile });
    rmSync(join(repo, "bun.lock"));
    expect(state?.status).toBe("complete");
    expect(report).toContain("SETUP: none");
  });
});

describe("lane depth", () => {
  test("a worker (ORCH_LANE=1) cannot start a lane: no worktree, no worker", async () => {
    fake("codex", "echo hi > out.txt");
    const before = sh(repo, "git branch --list 'lane/*'").stdout;
    process.env.ORCH_LANE = "1";
    try {
      const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo, profile });
      expect(state).toBeUndefined();
      expect(report).toContain("STATUS: refused-by-lane");
      expect(report).toContain("cannot start a lane");
    } finally {
      delete process.env.ORCH_LANE;
    }
    expect(sh(repo, "git branch --list 'lane/*'").stdout).toBe(before);
  });

  test("a worker (ORCH_LANE=1) cannot start a review or launch its harness", async () => {
    const marker = join(root, "review-depth-launched");
    fake("codex", `touch ${marker}`);
    process.env.ORCH_LANE = "1";
    try {
      const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile });
      expect(report).toContain("LANE REVIEW\nSTATUS: refused-by-lane");
      expect(report).toContain("REASON: max_depth");
    } finally {
      delete process.env.ORCH_LANE;
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a review is unavailable while all slots are held", async () => {
    const marker = join(root, "review-slot-launched");
    fake("codex", `touch ${marker}`);
    const held: number[] = [];
    try {
      for (let i = 0; i < profile.limits.max_concurrent; i++) held.push(reserveSlot(process.env.ORCH_STATE!, profile.limits.max_concurrent, `held-${i}`)!);
      const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile });
      expect(report).toBe(`LANE REVIEW\nSTATUS: unavailable\nREASON: ${profile.limits.max_concurrent} lanes already running\n`);
    } finally {
      for (const slot of held) releaseSlot(process.env.ORCH_STATE!, slot);
    }
    expect(existsSync(marker)).toBe(false);
  });
});

test("review defaults --from to ORCH_HARNESS when it is valid", () => {
  fake("claude", "echo review");
  const result = spawnSync(process.execPath, ["src/lane.ts", "review", "--base", "HEAD", "--goal", "review"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    env: { ...process.env, ORCH_HARNESS: "codex" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("REVIEWER: claude · opus");
});

test("review --to takes the model of an entry aimed at that harness, never another harness's id", async () => {
  const argvFile = join(root, "review-to-argv");
  fake("codex", `echo "$@" > ${argvFile}`);
  const report = await laneReview({ from: "codex", to: "codex", base: "HEAD", goal: "review", repo, profile });
  expect(report).toContain("REVIEWER: codex · gpt-6-luna");
  expect(readFileSync(argvFile, "utf8")).not.toContain("opus");
});

test("review risk picks the reviewer: normal is the base choice, high its override", async () => {
  const argvFile = join(root, "review-argv");
  fake("codex", `echo "$@" > ${argvFile}`);
  const normal = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile });
  expect(normal).toContain("REVIEWER: codex · gpt-6-luna · effort xhigh · risk normal");
  expect(readFileSync(argvFile, "utf8")).toContain("gpt-6-luna");
  const high = await laneReview({ from: "claude", base: "HEAD", goal: "review", repo, profile, risk: "high" });
  expect(high).toContain("REVIEWER: codex · gpt-6.1-sol · effort medium · risk high");
  expect(readFileSync(argvFile, "utf8")).toContain("gpt-6.1-sol");
});

describe("snapshot and setup hardening (review findings)", () => {
  const fresh = (name: string) => {
    const r = join(root, name);
    mkdirSync(r);
    sh(r, "git init -q && echo base > a.txt && printf 'ignored/\\n' > .gitignore && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init");
    return r;
  };

  test("force-added ignored files and untracked files survive status.showUntrackedFiles=no; the caller index is byte-identical", async () => {
    const r = fresh("snap-index");
    mkdirSync(join(r, "ignored"));
    writeFileSync(join(r, "ignored", "fixture.txt"), "forced\n");
    sh(r, "git add -f ignored/fixture.txt && git config status.showUntrackedFiles no");
    writeFileSync(join(r, "new.txt"), "untracked\n");
    const indexBefore = readFileSync(join(r, ".git", "index"));
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(readFileSync(join(state!.worktree, "ignored", "fixture.txt"), "utf8")).toBe("forced\n");
    expect(readFileSync(join(state!.worktree, "new.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(r, ".git", "index")).equals(indexBefore)).toBe(true);
  });

  test("a dirty submodule is refused instead of silently dropped", async () => {
    const sub = fresh("snap-sub-src");
    const r = fresh("snap-super");
    sh(r, `git -c protocol.file.allow=always submodule add -q ${sub} dep && git -c user.email=t@t -c user.name=t commit -q -m sub`);
    writeFileSync(join(r, "dep", "a.txt"), "edited inside the submodule\n");
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(state).toBeUndefined();
    expect(report).toContain("dirty submodule dep");
  });

  test("an edited assume-unchanged file reaches the snapshot; the caller's bit stays set", async () => {
    const r = fresh("snap-assume");
    sh(r, "git update-index --assume-unchanged a.txt");
    writeFileSync(join(r, "a.txt"), "edited under assume-unchanged\n");
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(readFileSync(join(state!.worktree, "a.txt"), "utf8")).toBe("edited under assume-unchanged\n");
    expect(sh(r, "git ls-files -v a.txt").stdout.trim()).toBe("h a.txt");
  });

  test("an edit to a file both assume-unchanged and skip-worktree reaches the snapshot", async () => {
    const r = fresh("snap-both-flags");
    sh(r, "git update-index --assume-unchanged a.txt && git update-index --skip-worktree a.txt");
    expect(sh(r, "git ls-files -v a.txt").stdout.trim()).toBe("s a.txt");
    writeFileSync(join(r, "a.txt"), "edited under both flags\n");
    fake("codex", "echo hi > out.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(readFileSync(join(state!.worktree, "a.txt"), "utf8")).toBe("edited under both flags\n");
  });

  test("hidden edits count toward the snapshot budget next to visible ones", async () => {
    const r = fresh("snap-budget-hidden");
    sh(r, "git update-index --assume-unchanged a.txt");
    writeFileSync(join(r, "a.txt"), "hidden edit\n");
    writeFileSync(join(r, "new.txt"), "visible\n");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      expect((await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile })).report).toContain("(2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("gc keeps a worktree with untracked work even under status.showUntrackedFiles=no", async () => {
    const r = fresh("gc-untracked");
    fake("codex", "true");
    const { state } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(state?.status).toBe("noop");
    sh(r, "git config status.showUntrackedFiles no");
    writeFileSync(join(state!.worktree, "work.txt"), "unsaved work\n");
    expect(laneGc()).toContain(`kept ${state!.id} (dirty worktree)`);
    expect(existsSync(join(state!.worktree, "work.txt"))).toBe(true);
  });

  test("a rejecting pre-commit hook fails the lane and gc keeps its dirty worktree", async () => {
    const r = fresh("commit-hook");
    const hook = join(r, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho pre-commit rejected >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    fake("codex", "echo hi > out.txt");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f out.txt"), repo: r, profile });
    expect(state?.status).toBe("failed");
    expect(state?.reason).toContain("pre-commit rejected");
    expect(report).toContain("STATUS: failed");
    expect(report).toContain("REASON: git commit failed:");
    expect(report).toContain("pre-commit rejected");
    expect(laneGc()).toContain(`kept ${state!.id} (dirty worktree)`);
    expect(existsSync(state!.worktree)).toBe(true);
  });

  test("a dirty submodule with a non-ASCII name is refused too", async () => {
    const sub = fresh("snap-sub2-src");
    const r = fresh("snap-super2");
    sh(r, `git -c protocol.file.allow=always submodule add -q ${sub} dép && git -c user.email=t@t -c user.name=t commit -q -m sub`);
    writeFileSync(join(r, "dép", "a.txt"), "edited\n");
    const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
    expect(report).toContain("dirty submodule dép");
  });

  test("tracked edits count toward the snapshot budget", async () => {
    const r = fresh("snap-budget-tracked");
    writeFileSync(join(r, "a.txt"), "edited tracked file\n");
    writeFileSync(join(r, "new.txt"), "untracked\n");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      expect((await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile })).report).toContain("(2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("status paths skip the origin entry of a rename", () => {
    expect(statusPaths(["R  new.txt", "old.txt", " M a.txt", "?? b c.txt"])).toEqual(["new.txt", "a.txt", "b c.txt"]);
  });

  test("the snapshot budget refuses an oversized untracked tree", async () => {
    const r = fresh("snap-budget");
    writeFileSync(join(r, "x1.bin"), "1");
    writeFileSync(join(r, "x2.bin"), "2");
    const saved = SNAPSHOT_LIMITS.files;
    SNAPSHOT_LIMITS.files = 1;
    try {
      const { report } = await laneRun({ to: "codex", specPath: spec("true"), repo: r, profile });
      expect(report).toContain("changes too large to snapshot (2 files");
    } finally {
      SNAPSHOT_LIMITS.files = saved;
    }
  });

  test("a SETUP that commits is refused, and a failed setup is left for lane gc", async () => {
    const r = fresh("setup-commit");
    const p = join(root, "spec-setup-commit.txt");
    writeFileSync(p, `${SPEC("true")}SETUP: echo x > gen.txt && git add gen.txt && git -c user.email=t@t -c user.name=t commit -q -m gen\n`);
    fake("codex", "echo hi > out.txt");
    const { report } = await laneRun({ to: "codex", specPath: p, repo: r, profile });
    expect(report).toContain("setup made a commit in the worktree");
    const id = /lanes\/([^/]+)\/setup\.log/.exec(report)![1];
    expect(laneGc().join("\n")).toContain(`removed ${id}`);
  });

  test("the local setup script runs as argv, never through a shell string", () => {
    const r = join(root, "repo $(touch pwned) `id`");
    mkdirSync(join(r, ".orch"), { recursive: true });
    writeFileSync(join(r, ".orch", "lane-setup"), "true\n");
    const cmd = setupCommand({ raw: "", fields: {} }, r);
    expect(cmd?.argv).toEqual(["sh", join(r, ".orch", "lane-setup")]);
  });

  test("the snapshot integration patch carries binary changes", async () => {
    const r = fresh("snap-binary");
    writeFileSync(join(r, "dirty.txt"), "dirty\n");
    fake("codex", "printf '\\000\\001\\002' > blob.bin");
    const { report, state } = await laneRun({ to: "codex", specPath: spec("test -f blob.bin"), repo: r, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain("git diff --binary --no-ext-diff --no-textconv");
    const target = fresh("snap-binary-target");
    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    const applied = sh(target, `git -C ${r} diff --binary --no-ext-diff --no-textconv ${state!.base} ${state!.branch} | git apply`);
    expect(applied.status).toBe(0);
    expect(readFileSync(join(target, "blob.bin")).equals(Buffer.from([0, 1, 2]))).toBe(true);
  });
});

describe("grok profile guard", () => {
  test("a Grok lane fails closed without orch's exact orch-lane profile in the user file", async () => {
    const savedHome = process.env.HOME;
    const home = join(root, "grok-home");
    mkdirSync(join(home, ".grok"), { recursive: true });
    fake("grok", "echo hi > out.txt");
    process.env.HOME = home;
    try {
      // missing, then defined by someone else under the same name
      for (const content of [null, '[profiles.orch-lane]\nextends = "devbox"\n']) {
        if (content !== null) writeFileSync(join(home, ".grok", "sandbox.toml"), content);
        const { report, state } = await laneRun({ to: "grok", specPath: spec("test -f out.txt"), repo, profile });
        expect(state).toBeUndefined();
        expect(report).toContain("missing or modified");
      }
      writeFileSync(join(home, ".grok", "sandbox.toml"), readFileSync(join(import.meta.dir, "..", "catalog", "grok-sandbox.toml"), "utf8"));
      const ok = await laneRun({ to: "grok", specPath: spec("test -f out.txt"), repo, profile });
      expect(ok.state?.status).toBe("complete");
      // the worker ran from a read-only pinned copy under the lane state dir, not from PATH
      const real = statSync(join(root, "bin", "grok"));
      const pinned = join(process.env.ORCH_STATE!, "bin", `grok-${real.size}-${Math.trunc(real.mtimeMs)}`);
      expect(existsSync(pinned)).toBe(true);
      expect(statSync(pinned).mode & 0o777).toBe(0o555);
      // an older pinned version is pruned by lane gc, the current one kept
      writeFileSync(join(process.env.ORCH_STATE!, "bin", "grok-old-1-1"), "old");
      expect(laneGc().join("\n")).toContain("removed pinned grok-old-1-1");
      expect(existsSync(pinned)).toBe(true);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});
