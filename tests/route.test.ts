import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneAuto, laneGc, laneIntegrate, laneReviewLane, laneRun, listLanes, operatorPoints } from "../src/lane.ts";
import { appendLedger, lastReview, lastVerdict, type LedgerRow, readLedger, type RunRecord } from "../src/lanes/ledger.ts";
import { declaredFiles, inScope, routeEffort, routeReport, routeSpec, specFeatures, type SpecFeatures, DEFAULT_ROUTE } from "../src/lanes/route.ts";
import { parseSpec } from "../src/lanes/spec.ts";
import { loadProfile, type Profile } from "../src/core/profile.ts";
import { withFileLock } from "../src/lanes/lock.ts";
import { roleChoice } from "../src/core/roles.ts";
import { writePulse } from "../src/core/lead-pulse.ts";

const feat = (files: string[], risk: SpecFeatures["risk"] = []): SpecFeatures => ({
  files, stacks: specFeatures(parseSpec(`FILES: ${files.join(", ")}`)).stacks, risk, objective: "x",
});

function run(id: string, to: string, status: RunRecord["status"], stacks = ["typescript"]): RunRecord {
  return { kind: "run", id, at: "", repo: "r", to, model: "m", effort: "e", channel: "headless", status, changed: true, verifyOk: true,
    features: { files: [], stacks, risk: [], objective: "" }, diff: { files: [], insertions: 0, deletions: 0 }, outOfScope: [], durationS: 1, usage: {} };
}

const three = ["src/a.ts", "src/b.ts", "tests/a.test.ts"];

