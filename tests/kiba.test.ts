import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../src/core/policy.ts";
import { leadArgs, leadArgv } from "../src/lead.ts";
import { nativeChoice } from "../src/kiba/native.ts";
import { loadProfile, ROOT } from "../src/core/profile.ts";
import { assess, type LaneWatch, Watchdog } from "../src/kiba/watchdog.ts";
import { staleSettingsRules } from "../src/install/claude-rules.ts";
import { leadSettings } from "../src/install/render.ts";
import { laneIntegrate } from "../src/lane.ts";

let root = "";
const savedState = process.env.ORCH_STATE;
beforeEach(() => { root = mkdtempSync(join("/tmp", "orch-kiba-")); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true }); delete process.env.ORCH_POLICY;
  if (savedState === undefined) delete process.env.ORCH_STATE; else process.env.ORCH_STATE = savedState;
});

describe("kiba: the only lead, on Claude only", () => {
  test("native Kiba keeps the lead model independently of its workers", () => {
    const profile = loadProfile("kiba");
    profile.lanes.claude = { model: "haiku", effort: "low" };
    expect(nativeChoice(profile, root)).toMatchObject({ model: "opus", effort: "medium" });
    expect(profile.kiba!.ladder!.normal).toEqual({ model: "sonnet", effort: "medium" });
  });

  test("Claude starts Kiba natively; a leftover lead.conductor: kiba loads, any other value is refused", () => {
    const policy = join(root, "policy.yaml");
    writeFileSync(policy, "lead:\n  conductor: kiba\n  channels: true\n");
    process.env.ORCH_POLICY = policy;
    expect(() => loadPolicy()).not.toThrow();
    expect(leadArgv("max20")).toEqual(expect.arrayContaining(["--agent", "kiba"]));
    expect(leadArgv("max20")).not.toContain("--append-system-prompt-file");
    expect(leadArgv("max20")).not.toContain("--mcp-config");
    writeFileSync(policy, "lead:\n  conductor: someone-else\n");
    expect(() => loadPolicy()).toThrow(/lead.conductor is gone/);
  });

  test("kiba codex and kiba grok exit 2 with the Claude-only message; --conductor prints the orch serve status", async () => {
    expect(leadArgs(["codex"]).harness).toBe("codex");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), ORCH_STATE: join(root, "state") };
    for (const h of ["codex", "grok"]) {
      const r = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "src", "lead.ts"), h], { env, stderr: "pipe", stdout: "pipe" });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("Kiba runs on Claude only; Codex and Grok are lane workers and reviewers");
    }
    const status = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "src", "lead.ts"), "--conductor"], { env, stderr: "pipe", stdout: "pipe" });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toMatch(/^ORCH SERVE/);
    expect(status.stdout.toString()).toContain("PENDING EFFECTS: 0");
    expect(status.stdout.toString()).toContain("orch-serve.service");
  });
});

describe("kiba: lead settings keep the operator's rules", () => {
  test("no tool is denied as such and no PreToolUse hook; secret and guard rules stay, Edit(...) only", () => {
    const k = JSON.parse(leadSettings());
    for (const t of ["Bash", "Edit", "Write", "NotebookEdit", "Agent"]) expect(k.permissions.deny).not.toContain(t);
    for (const rule of ["Read(~/.ssh/**)", "Edit(~/.ssh/**)", "Edit(**/*.pem)"]) expect(k.permissions.deny).toContain(rule);
    expect(k.permissions.deny.some((r: string) => r.startsWith("Write("))).toBe(false);
    expect(staleSettingsRules(k)).toEqual([]);
    // Operator's decision: native Kiba has zero PreToolUse hook; no conductor wake on Stop.
    expect(k.hooks.PreToolUse).toBeUndefined();
    expect(JSON.stringify(k.hooks.Stop)).not.toContain("kiba wait");
    expect(JSON.stringify(k)).not.toContain("asyncRewake");
  });
});

describe("kiba: the delivery gate", () => {
  test("a lane that is not complete is refused by the gate and logged, and stays", async () => {
    process.env.ORCH_STATE = root;
    const id = "20261102-claude-3-cccc";
    mkdirSync(join(root, "lanes", id), { recursive: true });
    writeFileSync(join(root, "lanes", id, "state.json"), JSON.stringify({ id, to: "claude", repo: join(root, "repo"), base: "x", branch: `lane/${id}`, worktree: join(root, "nope"), status: "failed", changed: true, usage: {}, started: "", ended: "", declared: ["src/a.ts"] }));
    const r = await laneIntegrate(id, { branch: "fix/DEV-1-purge-pause", message: "fix(market): skip the purge (DEV-1)\n\nWhy." });
    expect(r.integrated).toBe(false);
    expect(r.report).toMatch(new RegExp(`^LANE INTEGRATE\nSTATUS: refused\nID: ${id}\n`));
    expect(r.report).toContain("GATE: status failed, not complete");
    expect(readFileSync(join(root, "lanes.jsonl"), "utf8")).toContain(`"kind":"gate","id":"${id}"`);
    expect(existsSync(join(root, "lanes", id))).toBe(true);
  });
});

