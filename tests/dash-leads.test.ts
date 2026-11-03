import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDash } from "../src/dash/collect.ts";
import { discoverLeads, hasLeadAgent, isLeadPrompt, isLeadLauncher, leadsFromProc, mergeLeads, parseProcStat, projectFromCwd } from "../src/dash/leads.ts";
import { loadProfile } from "../src/core/profile.ts";
import type { DashLead } from "../src/dash/types.ts";

const BTIME = 1_700_000_000;
const NOW = new Date((BTIME + 3_600) * 1000);
const LAB = "/home/kev/lab";
const HOME = "/home/kev";
const ORCH = "/home/kev/.orch";
const PROJECTS = ["lab", "front", "notes", "docs", "api", "core", "acme-front"];

const scan = (over: Parameters<typeof leadsFromProc>[0] = {}) => leadsFromProc({
  procRoot: proc,
  labRoot: LAB,
  projects: PROJECTS,
  orchRoot: ORCH,
  home: HOME,
  now: NOW,
  hz: 100,
  ...over,
});

let root: string;
let proc: string;

function fakeStat(pid: number, comm: string, ppid: number, starttime: number): string {
  const mid = Array(17).fill("0").join(" ");
  return `${pid} (${comm}) S ${ppid} ${mid} ${starttime} 0 0 0 0 0\n`;
}