describe("spec features", () => {
  test("FILES accepts bullets, commas, backticks and trailing notes", () => {
    expect(declaredFiles("- `src/a.ts` (new)\n* tests/a.test.ts, README.md\nnothing else\nMakefile")).toEqual(["src/a.ts", "tests/a.test.ts", "README.md", "Makefile"]);
  });

  test("risk comes from paths and from the RISK field, stacks from extensions", () => {
    const f = specFeatures(parseSpec("OBJECTIVE: o\nFILES: db/migrations/001.sql, src/auth/login.ts\nRISK: public-api"));
    expect(f.risk).toEqual(["migration", "security", "public-api"]);
    expect(f.stacks).toEqual(["sql", "typescript"]);
  });

  test("KIND: risky keeps its risk without a risky path: review high", () => {
    const spec = "OBJECTIVE: o\nFILES: src/a.ts, src/b.ts, tests/a.test.ts\nKIND: risky";
    const f = specFeatures(parseSpec(spec));
    expect(f.risk).toEqual(["declared"]);
    expect(routeSpec(f, [], { installed: ["codex", "claude", "grok"] }).review).toBe("high");
    expect(specFeatures(parseSpec("OBJECTIVE: o\nFILES: src/a.ts, src/b.ts, tests/a.test.ts\nRISK: declared")).risk).toEqual(["declared"]);
    const normal = specFeatures(parseSpec("OBJECTIVE: o\nFILES: src/a.ts, src/b.ts, tests/a.test.ts\nKIND: normal"));
    expect(normal.risk).toEqual([]);
    expect(routeSpec(normal, [], { installed: ["codex", "claude", "grok"] }).review).toBe("none");
  });

  test("scope: exact path, directory prefix, globs", () => {
    expect(inScope("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(inScope("src/b.ts", ["src/a.ts"])).toBe(false);
    expect(inScope("src/x/y.ts", ["src/"])).toBe(true);
    expect(inScope("src/x.ts", ["src/*.ts"])).toBe(true);
    expect(inScope("src/x/y.ts", ["src/*.ts"])).toBe(false);
    expect(inScope("src/x/y.ts", ["src/**.ts"])).toBe(true);
  });
});

describe("routeSpec", () => {
  const installed = ["codex", "claude", "grok"] as const;

  test("two declared files or fewer stay with the lead", () => {
    expect(routeSpec(feat(["src/a.ts", "src/b.ts"]), [], { installed: [...installed] }).action).toBe("self");
  });

  test("a lane goes to the first installed harness in the configured order, whatever the record", () => {
    const r = routeSpec(feat(three), [], { installed: ["claude", "grok"] });
    expect(r).toMatchObject({ action: "lane", to: "claude", review: "none" });
    const failing = ["failed", "failed", "failed"].map((st, i) => run(`f${i}`, "codex", st as RunRecord["status"]));
    expect(routeSpec(feat(three), failing, { installed: [...installed] }).to).toBe("codex");
  });

  describe("effort ladder", () => {
    const mech = { ...feat(three), mechanical: true, fingerprint: "f1" };
    const plain = { ...mech, mechanical: false };
    const failedRun = (id: string, fingerprint = "f1"): RunRecord => {
      const r = run(id, "claude", "failed");
      return { ...r, features: { ...r.features, fingerprint } };
    };

    test("default: the profile's medium; a profile xhigh is capped at high", () => {
      expect(routeEffort(plain, [], "medium", DEFAULT_ROUTE)).toMatchObject({ effort: "medium" });
      expect(routeEffort(plain, [], undefined, DEFAULT_ROUTE).effort).toBe("medium");
      const capped = routeEffort(plain, [], "xhigh", DEFAULT_ROUTE);
      expect(capped.effort).toBe("high");
      expect(capped.why).toContain("only through REASONING");
      expect(routeEffort(plain, [], "max", DEFAULT_ROUTE).effort).toBe("high");
    });

    test("MECHANICAL without risk: low, on one code stack and few files", () => {
      expect(routeEffort(mech, [], "medium", DEFAULT_ROUTE)).toMatchObject({ effort: "low" });
      expect(routeEffort({ ...mech, stacks: ["docs", "typescript"] }, [], "medium", DEFAULT_ROUTE).effort).toBe("low");
      expect(routeEffort({ ...mech, files: [...three, "src/c.ts", "src/d.ts"] }, [], "medium", DEFAULT_ROUTE).effort).toBe("medium");
      expect(routeEffort({ ...mech, stacks: ["python", "typescript"] }, [], "medium", DEFAULT_ROUTE).effort).toBe("medium");
    });

    test("risk: high, even when MECHANICAL", () => {
      const r = routeEffort({ ...mech, risk: ["security"] }, [], "medium", DEFAULT_ROUTE);
      expect(r).toMatchObject({ effort: "high", why: "risk security: effort high" });
      expect(routeEffort({ ...plain, risk: ["migration"] }, [], "low", DEFAULT_ROUTE).effort).toBe("high");
    });

    test("failed once: high; another spec's failure does not count", () => {
      expect(routeEffort(mech, [failedRun("a")], "medium", DEFAULT_ROUTE)).toMatchObject({ effort: "high", why: "this spec already failed once: effort high" });
      expect(routeEffort(mech, [failedRun("a", "other")], "medium", DEFAULT_ROUTE).effort).toBe("low");
    });

    test("failed twice: escalate to the lead, nothing is run", () => {
      const rows = [failedRun("a"), failedRun("b")];
      const e = routeEffort(mech, rows, "medium", DEFAULT_ROUTE);
      expect(e.escalate).toBe(true);
      expect(e.effort).toBeUndefined();
      const r = routeSpec(mech, rows, { installed: ["claude"], efforts: { claude: "medium" } });
      expect(r.action).toBe("escalate");
      expect(r.effort).toBeUndefined();
      expect(r.reasons.at(-1)).toContain("failed 2 times in lanes: escalate to the lead");
      const report = routeReport(r, mech, "spec.md");
      expect(report).toContain("ACTION: escalate\n");
      expect(report.trimEnd().split("\n").at(-1)).toStartWith("NEXT: do it inline, or split or rewrite the spec");
    });

    test("explicit REASONING wins, the only way to xhigh or max, even past an escalation", () => {
      expect(routeEffort({ ...plain, reasoning: "xhigh" }, [], "medium", DEFAULT_ROUTE)).toMatchObject({ effort: "xhigh", why: "spec REASONING: effort xhigh" });
      expect(routeEffort({ ...mech, reasoning: "max" }, [], "medium", DEFAULT_ROUTE).effort).toBe("max");
      const r = routeSpec({ ...mech, reasoning: "xhigh" }, [failedRun("a"), failedRun("b")], { installed: ["claude"] });
      expect(r).toMatchObject({ action: "lane", to: "claude", effort: "xhigh" });
    });

    test("routeSpec applies the ladder to the picked harness", () => {
      expect(routeSpec(mech, [], { installed: ["codex"], efforts: { codex: "medium" } })).toMatchObject({ to: "codex", effort: "low" });
      expect(routeSpec(plain, [], { installed: ["claude"], efforts: { claude: "xhigh" } })).toMatchObject({ to: "claude", effort: "high" });
    });

    test("max20: workers default to medium, the lead to Opus high, the codex reviewer keeps xhigh", () => {
      const p = loadProfile("max20");
      expect(p.lanes.claude).toMatchObject({ model: "sonnet", effort: "medium" });
      for (const h of ["claude", "codex"] as const) expect(p.lanes[h].effort).toBe("medium");
      const cwd = mkdtempSync(join(tmpdir(), "route-roles-"));
      expect(roleChoice("edit", "claude", p, cwd)).toMatchObject({ model: "sonnet", effort: "medium" });
      expect(roleChoice("edit", "codex", p, cwd).effort).toBe("medium");
      expect(roleChoice("explore", "claude", p, cwd)).toMatchObject({ model: "haiku", effort: "low" });
      expect(p.lead.claude).toMatchObject({ model: "opus", effort: "high", permission_mode: "bypassPermissions" });
      expect(p.review.claude).toMatchObject({ to: "codex", effort: "xhigh" });
      expect(p.review.grok).toMatchObject({ to: "codex", effort: "xhigh" });
      expect(roleChoice("review", "codex", p, cwd).effort).toBe("xhigh");
      rmSync(cwd, { recursive: true, force: true });
    });
  });

  test("effort: low is switched off once it fails 25% of 10 MECHANICAL runs", () => {
    const mech = { ...feat(three), mechanical: true, fingerprint: "new" };
    const lowRun = (id: string, ok: boolean): LedgerRow[] => {
      const r = run(id, "codex", "complete");
      return [{ ...r, effort: "low", features: { ...r.features, mechanical: true } }, { kind: "outcome", id, at: "", outcome: ok ? "integrated" : "dropped", by: "gc" }];
    };
    const rows = (ko: number) => Array.from({ length: 10 }, (_, i) => lowRun(`m${i}`, i >= ko)).flat();
    expect(routeEffort(mech, rows(2), "medium", DEFAULT_ROUTE).effort).toBe("low");
    expect(routeEffort(mech, rows(3), "medium", DEFAULT_ROUTE)).toMatchObject({ effort: "medium" });
    expect(routeEffort(mech, rows(3), "medium", DEFAULT_ROUTE).why).toContain("low failed 3/10");
  });

  test("specFeatures reads MECHANICAL and a stable fingerprint", () => {
    const a = specFeatures(parseSpec("OBJECTIVE: do  it\nFILES: b.ts, a.ts\nMECHANICAL: yes"));
    const b = specFeatures(parseSpec("OBJECTIVE: do it\nFILES: a.ts\nb.ts"));
    expect(a.mechanical).toBe(true);
    expect(b.mechanical).toBe(false);
    expect(a.fingerprint).toBe(b.fingerprint!);
  });

  test("risk asks for a high review; --to overrides the size rule", () => {
    const r = routeSpec(feat(["src/auth.ts"], ["security"]), [], { installed: [...installed], to: "grok" });
    expect(r).toMatchObject({ action: "lane", to: "grok", review: "high" });
  });
});

describe("routeReport NEXT command", () => {
  test("prints inline, lane, explicit --to, risk and no-harness next steps", () => {
    const one = feat(["src/a.ts"]);
    const self = routeSpec(one, [], { installed: ["codex"] });
    expect(routeReport(self, one, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: do it inline, no lane (pass --to to force one)");

    const features = feat(three);
    const lane = routeSpec(features, [], { installed: ["codex"] });
    expect(routeReport(lane, features, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: lane auto --spec spec.md");

    const explicit = routeSpec(features, [], { installed: ["codex", "claude"], to: "claude" });
    expect(routeReport(explicit, features, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: lane auto --spec spec.md --to claude");

    const riskyFeatures = feat(three, ["security"]);
    const risky = routeSpec(riskyFeatures, [], { installed: ["codex"] });
    expect(routeReport(risky, riskyFeatures, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: lane auto --spec spec.md  (risk: lane auto puts the spec to a contest first, then reviews the lane; the gate needs a recorded ship)");
    const riskySmall = feat(["a.ts"], ["security"]);
    expect(routeReport(routeSpec(riskySmall, [], { installed: ["codex"] }), riskySmall, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: lane contest --spec spec.md (risk: GO first), then do it inline");

    const unavailable = routeSpec(features, [], { installed: [] });
    expect(routeReport(unavailable, features, "spec.md").trimEnd().split("\n").at(-1))
      .toBe("NEXT: install a lane harness (codex, claude or grok)");
  });
});

describe("ledger and integration gate", () => {
  let root: string, repo: string, bin: string;
  const saved = { ORCH_LEAD_PID: process.env.ORCH_LEAD_PID, PATH: process.env.PATH, HOME: process.env.HOME, ORCH_STATE: process.env.ORCH_STATE, ORCH_LANE: process.env.ORCH_LANE,
    ORCH_LEAD: process.env.ORCH_LEAD, ORCH_HARNESS: process.env.ORCH_HARNESS };
  const base = loadProfile("max20");
  const profile: Profile = { ...base, limits: { ...base.limits, report_max_bytes: 8192, timeout_seconds: 30 } };
  const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  const fake = (body: string) => {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ncat >/dev/null 2>&1\n${body}\n`);
    chmodSync(join(bin, "codex"), 0o755);
  };
  // Fake codex reviewer: writes its verdict where `-o` points, as codex does.
  const reviewer = (verdict: string, code = 0) => fake(`out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; printf 'VERDICT: ${verdict}\\n1. ok\\n' > "$out"; exit ${code}`);
  const spec = (files: string, extra = "") => {
    const p = join(root, `spec-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, `OBJECTIVE: write files\nFILES: ${files}\nINTERFACES: none\nCONSTRAINTS: none\nVERIFY: test -f a.txt\nACCEPT: a.txt exists\n${extra}`);
    return p;
  };

  beforeAll(() => {
    delete process.env.ORCH_LANE;
    delete process.env.ORCH_LEAD;
    delete process.env.ORCH_HARNESS;
    delete process.env.ORCH_LEAD_PID;
    root = mkdtempSync(join(tmpdir(), "route-test-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    sh(repo, "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b feat/x");
    sh(repo, "git config user.name t && git config user.email t@t");
    process.env.ORCH_STATE = join(root, "state");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = join(root, "home");
  }, 30_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test("a run is logged; an in-scope green lane integrates into the feature branch tree", async () => {
    fake("echo a > a.txt; echo b > b.txt");
    const { state, report } = await laneRun({ to: "codex", specPath: spec("a.txt, b.txt"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(report).toContain(`GATE: lane integrate ${state!.id}`);
    const row = readLedger().find((r) => r.id === state!.id && r.kind === "run") as RunRecord;
    expect(state!.verifiedSha).toBe(sh(repo, `git rev-parse ${state!.branch}`).stdout.trim());
    expect(row.verifiedSha).toBe(state!.verifiedSha);
    expect(row).toMatchObject({ to: "codex", status: "complete", verifyOk: true, outOfScope: [], diff: { files: ["a.txt", "b.txt"], insertions: 2 } });

    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(true);
    expect(gate.report).toContain("STATUS: integrated");
    // a.txt and b.txt are new files: the stat comes from the patch, not the working tree.
    expect(gate.report).toContain("2 files changed");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
    expect(listLanes().some((l) => l.id === state!.id)).toBe(false);
    expect(readLedger().find((r) => r.id === state!.id && r.kind === "outcome")).toMatchObject({ outcome: "integrated", by: "integrate" });
    sh(repo, "git add -A && git -c user.email=t@t -c user.name=t commit -q -m one");
  });

  test("a branch moved after VERIFY and ship is refused", async () => {
    fake("echo tested > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    expect(state?.status).toBe("complete");
    reviewer("ship");
    expect((await laneReviewLane(state!.id, { from: "claude", to: "codex", profile })).verdict).toBe("ship");
    expect(lastReview(readLedger(), state!.id)?.reviewedSha).toBe(state!.verifiedSha);
    const wt = join(root, "moved-branch");
    expect(sh(repo, `git worktree add -q ${wt} ${state!.branch}`).status).toBe(0);
    expect(sh(wt, "echo untested > a.txt && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm untested").status).toBe(0);
    expect(sh(repo, `git worktree remove ${wt}`).status).toBe(0);

    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("lane branch changed since VERIFY");
    expect(gate.report).toContain("lane branch changed since review");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  });

  test("a reviewer exiting 1 with ship overrides earlier approval and cannot authorize", async () => {
    fake("echo reviewed > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    reviewer("ship");
    expect((await laneReviewLane(state!.id, { from: "claude", to: "codex", profile })).verdict).toBe("ship");
    reviewer("ship", 1);
    const review = await laneReviewLane(state!.id, { from: "claude", to: "codex", profile });
    expect(review.report).toContain("VERDICT: ship");
    expect(review.verdict).toBe("unknown");
    expect(lastReview(readLedger(), state!.id)).toMatchObject({ verdict: "unknown", ok: false, status: "exit 1", reviewedSha: state!.verifiedSha });
    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("review did not succeed: exit 1");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  });

  test("the default branch takes a lane only from a living lead in bypassPermissions or auto mode", async () => {
    fake("echo unattended > u.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("u.txt"), repo, profile });
    sh(repo, "git checkout -q main");
    try {
      process.env.ORCH_LEAD_PID = String(process.pid);
      writePulse(process.pid, "busy", process.env.ORCH_STATE, new Date(), "default");
      expect((await laneIntegrate(state!.id)).report).toContain("GATE: caller repo is on main: the default branch takes a lane only from a lead in bypassPermissions or auto mode");
      writePulse(process.pid, "busy", process.env.ORCH_STATE, new Date(), "auto");
      const gate = await laneIntegrate(state!.id);
      expect(gate.integrated).toBe(true);
      expect(gate.report).toContain("default branch: lead in auto");
      expect(readFileSync(join(repo, "u.txt"), "utf8")).toBe("unattended\n");
    } finally {
      delete process.env.ORCH_LEAD_PID;
      sh(repo, "git clean -fdq && git checkout -q feat/x");
    }
  });

  test("deliver: a green lane becomes one commit on its own branch, pushed with a PR; the checkout is untouched", async () => {
    const origin = join(root, "origin.git");
    sh(root, `git init -q --bare ${origin}`);
    sh(repo, `git remote add origin ${origin} && git push -q origin main feat/x && git config user.name t && git config user.email t@t`);
    const ghLog = join(root, "gh.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\nif [ "$2" = list ]; then echo '[]'; else echo https://github.example/acme/core/pull/7; fi\n`);
    chmodSync(join(bin, "gh"), 0o755);
    fake("echo delivered > d.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("d.txt", "VERIFY: test -f d.txt\n"), repo, profile });
    expect(state?.status).toBe("complete");
    expect(state?.baseBranch).toBe("feat/x");
    // On the default branch, no lead in bypass: a delivery does not care, nothing lands there.
    sh(repo, "git checkout -q main");
    const head = sh(repo, "git rev-parse HEAD").stdout.trim();
    try {
      for (const [branch, why] of [["main", "never targets a shared branch"], ["develop", "never targets a shared branch"], ["lane/x", "not lane/"], ["feat/x", "already exists"], ["bad..name", "not a valid git branch name"]] as const) {
        const r = await laneIntegrate(state!.id, { branch, message: "fix: x" });
        expect(r.integrated).toBe(false);
        expect(r.report).toContain(why);
      }
      expect((await laneIntegrate(state!.id, { branch: "fix/DEV-1-d", message: "x".repeat(101) })).report).toContain("subject line of 1 to 100 characters");
      const gate = await laneIntegrate(state!.id, { branch: "fix/DEV-1-d", message: "fix(d): deliver d (DEV-1)\n\nWhy it matters." });
      expect(gate.report).toContain("STATUS: integrated");
      expect(gate.integrated).toBe(true);
      expect(gate.report).toContain("INTO: fix/DEV-1-d (delivered;");
      expect(gate.report).toContain("PUSH: origin/fix/DEV-1-d");
      expect(gate.report).toContain("PR: https://github.example/acme/core/pull/7 (into feat/x; merging is the operator's)");
      // One commit on the lane's base, with the verified tree and the message.
      expect(sh(repo, "git rev-parse fix/DEV-1-d^").stdout.trim()).toBe(state!.base);
      expect(sh(repo, "git rev-parse fix/DEV-1-d^{tree}").stdout.trim()).toBe(sh(repo, `git rev-parse ${state!.verifiedSha}^{tree}`).stdout.trim());
      expect(sh(repo, "git log -1 --format=%B fix/DEV-1-d").stdout.trim()).toBe("fix(d): deliver d (DEV-1)\n\nWhy it matters.");
      expect(sh(origin, "git rev-parse fix/DEV-1-d").stdout.trim()).toBe(sh(repo, "git rev-parse fix/DEV-1-d").stdout.trim());
      expect(readFileSync(ghLog, "utf8")).toContain("pr create --base feat/x --head fix/DEV-1-d --title fix(d): deliver d (DEV-1) --body-file");
      // The operator's checkout: same HEAD, clean tree, no d.txt.
      expect(sh(repo, "git rev-parse HEAD").stdout.trim()).toBe(head);
      expect(sh(repo, "git status --porcelain").stdout).toBe("");
      expect(existsSync(join(repo, "d.txt"))).toBe(false);
      expect(listLanes().some((l) => l.id === state!.id)).toBe(false);
      expect(readLedger().filter((r) => r.id === state!.id && r.kind === "outcome").at(-1)).toMatchObject({ outcome: "integrated", by: "integrate", branch: "fix/DEV-1-d" });
    } finally {
      sh(repo, "git checkout -q feat/x && git remote remove origin");
      rmSync(join(bin, "gh"), { force: true });
    }
  });

  test("deliver: a rejected push keeps the lane and retries the same local commit without running a worker", async () => {
    const origin = join(root, "retry-origin.git");
    sh(root, `git init -q --bare ${origin}`);
    sh(repo, `git remote add origin ${origin}`);
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    fake("echo retry > retry.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("retry.txt", "VERIFY: test -f retry.txt\n"), repo, profile });
    const request = { branch: "fix/DEV-2-retry", message: "fix: retry delivery (DEV-2)", pr: false };
    const checkpoint = join(process.env.ORCH_STATE!, "lanes", state!.id, "delivery.json");
    const head = sh(repo, "git rev-parse HEAD").stdout;
    try {
      const first = await laneIntegrate(state!.id, request);
      expect(first.integrated).toBe(false);
      expect(first.report).toContain("STATUS: delivery-pending");
      expect(first.report).toContain("PUSH: failed");
      expect(listLanes().some((s) => s.id === state!.id)).toBe(true);
      expect(readLedger().some((r) => r.kind === "outcome" && r.id === state!.id)).toBe(false);
      const commit = JSON.parse(readFileSync(checkpoint, "utf8")).commit;
      // A resume cannot silently change the branch's message or verified content.
      expect((await laneIntegrate(state!.id, { ...request, message: "different" })).report).toContain("checkpoint differs");
      rmSync(hook);
      // Any unexpected worker restart would fail; delivery needs only the saved tree.
      fake("exit 91");
      const resumed = await laneIntegrate(state!.id, request);
      expect(resumed.integrated).toBe(true);
      expect(resumed.report).toContain("DELIVERY: pushed");
      expect(sh(origin, "git rev-parse fix/DEV-2-retry").stdout.trim()).toBe(commit);
      expect(sh(repo, "git rev-parse HEAD").stdout).toBe(head);
      expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id).at(-1)).toMatchObject({
        outcome: "integrated", delivery: { commit, pushed: true },
      });
    } finally { sh(repo, "git remote remove origin"); }
  });

  test("deliver: an uncertain PR creation is resumed by discovering the existing PR without creating another", async () => {
    const origin = join(root, "pr-origin.git");
    sh(root, `git init -q --bare ${origin}`);
    sh(repo, `git remote add origin ${origin}`);
    const marker = join(root, "pr-created");
    const creates = join(root, "pr-create.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh
if [ "$2" = list ]; then
  if [ -f '${marker}' ]; then echo '[{"url":"https://github.example/acme/core/pull/8","state":"OPEN"}]'; else echo '[]'; fi
else
  echo create >> '${creates}'
  touch '${marker}'
  echo 'connection lost after create' >&2
  exit 1
fi
`);
    chmodSync(join(bin, "gh"), 0o755);
    fake("echo pr > pr.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("pr.txt", "VERIFY: test -f pr.txt\n"), repo, profile });
    const request = { branch: "fix/DEV-3-pr", message: "fix: resume PR delivery (DEV-3)" };
    try {
      const first = await laneIntegrate(state!.id, request);
      expect(first.integrated).toBe(false);
      expect(first.report).toContain("STATUS: delivery-pending");
      expect(first.report).toContain("PR: failed");
      const commit = sh(repo, "git rev-parse fix/DEV-3-pr").stdout.trim();
      expect(JSON.parse(readFileSync(join(process.env.ORCH_STATE!, "lanes", state!.id, "delivery.json"), "utf8"))).toMatchObject({ commit, pushed: true });
      const resumed = await laneIntegrate(state!.id, request);
      expect(resumed.integrated).toBe(true);
      expect(resumed.report).toContain("DELIVERY: pr");
      expect(resumed.report).toContain("PR: https://github.example/acme/core/pull/8");
      expect(sh(repo, "git rev-parse fix/DEV-3-pr").stdout.trim()).toBe(commit);
      expect(readFileSync(creates, "utf8").trim().split("\n")).toEqual(["create"]);
      expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id).at(-1)).toMatchObject({ delivery: { commit, pushed: true, prUrl: "https://github.example/acme/core/pull/8" } });
    } finally { sh(repo, "git remote remove origin"); rmSync(join(bin, "gh"), { force: true }); }
  });

  test("deliver: missing origin stays pending; an explicitly local delivery records that it was not pushed", async () => {
    fake("echo local > local.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("local.txt", "VERIFY: test -f local.txt\n"), repo, profile });
    const request = { branch: "fix/DEV-4-local", message: "fix: local delivery (DEV-4)" };
    const first = await laneIntegrate(state!.id, request);
    expect(first.integrated).toBe(false);
    expect(first.report).toContain("PUSH: pending (no origin remote)");
    const local = await laneIntegrate(state!.id, { ...request, push: false });
    expect(local.integrated).toBe(true);
    expect(local.report).toContain("DELIVERY: local");
    expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id).at(-1)).toMatchObject({ delivery: { pushed: false } });
    const replayed = await laneIntegrate(state!.id, { ...request, push: false });
    expect(replayed.integrated).toBe(true);
    expect(replayed.report).toContain("REPLAY: completed delivery");
    expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id)).toHaveLength(1);
  });

  test("deliver: completion is durable when cleanup is interrupted, and a retry finishes cleanup once", async () => {
    fake("echo cleanup > cleanup.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("cleanup.txt", "VERIFY: test -f cleanup.txt\n"), repo, profile });
    const request = { branch: "fix/DEV-5-cleanup", message: "fix: durable delivery before cleanup (DEV-5)", push: false };
    await withFileLock(join(process.env.ORCH_STATE!, "lanes", state!.id, "owner.lock"), async () => {
      const first = await laneIntegrate(state!.id, request);
      expect(first.integrated).toBe(true);
      expect(first.report).toContain("busy");
      expect(listLanes().some((s) => s.id === state!.id)).toBe(true);
      expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id)).toHaveLength(1);
    });
    const retry = await laneIntegrate(state!.id, request);
    expect(retry.report).toContain("REPLAY: completed delivery");
    expect(listLanes().some((s) => s.id === state!.id)).toBe(false);
    expect(readLedger().filter((r) => r.kind === "outcome" && r.id === state!.id)).toHaveLength(1);
  });

  test("switching to main while integration waits on its lock is refused", async () => {
    fake("echo locked > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt"), repo, profile });
    let pending: ReturnType<typeof laneIntegrate> | undefined;
    const main = sh(repo, "git rev-parse main").stdout;
    try {
      await withFileLock(join(process.env.ORCH_STATE!, "integrate.lck"), () => {
        pending = laneIntegrate(state!.id);
        expect(sh(repo, "git checkout -q main").status).toBe(0);
      });
      const gate = await pending!;
      expect(gate.integrated).toBe(false);
      expect(gate.report).toContain("caller repo is on main");
      expect(existsSync(join(repo, "a.txt"))).toBe(false);
      expect(sh(repo, "git status --porcelain").stdout).toBe("");
      expect(sh(repo, "git rev-parse main").stdout).toBe(main);
    } finally {
      if (pending) await pending;
      sh(repo, "git checkout -q feat/x");
    }
  });

  test("a legacy lane without a verified SHA stays readable but is refused", async () => {
    fake("echo legacy > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt"), repo, profile });
    delete state!.verifiedSha;
    writeFileSync(join(process.env.ORCH_STATE!, "lanes", state!.id, "state.json"), JSON.stringify(state));
    expect(listLanes().find((lane) => lane.id === state!.id)?.verifyOk).toBe(true);
    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("no verified commit recorded (lane predates the gate");
  });

  test("a legacy ship review without a reviewed SHA cannot authorize", async () => {
    fake("echo legacy-review > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    appendLedger({ kind: "review", id: state!.id, at: "", to: "codex", model: "m", effort: "low", verdict: "ship" });
    expect(lastVerdict(readLedger(), state!.id)).toBe("ship");
    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("no reviewed commit recorded (lane review predates the gate)");
  });

  test("a ship review for another commit cannot authorize the verified tip", async () => {
    fake("echo verified > a.txt");
    const { state } = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    const wt = join(root, "reviewed-branch");
    expect(sh(repo, `git worktree add -q ${wt} ${state!.branch}`).status).toBe(0);
    expect(sh(wt, "echo other > a.txt && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm other").status).toBe(0);
    expect(sh(repo, `git worktree remove ${wt}`).status).toBe(0);
    reviewer("ship");
    expect((await laneReviewLane(state!.id, { from: "claude", to: "codex", profile })).verdict).toBe("ship");
    expect(sh(repo, `git update-ref refs/heads/${state!.branch} ${state!.verifiedSha}`).status).toBe(0);
    const gate = await laneIntegrate(state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).not.toContain("lane branch changed since VERIFY");
    expect(gate.report).toContain("lane branch changed since review");
  });

  test("the gate refuses a file outside FILES, a risky spec without review, and the default branch", async () => {
    fake("echo c > a.txt; echo x > stray.txt");
    const out = await laneRun({ to: "codex", specPath: spec("a.txt"), repo, profile });
    expect(out.report).toContain("SCOPE: 1 file(s) outside FILES: stray.txt");
    const scope = await laneIntegrate(out.state!.id);
    expect(scope.integrated).toBe(false);
    expect(scope.report).toContain("GATE: 1 file(s) outside FILES: stray.txt");
    expect(existsSync(join(repo, "stray.txt"))).toBe(false);

    fake("echo d > a.txt");
    const risky = await laneRun({ to: "codex", specPath: spec("a.txt", "RISK: security\n"), repo, profile });
    expect((await laneIntegrate(risky.state!.id)).report).toContain("GATE: risk security: no review yet; lane review --lane");
    expect(readLedger().some((r) => r.kind === "gate" && r.id === risky.state!.id)).toBe(true);

    // The reviewer's verdict is recorded, not asserted: fix-first keeps it out, ship lets it in.
    reviewer("fix-first");
    expect((await laneReviewLane(risky.state!.id, { from: "claude", profile })).verdict).toBe("fix-first");
    expect((await laneIntegrate(risky.state!.id)).report).toContain("last review says fix-first");
    reviewer("ship");
    const review = await laneReviewLane(risky.state!.id, { from: "claude", profile, model: "pinned-model", effort: "low" });
    expect(review.report).toContain("REVIEWER: codex · pinned-model · effort low · risk high");
    expect(lastVerdict(readLedger(), risky.state!.id)).toBe("ship");
    expect(sh(repo, "git worktree list").stdout).not.toContain("review-wt");

    sh(repo, "git checkout -q main");
    const onMain = await laneIntegrate(risky.state!.id);
    expect(onMain.report).toContain("GATE: caller repo is on main");
    sh(repo, "git checkout -q feat/x");
    expect((await laneIntegrate(risky.state!.id)).integrated).toBe(true);

    expect(laneGc(out.state!.id, { superseded: true })).toContain(`removed ${out.state!.id}`);
    expect(readLedger().find((r) => r.id === out.state!.id && r.kind === "outcome")).toMatchObject({ outcome: "superseded", by: "gc" });
  });

  test("the gate refuses a protected path and a lane that weakens the base tests", async () => {
    fake("mkdir -p catalog && echo hacked > catalog/lead.md && echo a > a.txt");
    const sneak = await laneRun({ to: "codex", specPath: spec("a.txt, catalog/"), repo, profile });
    expect(sneak.state?.status).toBe("complete");
    const banned = await laneIntegrate(sneak.state!.id);
    expect(banned.integrated).toBe(false);
    expect(banned.report).toContain("protected path: catalog/lead.md");

    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "src/app.txt"), "hello\n");
    writeFileSync(join(repo, "tests/check.sh"), "grep -q hello src/app.txt\n");
    expect(sh(repo, "git add src/app.txt tests/check.sh && git -c user.email=t@t -c user.name=t commit -qm base-tests").status).toBe(0);
    fake("printf 'bye\\n' > src/app.txt; printf 'grep -q bye src/app.txt\\n' > tests/check.sh; echo a > a.txt");
    const weakenPath = join(root, "weaken.txt");
    writeFileSync(weakenPath, `OBJECTIVE: rewrite the app
FILES: a.txt, src/app.txt, tests/check.sh
INTERFACES: none
CONSTRAINTS: none
VERIFY: sh tests/check.sh && test -f a.txt
ACCEPT: app greets
`);
    const weaken = await laneRun({ to: "codex", specPath: weakenPath, repo, profile });
    expect(weaken.state?.status).toBe("complete");
    expect(weaken.state?.verifyOk).toBe(true);
    const gate = await laneIntegrate(weaken.state!.id);
    expect(gate.integrated).toBe(false);
    expect(gate.report).toContain("base-commit tests failed");
  });

  test("auto: an inline-sized spec runs nothing; a larger one routes, runs and integrates", async () => {
    sh(repo, "git checkout -q -- . && git clean -qfd");
    const before = readLedger().length;
    const small = await laneAuto({ specPath: spec("a.txt"), repo, profile });
    expect(small.report).toContain("ACTION: self");
    expect(readLedger().length).toBe(before);

    fake("echo e > a.txt; echo f > b.txt; echo g > c.txt");
    const big = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt"), repo, profile });
    expect(big.report).toContain("ACTION: lane --to codex");
    expect(big.report).toContain("STATUS: integrated");
    expect(big.integrated).toBe(true);
    expect(readFileSync(join(repo, "c.txt"), "utf8")).toBe("g\n");
  });

  // Contest + gate tests pin Codex as the lane worker: the Claude fake is the
  // judge/reviewer. max20's Claude-first order is covered by the profile test.
  const contestProfile: Profile = {
    ...profile,
    route: { ...profile.route, order: ["codex", "claude", "grok"] },
  };
  // contestants for a risky spec: codex answers the contest (and otherwise works
  // and reviews as before), claude answers and judges; grok is not installed
  const contestFakes = (decision: string, forOperator = "none") => {
    writeFileSync(join(bin, "codex"), `#!/bin/sh
p=$(cat)
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
case "$p" in
  *"Several models answer"*) printf 'ANSWER: GO\\n' > "$out";;
  *) echo h > a.txt; echo i > b.txt; echo j > c.txt; printf 'VERDICT: ship\\n' > "$out";;
esac
`);
    chmodSync(join(bin, "codex"), 0o755);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
p=$(cat)
case "$p" in
  *"You arbitrate"*) printf '%s\\n' '{"result":"**CONSENSUS:** the order is right\\n**CONTRADICTIONS:** none\\n**DECISION:** ${decision}\\n**FOR THE OPERATOR:** ${forOperator}"}';;
  *"Review the changes"*) printf '%s\\n' '{"result":"VERDICT: ship\\n1. ok"}';;
  *) printf '%s\\n' '{"result":"ANSWER: GO"}';;
esac
`);
    chmodSync(join(bin, "claude"), 0o755);
  };

  test("auto: a risky spec goes to a contest first, then is reviewed before the gate, and integrates on ship", async () => {
    sh(repo, "git checkout -q -- . && git clean -qfd");
    contestFakes("GO, the migration order is right.");
    const auto = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt", "RISK: migration\n"), repo, profile: contestProfile });
    expect(auto.report).toContain("CONTEST REPORT\nQUESTION: Should this spec be implemented as written?");
    expect(auto.report).toContain("NOT INSTALLED: grok");
    expect(auto.report).toContain("JUDGE: claude · fable");
    expect(auto.report).toContain("REVIEW: high");
    expect(auto.report).toContain("REVIEW REPORT");
    expect(auto.report).toContain("STATUS: integrated");
    expect(readFileSync(join(repo, "c.txt"), "utf8")).toBe("j\n");
  });

  test("auto ship review uses the lead harness family", async () => {
    sh(repo, "git checkout -q -- . && git clean -qfd && git reset -q --hard");
    contestFakes("GO, the migration order is right.");
    const oldLead = process.env.ORCH_LEAD;
    const oldHarness = process.env.ORCH_HARNESS;
    process.env.ORCH_LEAD = "1";
    process.env.ORCH_HARNESS = "codex";
    try {
      const auto = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt", "RISK: migration\n"), repo, profile: contestProfile });
      expect(auto.report).toContain("JUDGE: claude · fable");
      expect(auto.report).toContain("REVIEWER: claude · opus · effort high · risk high");
      expect(auto.report).toContain("STATUS: integrated");
    } finally {
      if (oldLead === undefined) delete process.env.ORCH_LEAD; else process.env.ORCH_LEAD = oldLead;
      if (oldHarness === undefined) delete process.env.ORCH_HARNESS; else process.env.ORCH_HARNESS = oldHarness;
    }
  });

  test("auto: a risky spec stops before any run on CHANGE, or when the judge leaves a point to the operator", async () => {
    sh(repo, "git checkout -q -- . && git clean -qfd && git reset -q --hard");
    const lanes = listLanes().length;
    contestFakes("CHANGE: add the rollback step to VERIFY.");
    const change = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt", "RISK: migration\n"), repo, profile: contestProfile });
    expect(change.integrated).toBe(false);
    expect(change.report).toContain("STATUS: needs-lead (spec contest: verdict CHANGE; nothing was run)");
    contestFakes("GO.", "whether the old column may be dropped now");
    const asked = await laneAuto({ specPath: spec("a.txt, b.txt, c.txt", "RISK: migration\n"), repo, profile: contestProfile });
    expect(asked.report).toContain("STATUS: needs-lead (spec contest: 1 point(s) for the operator; nothing was run)\nFOR THE OPERATOR:\n- whether the old column may be dropped now");
    // nothing ran: no lane, no file
    expect(listLanes().length).toBe(lanes);
    expect(existsSync(join(repo, "c.txt"))).toBe(false);
  });

  test("operatorPoints reads unresolved contradictions and the operator's section, bold or not", () => {
    expect(operatorPoints("CONTRADICTIONS: none\nDECISION: GO\nFOR THE OPERATOR: none")).toEqual([]);
    expect(operatorPoints("**FOR THE OPERATOR:** none.")).toEqual([]);
    const real = "1. x -> A is right: y\n2. z -> UNRESOLVED: cost against freshness\n**DECISION:** keep\n**FOR THE OPERATOR:**\n- Whether to anchor on the tick time.\n- Note that ops lags.";
    expect(operatorPoints(real)).toEqual(["unresolved: cost against freshness", "Whether to anchor on the tick time.", "Note that ops lags."]);
  });

  test("a torn ledger line is skipped", () => {
    appendLedger({ kind: "outcome", id: "z", at: "", outcome: "nochange", by: "gc" });
    writeFileSync(join(process.env.ORCH_STATE!, "lanes.jsonl"), `${readFileSync(join(process.env.ORCH_STATE!, "lanes.jsonl"), "utf8")}{"kind":"run",`);
    expect(readLedger().some((r) => r.id === "z")).toBe(true);
  });
});