const lane = (o: Partial<LaneWatch> = {}): LaneWatch => ({ id: "L1", phase: "worker", progressKey: "k", turns: 3, lastTool: "Read", declared: ["src/a.ts"], touched: [], pgid: 999999, ...o });

describe("kiba: watchdog", () => {
  const cfg = { stall_seconds: 60, max_turns_without_test: 20, tick_seconds: 5 };
  test("shell activity does not disable loop detection; opaque engines and setup avoid false stalls", async () => {
    expect(assess(lane({ turns: 30, lastVerifyTurn: 15 }), 0, false, cfg)).toBeNull();
    expect(assess(lane({ turns: 35, lastVerifyTurn: 15 }), 0, false, cfg)?.kind).toBe("loop");
    for (const phase of ["setup", "verify"]) expect(assess(lane({ phase }), 120_000, false, cfg)).toBeNull();
    expect(assess(lane({ turns: 100, progressObservable: false }), 120_000, false, cfg)).toBeNull();
    expect(assess(lane({ progressObservable: false, touched: ["outside.txt"] }), 0, false, cfg)?.kind).toBe("drift");
    const w = new Watchdog(cfg, { observe: () => [lane({ turns: 20, lastTool: "Bash" })], kill: () => false, signal: () => {} });
    expect((await w.tick()).map((f) => f.kind)).toEqual(["loop"]);
  });

  test("stall, drift and a loop without tests are detected", () => {
    expect(assess(lane(), 59_000, false, cfg)).toBeNull();
    expect(assess(lane(), 60_000, false, cfg)?.kind).toBe("stall");
    expect(assess(lane({ touched: ["src/a.ts", "README.md"] }), 0, false, cfg)).toMatchObject({ kind: "drift", summary: "touched outside FILES: README.md" });
    expect(assess(lane({ turns: 20 }), 0, false, cfg)?.kind).toBe("loop");
    expect(assess(lane({ turns: 20 }), 0, true, cfg)).toBeNull();
  });

  test("a worker is recovered once: kill, then one signal; progress resets the stall clock", async () => {
    let now = 0;
    let key = "a";
    const killed: string[] = [];
    const signals: string[] = [];
    const w = new Watchdog(cfg, { observe: () => [lane({ progressKey: key })], kill: (x) => { killed.push(x.id); return true; }, signal: (f, a) => signals.push(`${f.kind}: ${a}`), now: () => now });
    await w.tick();
    now = 50_000; key = "b"; await w.tick();
    now = 100_000; expect(await w.tick()).toEqual([]);
    now = 111_000; expect((await w.tick()).map((f) => f.kind)).toEqual(["stall"]);
    now = 300_000; await w.tick();
    expect(killed).toEqual(["L1"]);
    expect(signals).toEqual(["stall: worker killed; the step ends failed and the ladder applies"]);
  });
});

describe("kiba: dash sees Kiba sessions", () => {
  test("a native Kiba session, a retired conductor session and the kiba launcher count as leads", async () => {
    const { hasLeadAgent, isLeadLauncher } = await import("../src/dash/leads.ts");
    expect(hasLeadAgent(["claude", "--agent", "kiba", "--settings", "s"])).toBe(true);
    // A session of the retired conductor still counts, so restart notes can tell it to quit.
    expect(hasLeadAgent(["claude", "--settings", "s", "--append-system-prompt-file", ["/opt/orch/catalog", "kiba.md"].join("/")])).toBe(true);
    expect(isLeadLauncher(["bun", "--no-env-file", "/home/k/.local/bin/kiba"])).toBe(true);
    expect(hasLeadAgent(["claude", "--append-system-prompt-file", "/tmp/other.md"])).toBe(false);
  });
});

describe("kiba: stale lead settings after the switch", () => {
  test("an unedited copy of the retired conductor template is reported outdated, then re-rendered without its tool denies", async () => {
    const { leadSettingsStatus, refreshLeadSettings } = await import("../src/install/lead-settings.ts");
    const { sha } = await import("../src/install/manifest.ts");
    const { LEAD_SETTINGS_PATH } = await import("../src/install/render.ts");
    const home = join(root, "home");
    const state = join(root, "state");
    mkdirSync(join(home, ".claude", "orch"), { recursive: true });
    mkdirSync(state, { recursive: true });
    // the conductor template denied Kiba's execution tools
    const parsed = JSON.parse(leadSettings());
    parsed.permissions.deny = ["Bash", "Edit", "Write", "NotebookEdit", "Agent", ...parsed.permissions.deny];
    const old = `${JSON.stringify(parsed, null, 2)}\n`;
    writeFileSync(join(home, LEAD_SETTINGS_PATH), old);
    writeFileSync(join(state, "manifest.json"), JSON.stringify({ entries: [{ path: LEAD_SETTINGS_PATH, kind: "file", sha256: sha(old) }] }));
    expect(leadSettingsStatus(home, state).state).toBe("outdated");
    expect(refreshLeadSettings(home, state)).toBe("rendered");
    expect(JSON.parse(readFileSync(join(home, LEAD_SETTINGS_PATH), "utf8")).permissions.deny).not.toContain("Bash");
    expect(leadSettingsStatus(home, state).state).toBe("current");
  });
});