function writeProc(pid: number, opts: {
  comm: string;
  argv: string[];
  cwd?: string;
  ppid?: number;
  starttime?: number;
  environ?: string[];
}) {
  const dir = join(proc, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comm"), `${opts.comm}\n`);
  writeFileSync(join(dir, "cmdline"), `${opts.argv.join("\0")}\0`);
  writeFileSync(join(dir, "stat"), fakeStat(pid, opts.comm, opts.ppid ?? 1, opts.starttime ?? 0));
  if (opts.environ) writeFileSync(join(dir, "environ"), `${opts.environ.join("\0")}\0`);
  if (opts.cwd) {
    const target = join(root, "cwds", opts.cwd.replace(/^\//, ""));
    mkdirSync(target, { recursive: true });
    symlinkSync(opts.cwd, join(dir, "cwd"));
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-dash-leads-"));
  proc = join(root, "proc");
  mkdirSync(proc, { recursive: true });
  writeFileSync(join(proc, "stat"), `cpu 1 2 3\nbtime ${BTIME}\n`);
  for (const name of PROJECTS) mkdirSync(join(root, "orch-projects", name), { recursive: true });

  writeProc(1000, {
    comm: "bun",
    argv: ["bun", "--no-env-file", "/workspace/src/lead.ts", "--continue"],
    cwd: LAB,
    ppid: 900,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude", "HOME=/secret-home"],
  });
  writeProc(1001, {
    comm: "claude",
    argv: [
      "claude", "--agent", "kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "opus", "--effort", "high",
      "--permission-mode", "bypassPermissions", "--continue",
    ],
    cwd: LAB,
    ppid: 1000,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude", "ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx"],
  });

  writeProc(2000, {
    comm: "bun",
    argv: ["bun", "--no-env-file", "/home/kev/.local/bin/kiba", "codex", "--yolo"],
    cwd: `${LAB}/front`,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=codex", "HOME=/secret-home"],
  });
  writeProc(2001, {
    comm: "codex",
    argv: [
      "codex",
      "-c", 'developer_instructions="## Who you are\n\nYou are Kiba, the operator\'s lead developer."',
      "-c", "model_reasoning_effort=\"high\"",
      "--model", "gpt-5.1",
      "--yolo",
    ],
    cwd: `${LAB}/front`,
    ppid: 2000,
    environ: ["HOME=/secret-home"],
  });

  writeProc(3000, {
    comm: "claude",
    argv: [
      "claude", "--agent", "kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "opus", "--effort", "high",
      "--permission-mode", "bypassPermissions",
    ],
    cwd: `${LAB}/notes`,
  });
  writeProc(3001, {
    comm: "claude",
    argv: [
      "claude", "--agent=kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "sonnet", "--effort", "medium",
      "--permission-mode", "bypassPermissions", "--continue",
    ],
    cwd: `${LAB}/notes/src`,
  });

  writeProc(4000, {
    comm: "claude",
    argv: ["claude", "-p", "bench prompt"],
    cwd: `${LAB}/orch`,
    environ: ["ORCH_BENCH_RUN=run-1", "ORCH_LEAD=1", "ORCH_HARNESS=claude"],
  });
  writeProc(4001, {
    comm: "codex",
    argv: ["codex", "app-server"],
    cwd: "/tmp/codex-daemon",
  });
  writeProc(4002, {
    comm: "docker-proxy",
    argv: ["docker-proxy", "-proto", "tcp"],
    cwd: "/var/lib/docker",
  });
  writeProc(4003, {
    comm: "claude",
    argv: ["claude"],
    cwd: `${LAB}/front`,
  });
  writeProc(4004, {
    comm: "remote-control",
    argv: ["/usr/bin/remote-control", "--listen"],
    cwd: LAB,
    environ: ["ORCH_LEAD=1"],
  });
  writeProc(5000, {
    comm: "grok",
    argv: ["grok", "--agent", "kiba", "--trust", "--model", "grok-4", "--reasoning-effort", "high"],
    cwd: `${LAB}/docs`,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=grok"],
  });
  writeProc(6000, {
    comm: "node",
    argv: ["node", "some-script.js"],
    cwd: `${LAB}/api`,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude"],
  });
  writeProc(7000, {
    comm: "zsh",
    argv: ["zsh"],
    cwd: HOME,
    environ: ["ORCH_LEAD=1"],
  });

  writeProc(2414, {
    comm: "claude",
    argv: [
      "claude", "--agent", "kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "opus", "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--continue", "--remote-control", "kiba",
    ],
    cwd: LAB,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude"],
  });
  writeProc(589332, {
    comm: "tmux: server",
    argv: ["tmux"],
    cwd: `${LAB}/perso/marketplace/acme/others/core`,
  });
  writeProc(589366, {
    comm: "claude",
    argv: [
      "claude", "--agent", "kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "opus", "--effort", "high",
      "--permission-mode", "bypassPermissions",
    ],
    cwd: `${LAB}/perso/marketplace/acme/others/core`,
    ppid: 589332,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude"],
  });
  writeProc(500027, {
    comm: "claude",
    argv: [
      "claude", "--agent", "kiba",
      "--settings", "/home/kev/.claude/orch/lead-settings.json",
      "--model", "opus", "--effort", "high",
      "--permission-mode", "bypassPermissions",
    ],
    cwd: `${LAB}/perso/marketplace/acme/acme-front`,
    environ: ["ORCH_LEAD=1", "ORCH_HARNESS=claude"],
  });
  writeProc(500316, {
    comm: "ghostchrome-mcp",
    argv: ["ghostchrome-mcp", "--stealth"],
    cwd: `${LAB}/perso/marketplace/acme/acme-front`,
    ppid: 500027,
    environ: ["ORCH_LEAD=1", "HOME=/secret-home"],
  });
  writeProc(589573, {
    comm: "ghostchrome-mcp",
    argv: ["ghostchrome-mcp", "--stealth"],
    cwd: `${LAB}/perso/marketplace/acme/others/core`,
    ppid: 589366,
    environ: ["ORCH_LEAD=1"],
  });
  writeProc(1886970, {
    comm: "zsh",
    argv: ["/usr/bin/zsh", "-c", "source ~/.claude/shell-snapshots/snap.sh"],
    cwd: `${ORCH}/core/wt-681-base`,
    ppid: 589366,
    environ: ["ORCH_LEAD=1"],
  });
  writeProc(1887022, {
    comm: "time",
    argv: ["/usr/bin/time", "-f", "WALL=%e", "make", "preprod-deploy"],
    cwd: `${ORCH}/core/wt-681-base`,
    ppid: 1886970,
    environ: ["ORCH_LEAD=1"],
  });
  writeProc(1889534, {
    comm: "make",
    argv: ["make", "preprod-deploy"],
    cwd: `${ORCH}/core/wt-681-base`,
    ppid: 1887022,
    environ: ["ORCH_LEAD=1"],
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("proc parsers", () => {
  test("project is the nearest known root, git root, worktree or home — never perso", () => {
    const opts = { labRoot: LAB, projects: PROJECTS, orchRoot: ORCH, home: HOME };
    expect(projectFromCwd(`${LAB}`, opts)).toBe("lab");
    expect(projectFromCwd(`${LAB}/front`, opts)).toBe("front");
    expect(projectFromCwd(`${LAB}/front/src`, opts)).toBe("front");
    expect(projectFromCwd(`${LAB}/perso/marketplace/acme/acme-front`, opts)).toBe("acme-front");
    expect(projectFromCwd(`${LAB}/perso/marketplace/acme/others/core`, opts)).toBe("core");
    expect(projectFromCwd(`${ORCH}/core/wt-681-base`, opts)).toBe("core");
    expect(projectFromCwd(`${ORCH}/core/wt-681-base/src`, opts)).toBe("core");
    expect(projectFromCwd(HOME, opts)).toBe("home");
    expect(projectFromCwd("/tmp/elsewhere", opts)).toBe("elsewhere");
    expect(projectFromCwd(`${LAB}/perso/marketplace/acme/acme-front`, opts)).not.toBe("perso");
    const gitRoot = join(root, "git-core");
    mkdirSync(join(gitRoot, ".git"), { recursive: true });
    mkdirSync(join(gitRoot, "src"), { recursive: true });
    expect(projectFromCwd(join(gitRoot, "src"), { labRoot: root, home: HOME })).toBe("git-core");
  });

  test("recognizes the live argv shapes and ignores noise", () => {
    expect(hasLeadAgent(["claude", "--agent", "kiba"])).toBe(true);
    expect(isLeadLauncher(["bun", "--no-env-file", "/home/kev/.local/bin/kiba", "codex", "--yolo"])).toBe(true);
    expect(isLeadPrompt(["codex", "-c", 'developer_instructions="## Who you are"'])).toBe(true);
    expect(isLeadPrompt(["codex", "-c", "developer_instructions=other tool"])).toBe(false);
    expect(parseProcStat(fakeStat(9, "claude", 8, 12))).toEqual({ pid: 9, comm: "claude", ppid: 8, starttime: 12 });
  });
});

describe("leadsFromProc", () => {
  test("finds manual claude, kiba+codex (deduped), grok; ORCH_LEAD alone is not a lead", () => {
    const { leads, parents } = scan();
    const raw = JSON.stringify(leads);
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toContain("/secret-home");
    expect(raw).not.toContain("ANTHROPIC_API_KEY");
    expect(raw).not.toContain("ORCH_LEAD=1");
    expect(parents.get(2001)).toBe(2000);
    expect(parents.get(1001)).toBe(1000);

    const byPid = new Map(leads.map((row) => [row.pid, row]));
    expect(byPid.has(4000)).toBe(false);
    expect(byPid.has(4001)).toBe(false);
    expect(byPid.has(4002)).toBe(false);
    expect(byPid.has(4003)).toBe(false);
    expect(byPid.has(4004)).toBe(false);
    expect(byPid.has(2000)).toBe(false);
    expect(byPid.has(6000)).toBe(false);
    expect(byPid.has(7000)).toBe(false);
    expect(byPid.has(500316)).toBe(false);
    expect(byPid.has(589573)).toBe(false);
    expect(byPid.has(1886970)).toBe(false);
    expect(byPid.has(1887022)).toBe(false);
    expect(byPid.has(1889534)).toBe(false);

    expect(byPid.get(1001)).toMatchObject({
      project: "lab",
      harness: "claude",
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
      supervised: false,
    });
    expect(byPid.get(2001)).toMatchObject({
      project: "front",
      harness: "codex",
      model: "gpt-5.1",
      effort: "high",
      permissionMode: "yolo",
      supervised: false,
    });
    expect(byPid.get(3000)?.project).toBe("notes");
    expect(byPid.get(3001)?.project).toBe("notes");
    expect(byPid.get(5000)).toMatchObject({ project: "docs", harness: "grok", model: "grok-4", effort: "high" });
    expect(byPid.get(1001)?.started).toBe(new Date(BTIME * 1000).toISOString());
    expect(byPid.get(1001)?.uptimeSec).toBe(3600);
  });

  test("host tree: one lead per process tree, project from nearest root, busy from children", () => {
    const { leads } = scan();
    const ids = leads.map((row) => row.id);
    expect(ids.some((id) => id.includes("perso"))).toBe(false);
    expect(ids.some((id) => id.includes("kev"))).toBe(false);
    expect(ids.some((id) => id.includes("wt-"))).toBe(false);

    const core = leads.find((row) => row.pid === 589366);
    expect(core).toMatchObject({
      id: "kiba:core",
      project: "core",
      harness: "claude",
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
      supervised: false,
      activity: "busy",
      cwd: `${LAB}/perso/marketplace/acme/others/core`,
    });

    const front = leads.find((row) => row.pid === 500027);
    expect(front).toMatchObject({
      id: "kiba:acme-front",
      project: "acme-front",
      permissionMode: "bypassPermissions",
      model: "opus",
      effort: "high",
      // its only child is an MCP server, alive for the whole session: not work
      activity: "idle",
    });

    const lab = leads.filter((row) => row.project === "lab");
    expect(lab.some((row) => row.pid === 2414 && row.remoteControl)).toBe(true);
    expect(leads.filter((row) => row.project === "home")).toEqual([]);
  });

  test("the lead's own pulse (hooks) decides busy or idle over its children", () => {
    const idle = scan({ pulse: (pid) => (pid === 589366 ? "idle" : null) }).leads.find((row) => row.pid === 589366);
    expect(idle?.activity).toBe("idle");
    const busy = scan({ pulse: (pid) => (pid === 500027 ? "busy" : null) }).leads.find((row) => row.pid === 500027);
    expect(busy?.activity).toBe("busy");
  });

  test("a word kiba in arguments is not a launcher: tmux session name, the MCP server", () => {
    expect(isLeadLauncher(["/home/kev/.local/bin/kiba"])).toBe(true);
    expect(isLeadLauncher(["bun", "--no-env-file", "/opt/orch/src/lead.ts", "codex"])).toBe(true);
    expect(isLeadLauncher(["tmux", "-L", "orch", "new-session", "-d", "-s", "kiba"])).toBe(false);
    expect(isLeadLauncher(["bun", "--no-env-file", "/opt/orch/src/orch.ts", "kiba", "mcp"])).toBe(false);
  });

  test("no-ops when /proc is missing", () => {
    expect(leadsFromProc({ procRoot: join(root, "no-proc") }).leads).toEqual([]);
    expect(leadsFromProc({ procRoot: null }).leads).toEqual([]);
  });
});

describe("discoverLeads merge", () => {
  test("presence and its claude child become one supervised lead; extras keep #pid", () => {
    const presence: DashLead[] = [{
      id: "kiba:lab",
      project: "lab",
      pid: 1000,
      harness: "claude",
      model: "claude-opus-4-5",
      effort: "high",
      permissionMode: "bypassPermissions",
      started: "2026-11-01T08:00:00.000Z",
      uptimeSec: 99,
      remoteControl: true,
      supervised: true,
      cwd: LAB,
      activity: "idle",
    }];
    const leads = discoverLeads({
      presence,
      presencePids: [1000],
      procRoot: proc,
      labRoot: LAB,
      projects: PROJECTS,
      orchRoot: ORCH,
      home: HOME,
      now: NOW,
    });
    const lab = leads.filter((row) => row.project === "lab");
    const supervised = lab.find((row) => row.supervised);
    expect(supervised).toMatchObject({
      id: lab.length > 1 ? "kiba:lab#1001" : "kiba:lab",
      pid: 1001,
      supervised: true,
      remoteControl: true,
      model: "opus",
      started: "2026-11-01T08:00:00.000Z",
    });
    expect(lab.some((row) => row.pid === 2414 && row.remoteControl && !row.supervised)).toBe(true);
    const notes = leads.filter((row) => row.project === "notes").sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0));
    expect(notes.map((row) => row.id)).toEqual(["kiba:notes#3000", "kiba:notes#3001"]);
    expect(leads.find((row) => row.project === "front")).toMatchObject({
      id: "kiba:front",
      pid: 2001,
      harness: "codex",
      permissionMode: "yolo",
      supervised: false,
    });
  });

  test("merge prefers the presence-descendant proc lead over unrelated same-project leads", () => {
    const presence: DashLead[] = [{
      id: "kiba:lab",
      project: "lab",
      pid: 1000,
      harness: "claude",
      model: "claude-opus-4-5",
      effort: "high",
      permissionMode: "bypassPermissions",
      started: "2026-11-01T08:00:00.000Z",
      uptimeSec: 99,
      remoteControl: true,
      supervised: true,
      cwd: LAB,
      activity: "idle",
    }];
    const merged = mergeLeads({
      presence,
      presencePids: [1000],
      parents: new Map<number, number>([
        [1001, 1000], // descendant of presence root
        [2414, 1], // unrelated but same project/cwd
      ]),
      proc: [
        { ...presence[0], id: "kiba:lab#2414", pid: 2414, supervised: false, remoteControl: true },
        { ...presence[0], id: "kiba:lab#1001", pid: 1001, supervised: false, remoteControl: false },
      ],
    });
    expect(merged.find((row) => row.supervised)?.pid).toBe(1001);
    expect(merged.some((row) => row.pid === 2414 && !row.supervised)).toBe(true);
  });

  test("a presence lead with no living process is not shown once /proc was scanned", () => {
    const presence: DashLead[] = [{
      id: "kiba:docs", project: "docs", pid: 999_999, harness: "claude", model: "opus", effort: "high",
      permissionMode: null, started: null, uptimeSec: null, remoteControl: false, supervised: true, cwd: "/nowhere/docs", activity: "idle",
    }];
    expect(mergeLeads({ presence, presencePids: [999_999], proc: [], procScanned: true })).toEqual([]);
    expect(mergeLeads({ presence, presencePids: [999_999], proc: [] }).map((row) => row.project)).toEqual(["docs"]);
  });

  test("discoverLeads is hermetic with fake procRoot even when host has a dummy claude-like process", async () => {
    const dummy = spawn("bash", ["-lc", "exec -a claude sleep 2"], { stdio: "ignore" });
    try {
      const leads = discoverLeads({
        presence: [],
        procRoot: proc,
        labRoot: LAB,
        projects: PROJECTS,
        orchRoot: ORCH,
        home: HOME,
        now: NOW,
      });
      expect(leads.some((row) => row.pid === 1001 && row.project === "lab")).toBe(true);
      expect(leads.some((row) => row.pid === dummy.pid)).toBe(false);
    } finally {
      try { dummy.kill("SIGKILL"); } catch { /* no-op */ }
    }
  });

  test("collectDash wires the scan when leads are not injected", () => {
    const isolatedHome = join(root, "home");
    mkdirSync(isolatedHome, { recursive: true });
    const snap = collectDash({
      policy: { spend: { daily_usd: 8, embed_usd_per_million: 0.02, plan_tokens: null }, paid_routines: [] },
      machine: { cores: 2, memAvailableGib: 4 },
      limits: loadProfile("max20").limits,
      now: NOW,
      lanes: [],
      ledger: [],
      spendUsed: 0,
      planUsed: 0,
      projectsRoot: join(root, "orch-projects"),
      busRoot: join(root, "missing-bus"),
      procRoot: proc,
      labRoot: LAB,
      orchRoot: ORCH,
      home: isolatedHome,
      claudeProjects: join(root, "empty-claude"),
      logs: [],
      skills: [],
      installed: ["claude", "codex", "grok"],
      hostName: "kev",
    });
    expect(snap.leads.some((row) => row.harness === "codex" && row.permissionMode === "yolo")).toBe(true);
    expect(snap.leads.some((row) => row.id === "kiba:notes#3000")).toBe(true);
    expect(snap.leads.some((row) => row.pid === 589366 && row.project === "core" && row.permissionMode === "bypassPermissions")).toBe(true);
    expect(snap.leads.every((row) => !row.project.includes("perso") && row.project !== "kev")).toBe(true);
    expect(snap.runtimes.find((row) => row.id === "codex")?.online).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("sk-ant-");
    expect(JSON.stringify(snap)).not.toContain("/secret-home");
  });
});
