// Real incidents replayed end to end: one describe per incident, through the
// real lane, gate and orch serve verify (orch task adopt) paths, with fake binaries only (no model,
// no Docker, no network). Add a case here whenever an incident reaches the
// operator, so the same class of failure fails `make check` first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, type Profile } from "../../../src/core/profile.ts";
import { writePulse } from "../../../src/core/lead-pulse.ts";
import { projectDir } from "../../../src/core/project.ts";
import { laneAuto, laneIntegrate, laneRun, listLanes } from "../../../src/lane.ts";

const keys = ["PATH", "HOME", "ORCH_HOME", "ORCH_STATE", "ORCH_LANE", "ORCH_LEAD", "ORCH_HARNESS", "ORCH_LEAD_PID", "ORCH_PROFILE", "ORCH_POLICY"];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const loaded = loadProfile("max20");
const profile: Profile = { ...loaded, limits: { ...loaded.limits, report_max_bytes: 8192, timeout_seconds: 30 } };
let root: string, repo: string, bin: string, state: string, dockerCalls: string;

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const commit = (msg: string) => sh(repo, `git add -A && git -c user.email=t@t -c user.name=t commit -qm '${msg}'`);
function fakeBin(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}
// A Claude worker that edits FILES then ends with the given LANE line.
function claudeWorker(finish: string) {
  fakeBin("claude", `cat >/dev/null 2>&1
echo "pause first" > purge.txt
printf '\\n{"type":"result","session_id":"s-incident","result":"%s"}\\n' 'Edited purge.txt; make test is denied: permission denied /var/run/docker.sock.\\n${finish}'`);
}
function spec(verify: string) {
  const p = join(root, `spec-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(p, `OBJECTIVE: skip the purge while scraping is paused\nFILES: purge.txt\nINTERFACES: none\nCONSTRAINTS: none\nVERIFY: ${verify}\nACCEPT: purge.txt says pause first\n`);
  return p;
}
const leadIn = (mode: string) => {
  process.env.ORCH_LEAD_PID = String(process.pid);
  writePulse(process.pid, "busy", state, new Date(), mode);
};

beforeAll(() => {
  // ORCH_HOME wins over HOME for ~/.orch: unset, so lane-setup lands in the temp home.
  for (const k of ["ORCH_HOME", "ORCH_LANE", "ORCH_LEAD", "ORCH_HARNESS", "ORCH_LEAD_PID", "ORCH_POLICY"]) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), "orch-incidents-"));
  repo = join(root, "core");
  bin = join(root, "bin");
  state = join(root, "state");
  dockerCalls = join(root, "docker-calls.log");
  for (const d of [repo, bin, state, join(root, "home")]) mkdirSync(d, { recursive: true });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = join(root, "home");
  process.env.ORCH_STATE = state;
  process.env.ORCH_PROFILE = "kiba";
  // The operator's stack: `make test` enters the running `core` container,
  // which mounts the main checkout. The fake docker is green whatever the
  // lane changed, exactly like the real container was.
  fakeBin("docker", `echo "$PWD $*" >> ${dockerCalls}\necho 'OK (10 tests, 46 assertions)'`);
  writeFileSync(join(repo, "Makefile"), "COMPOSE := docker compose -f @docker/local/compose.yaml\ntest:\n\t@$(COMPOSE) exec -T core php vendor/bin/phpunit $(TEST_ARGS)\n");
  writeFileSync(join(repo, "purge.txt"), "purge always\n");
  sh(repo, "git init -q -b main");
  commit("init");
}, 30_000);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("2026-11-02 core, DEV-IAU-699: a green VERIFY from the main checkout's container was integrated", () => {
  test("orch serve's verify step (orch task adopt) fails a VERIFY that enters a running container, without running it", async () => {
    const wt = join(root, "adopt-wt");
    sh(repo, `git worktree add -q -b work/699 ${wt} main`);
    writeFileSync(join(wt, "purge.txt"), "pause first\n");
    const r = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "../../../src/orch.ts"), "task", "adopt", "--worktree", wt, "--files", "purge.txt",
      "--verify", `make test TEST_ARGS="--filter 'PurgeStale'"`, "--goal", "skip the purge while scraping is paused", "--base-branch", "main"], { cwd: repo, encoding: "utf8", env: process.env });
    expect(r.stdout, r.stderr).toContain("STATUS: failed");
    const id = /^ID: (\S+)/m.exec(r.stdout)![1]!;
    const lane = listLanes(state).find((l) => l.id === id)!;
    expect(lane.verifyOk).toBe(false);
    expect(lane.reason).toContain("outside the worktree: `make test");
    expect(lane.reason).toContain("docker compose -f @docker/local/compose.yaml exec -T core");
    expect(existsSync(dockerCalls)).toBe(false);
    sh(repo, `git worktree remove --force ${wt} && git branch -q -D work/699`);
  }, 30_000);

  test("a lane with that VERIFY fails without running it, and the gate refuses", async () => {
    claudeWorker("LANE: blocked: sandbox denies Docker access");
    const { state: lane, report } = await laneRun({ to: "claude", specPath: spec("make test"), repo, profile });
    // Worker blocked and VERIFY not passed: blocked, never complete.
    expect(lane?.status).toBe("blocked");
    expect(lane?.verifyOk).toBe(false);
    expect(report).toMatch(/^VERIFY: outside the worktree: `make test` -> `docker compose/m);
    // The container never ran: its 10 green tests cannot stand for the lane.
    expect(existsSync(dockerCalls)).toBe(false);
    leadIn("bypassPermissions");
    const gate = await laneIntegrate(lane!.id);
    expect(gate.integrated).toBe(false);
    expect(readFileSync(join(repo, "purge.txt"), "utf8")).toBe("purge always\n");
  }, 30_000);

  test("a lane recorded green before the check is still refused by the gate", async () => {
    claudeWorker("LANE: done");
    const { state: lane } = await laneRun({ to: "claude", specPath: spec("test -f purge.txt"), repo, profile });
    expect(lane?.status).toBe("complete");
    // The record as the old code left it: VERIFY `make test`, verifyOk true.
    const file = join(state, "lanes", lane!.id, "state.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), verify: "make test" }));
    sh(repo, "git checkout -q -b feat/legacy");
    try {
      const gate = await laneIntegrate(lane!.id);
      expect(gate.integrated).toBe(false);
      expect(gate.report).toContain("GATE: VERIFY outside the worktree: `make test`");
    } finally { sh(repo, "git checkout -q main"); }
  }, 30_000);

  test("a worker that reported blocked never lands unattended on the default branch, even with a green VERIFY", async () => {
    claudeWorker("LANE: blocked: sandbox denies Docker access");
    const { state: lane } = await laneRun({ to: "claude", specPath: spec("test -f purge.txt"), repo, profile });
    expect(lane?.status).toBe("complete");
    expect(lane?.reason).toContain("worker blocked: sandbox denies Docker access");
    leadIn("bypassPermissions");
    const refused = await laneIntegrate(lane!.id);
    expect(refused.integrated).toBe(false);
    expect(refused.report).toContain("GATE: worker blocked: sandbox denies Docker access: on main, a lane its worker reported blocked waits for the operator");
    // On a feature branch the operator reviews the uncommitted change: it lands.
    sh(repo, "git checkout -q -b feat/699");
    const landed = await laneIntegrate(lane!.id);
    expect(landed.integrated).toBe(true);
    expect(readFileSync(join(repo, "purge.txt"), "utf8")).toBe("pause first\n");
    sh(repo, "git checkout -q -- . && git checkout -q main");
  }, 30_000);
});

describe("2026-11-02 core: a lane could not test its own worktree (no vendor/, checks in the main container)", () => {
  // The fix lives in the project: its Makefile runs a lane's checks
  // (LANE_WORKTREE set) in a throwaway container of the worktree, and
  // ~/.orch/<project>/lane-setup provisions the worktree first.
  let lanesRepo: string;
  beforeAll(() => {
    lanesRepo = join(root, "core-lanes");
    mkdirSync(lanesRepo);
    // `run` executes in the directory it was started from, as a container
    // binding the worktree does; it needs the .env the setup provides.
    fakeBin("docker", `echo "$PWD $*" >> ${dockerCalls}
case " $* " in
  *" run "*) [ -f .env ] || { echo "no .env: lane-setup did not run" >&2; exit 1; }
    while [ "$1" != core ]; do shift; done; shift; exec "$@" ;;
  *) echo 'OK (10 tests, 46 assertions)' ;;
esac`);
    writeFileSync(join(lanesRepo, "Makefile"), [
      "ifdef LANE_WORKTREE",
      "CHECK := docker compose -f @docker/local/compose.yaml run --rm --no-deps -T -v /app/var core",
      "else",
      "CHECK := docker compose -f @docker/local/compose.yaml exec -T core",
      "endif",
      "test:\n\t@$(CHECK) grep -q 'pause first' purge.txt",
      "",
    ].join("\n"));
    writeFileSync(join(lanesRepo, "purge.txt"), "purge always\n");
    writeFileSync(join(lanesRepo, ".env.test"), "APP_ENV=test\n");
    writeFileSync(join(lanesRepo, ".gitignore"), "/.env\n");
    sh(lanesRepo, "git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init && git checkout -q -b feat/lanes");
    const project = projectDir(lanesRepo);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "lane-setup"), "#!/bin/sh\nset -eu\ncd \"$LANE_WORKTREE\"\n[ -f .env ] || cp .env.test .env\n");
    rmSync(dockerCalls, { force: true });
  });

  test("a lane-aware `make test`: the lane provisions its worktree and VERIFY runs there", async () => {
    claudeWorker("LANE: done");
    const { state: lane, report } = await laneRun({ to: "claude", specPath: spec("make test"), repo: lanesRepo, profile });
    expect(report).toContain("SETUP: ");
    expect(lane?.status).toBe("complete");
    expect(lane?.verifyOk).toBe(true);
    const calls = readFileSync(dockerCalls, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith(`${lane!.worktree} compose -f @docker/local/compose.yaml run --rm`);
  }, 30_000);

  test("the lane's VERIFY sees the lane's code: a wrong change fails", async () => {
    fakeBin("claude", `cat >/dev/null 2>&1
echo "purge anyway" > purge.txt
printf '\\n{"type":"result","session_id":"s-wrong","result":"%s"}\\n' 'Edited purge.txt.\\nLANE: done'`);
    const { state: lane } = await laneRun({ to: "claude", specPath: spec("make test"), repo: lanesRepo, profile });
    expect(lane?.status).toBe("failed");
    expect(lane?.verifyOk).toBe(false);
  }, 30_000);
});

describe("2026-11-02 core: parallel tickets landed mixed and uncommitted in one working tree", () => {
  let ticketsRepo: string, origin: string, ghLog: string;
  beforeAll(() => {
    ticketsRepo = join(root, "core-tickets");
    origin = join(root, "core-tickets.git");
    ghLog = join(root, "gh.log");
    mkdirSync(ticketsRepo);
    writeFileSync(join(ticketsRepo, "purge.txt"), "purge always\n");
    sh(ticketsRepo, `git init -q -b develop && git config user.name t && git config user.email t@t && git add -A && git commit -qm init && git init -q --bare ${origin} && git remote add origin ${origin} && git push -q -u origin develop`);
    // Each worker writes its own ticket into the same file: the worst case for a shared tree.
    fakeBin("claude", `prompt=$(cat)
obj=$(printf '%s\\n' "$prompt" | sed -n 's/^OBJECTIVE: //p' | head -n 1)
echo "$obj" > purge.txt
printf '\\n{"type":"result","session_id":"s-%s","result":"%s"}\\n' "$$" 'Done.\\nLANE: done'`);
    fakeBin("gh", `if [ "$2" = list ]; then echo '[]'; else printf '%s\\n' "$*" >> ${ghLog}; echo "https://github.example/acme/core/pull/$$"; fi`);
  });

  test("three tickets run side by side, each is delivered to its own branch and PR, the checkout never moves", async () => {
    const head = sh(ticketsRepo, "git rev-parse HEAD").stdout.trim();
    const tickets = ["DEV-701", "DEV-702", "DEV-703"];
    const specs = tickets.map((t) => {
      const p = join(root, `spec-${t}.md`);
      writeFileSync(p, `OBJECTIVE: ticket ${t}\nFILES: purge.txt\nINTERFACES: none\nCONSTRAINTS: none\nVERIFY: grep -q ${t} purge.txt\nACCEPT: purge.txt names ${t}\n`);
      return p;
    });
    // orch serve's path: lane auto --no-integrate, three at once.
    const runs = await Promise.all(specs.map((specPath) => laneAuto({ specPath, repo: ticketsRepo, profile, to: "claude", integrate: false })));
    for (const r of runs) {
      expect(r.integrated).toBe(false);
      expect(r.report).toMatch(/^STATUS: complete$/m);
      expect(r.report).toContain("NEXT: deliver it: lane integrate ");
    }
    expect(sh(ticketsRepo, "git status --porcelain").stdout).toBe("");
    // The outbox's delivery, the same lane integrate --branch --message: one branch per ticket.
    const ids = runs.map((r) => /^ID: (\S+)/m.exec(r.report)![1]!);
    for (const [i, t] of tickets.entries()) {
      const res = await laneIntegrate(ids[i]!, { branch: `fix/${t}-purge`, message: `fix(market): ${t} purge rule (${t})\n\nWhy.` });
      expect(res.integrated).toBe(true);
      expect(res.report).toContain(`INTO: fix/${t}-purge (delivered;`);
      expect(res.report).toMatch(/^PR: https:\/\/github\.example\/acme\/core\/pull\/\d+ \(into develop;/m);
    }
    for (const t of tickets) {
      expect(sh(origin, `git show fix/${t}-purge:purge.txt`).stdout).toBe(`ticket ${t}\n`);
      expect(sh(ticketsRepo, `git rev-list --count develop..fix/${t}-purge`).stdout.trim()).toBe("1");
    }
    expect(readFileSync(ghLog, "utf8").trim().split("\n")).toHaveLength(3);
    expect(sh(ticketsRepo, "git rev-parse HEAD").stdout.trim()).toBe(head);
    expect(sh(ticketsRepo, "git status --porcelain").stdout).toBe("");
    expect(readFileSync(join(ticketsRepo, "purge.txt"), "utf8")).toBe("purge always\n");
    expect(listLanes(state).filter((l) => ids.includes(l.id))).toEqual([]);
  }, 60_000);
});

