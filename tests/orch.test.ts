import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadArgv, leadGuard } from "../src/lead.ts";
import { apply, drift, plan, readManifest, uninstall } from "../src/install/manifest.ts";
import { loadProfile } from "../src/core/profile.ts";
import { leadPrompt, render, type Target } from "../src/install/render.ts";
import { doctorChecks, missingSystemPackages } from "../src/install/doctor.ts";
import { CLAUDE_SANDBOX, workerArgv } from "../src/harness/harness.ts";

let home: string;
let state: string;
let originalHome: string | undefined;
const targets = render(loadProfile("max20"));

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  home = join(root, "home");
  state = join(root, "state");
  originalHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "project-auditor.md"), "user file");
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("render", () => {
  test("orch and doctor do not import lane", () => {
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, "src/orch.ts"), "utf8")).not.toContain('from "./lane.ts"');
    expect(readFileSync(join(root, "src/install/doctor.ts"), "utf8")).not.toContain('from "./lane.ts"');
  });

  test("Claude lead pins the profile model, Grok files never do", () => {
    const by = Object.fromEntries(targets.map((t) => [t.path, t.content]));
    expect(by[".claude/agents/lead.md"]).toContain("model: opus");
    expect(by[".claude/agents/lead.md"]).toContain("effort: high");
    expect(by[".grok/agents/lead.md"]).not.toMatch(/^model:/m);
    expect(by[".grok/agents/lead-explore.md"]).not.toMatch(/^model:/m);
    // Codex gets no agent file, only the exec-policy rule for lane and orch.
    expect(targets.filter((t) => t.path.startsWith(".codex/")).map((t) => t.path)).toEqual([".codex/rules/orch.rules"]);
    expect(by[".claude/orch/lead-settings.json"]).toContain('"UserPromptSubmit"');
    expect(by[".grok/hooks/orch-lead.json"]).toContain('"run_terminal_command"');
  });
});

describe("manifest", () => {
  test("first install creates, second is unchanged, user files untouched", () => {
    const first = plan(home, targets, null);
    expect(first.every((a) => a.op === "create")).toBe(true);
    apply(home, state, "max20", targets, first);
    expect(plan(home, targets, readManifest(state)).every((a) => a.op === "unchanged")).toBe(true);
    expect(readFileSync(join(home, ".claude", "agents", "project-auditor.md"), "utf8")).toBe("user file");
  });

  test("a foreign file at a target path is a conflict", () => {
    const other = mkdtempSync(join(tmpdir(), "orch-foreign-"));
    mkdirSync(join(other, ".grok", "agents"), { recursive: true });
    writeFileSync(join(other, ".grok", "agents", "lead.md"), "someone else's lead");
    const acts = plan(other, targets, null);
    expect(acts.find((a) => a.path === ".grok/agents/lead.md")?.op).toBe("conflict");
    expect(() => apply(other, join(other, "st"), "max20", targets, acts)).toThrow();
    rmSync(other, { recursive: true, force: true });
  });

  test("uninstall keeps an edited file and removes the rest", () => {
    const edited = join(home, ".grok", "agents", "lead.md");
    writeFileSync(edited, "hand edit");
    expect(drift(home, state)).toContain("edited .grok/agents/lead.md");
    const out = uninstall(home, state, false);
    expect(out).toContain("kept .grok/agents/lead.md (edited since install)");
    expect(existsSync(join(home, ".claude", "agents", "lead.md"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "lane"))).toBe(false);
    expect(existsSync(edited)).toBe(true);
    expect(readManifest(state)?.entries.map((e) => e.path)).toEqual([".grok/agents/lead.md"]);
    expect(existsSync(join(home, ".claude", "agents", "project-auditor.md"))).toBe(true);
  });

  test("upgrade removes retired files but keeps edited retired files for uninstall", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-upgrade-"));
    const upgradeHome = join(root, "home");
    const upgradeState = join(root, "state");
    const oldTargets: Target[] = [
      { path: ".orch/old.txt", kind: "file", content: "old\n" },
      { path: ".orch/edited.txt", kind: "file", content: "before\n" },
    ];
    const newTargets: Target[] = [{ path: ".orch/new.txt", kind: "file", content: "new\n" }];

    apply(upgradeHome, upgradeState, "test", oldTargets, plan(upgradeHome, oldTargets, null));
    writeFileSync(join(upgradeHome, ".orch/edited.txt"), "hand edit\n");
    apply(upgradeHome, upgradeState, "test", newTargets, plan(upgradeHome, newTargets, readManifest(upgradeState)));

    expect(existsSync(join(upgradeHome, ".orch/old.txt"))).toBe(false);
    expect(existsSync(join(upgradeHome, ".orch/edited.txt"))).toBe(true);
    expect(readManifest(upgradeState)?.entries.map((e) => e.path)).toEqual([".orch/new.txt", ".orch/edited.txt"]);

    const out = uninstall(upgradeHome, upgradeState, false);
    expect(out).toContain("kept .orch/edited.txt (edited since install)");
    expect(existsSync(join(upgradeHome, ".orch/new.txt"))).toBe(false);
    expect(existsSync(join(upgradeHome, ".orch/edited.txt"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("lead launch argv", () => {
  test("a lane worker is refused before lead launch", () => {
    expect(leadGuard({ ORCH_LANE: "1" })).toBe("lead: a lane worker cannot start a lead session");
    expect(leadGuard({ ORCH_LANE: "0" })).toBeNull();
  });

  test("Codex: lead prompt passed once as developer_instructions", () => {
    const out = leadArgv("codex", "max20");
    expect(out[0]).toBe("codex");
    const di = out.filter((a) => a.startsWith("developer_instructions="));
    expect(di).toHaveLength(1);
    const text = JSON.parse(di[0].slice("developer_instructions=".length));
    expect(text.startsWith(leadPrompt())).toBe(true);
    expect(text.endsWith("Your harness reports this model: gpt-6-astra.")).toBe(true);
    expect(out).toContain("gpt-6-astra");
    expect(out).not.toContain("--agent");
  });

  test("Codex: a --model in the extra args is the one reported, and not passed twice", () => {
    const out = leadArgv("codex", "max20", ["--model", "gpt-6.1-sol"]);
    expect(out.find((a) => a.startsWith("developer_instructions="))).toContain("this model: gpt-6.1-sol.");
    expect(out).not.toContain("--model");
  });

  test("Codex: the lead starts in yolo mode unless a sandbox or approval flag is given", () => {
    expect(leadArgv("codex", "max20")).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(leadArgv("codex", "lean")).toContain("--dangerously-bypass-approvals-and-sandbox");
    for (const flag of [["-s", "workspace-write"], ["--sandbox=read-only"], ["-a", "on-request"], ["--full-auto"], ["--yolo"]]) {
      expect(leadArgv("codex", "max20", flag)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });

  test("Claude and Grok select the installed lead agent", () => {
    const claude = leadArgv("claude", "max20");
    expect(claude.slice(0, 4)).toEqual(["claude", "--agent", "lead", "--settings"]);
    expect(claude[4]).toBe(join(home, ".claude", "orch", "lead-settings.json"));
    expect(claude.slice(-6)).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", "bypassPermissions"]);
    expect(leadArgv("grok", "max20")).toEqual(["grok", "--agent", "lead", "--model", "grok-4.7-build-fast", "--reasoning-effort", "high"]);
    // a model or effort the operator passes wins over the profile's
    expect(leadArgv("grok", "max20", ["-m", "grok-4.7", "--effort", "low"])).toEqual(["grok", "--agent", "lead"]);
  });

  test("Codex lead configures the four lifecycle hooks inline", () => {
    const overrides = leadArgv("codex", "max20").filter((arg) => arg.startsWith("hooks."));
    expect(overrides.map((arg) => arg.split("=")[0])).toEqual([
      "hooks.PreToolUse", "hooks.PostToolUse", "hooks.UserPromptSubmit", "hooks.Stop",
    ]);
    expect(overrides[0]).toContain('matcher = "Bash"');
    expect(overrides[0]).toContain("ORCH_LEAD");
    expect(overrides[0]).toContain("exit 0; exec");
  });

  test("Claude: a permission flag in the extra args replaces the profile's", () => {
    expect(leadArgv("claude", "max20", ["--permission-mode", "plan"])).not.toContain("bypassPermissions");
    expect(leadArgv("claude", "max20", ["--dangerously-skip-permissions"])).not.toContain("--permission-mode");
  });
});

describe("external workers", () => {
  const opts = { cwd: "/w", promptPath: "/p", readOnly: false, lastMessagePath: "/l" };

  test("the Claude write worker runs Bash in the OS sandbox, never with a prompt", () => {
    const { argv } = workerArgv("claude", { model: "sonnet" }, opts);
    expect(argv).toContain("dontAsk");
    expect(argv).not.toContain("acceptEdits");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toEqual(CLAUDE_SANDBOX);
    expect(CLAUDE_SANDBOX.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(argv).toContain("Edit(/**)");
    expect(argv).not.toContain("Bash");
    // no inherited settings source may widen the worker's permissions
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
  });

  test("the read-only Claude worker stays in plan mode", () => {
    expect(workerArgv("claude", {}, { ...opts, readOnly: true }).argv).toContain("plan");
  });

  test("install ships the Codex lead rule for lane and orch", () => {
    const rule = render(loadProfile("max20")).find((t) => t.path === ".codex/rules/orch.rules");
    // lane run asks: it runs the spec's SETUP and VERIFY on the host.
    expect(rule?.content).toMatch(/pattern = \["lane", "run"\],\n\s+decision = "prompt"/);
    expect(rule?.content).toContain('pattern = ["lane", ["review", "status", "gc"]]');
    expect(rule?.content).toContain('pattern = ["orch", ["mem", "docs"]]');
  });

  test("install maps missing sandbox binaries to their apt packages", () => {
    const want = process.platform === "linux" ? ["socat"] : [];
    expect(missingSystemPackages((b) => b !== "socat")).toEqual(want);
    expect(missingSystemPackages(() => true)).toEqual([]);
  });

  test("Grok write workers run under the orch-lane profile, which blocks child network", () => {
    const { argv } = workerArgv("grok", {}, opts);
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("orch-lane");
    const ro = workerArgv("grok", {}, { ...opts, readOnly: true }).argv;
    expect(ro[ro.indexOf("--sandbox") + 1]).toBe("orch-review");
    // lane passes a pinned copy of the grok binary
    expect(workerArgv("grok", {}, { ...opts, bin: "/pinned/grok-1.0" }).argv[0]).toBe("/pinned/grok-1.0");
    expect(argv).toContain("--no-auto-update");
    const pinned = workerArgv("grok", { model: "grok-4.7-build-fast", effort: "high" }, opts).argv;
    expect(pinned.slice(pinned.indexOf("--model"), pinned.indexOf("--model") + 4)).toEqual(["--model", "grok-4.7-build-fast", "--reasoning-effort", "high"]);
    const profile = render(loadProfile("max20")).find((t) => t.path === ".grok/sandbox.toml");
    expect(profile?.content).toMatch(/\[profiles\.orch-lane\]\nextends = "workspace"\nrestrict_network = true/);
    expect(profile?.content).toMatch(/\[profiles\.orch-review\]\nextends = "read-only"\nrestrict_network = true/);
    for (const p of ["~/.grok/agents", "~/.grok/bin", "~/.grok/downloads"]) expect(profile?.content).toContain(`"${p}"`);
  });

  test("install adopts an empty pre-existing file, never a non-empty one", () => {
    const home = mkdtempSync(join(tmpdir(), "adopt-"));
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "sandbox.toml"), "");
    const t = render(loadProfile("max20")).filter((x) => x.path === ".grok/sandbox.toml");
    expect(plan(home, t, null)[0].op).toBe("update");
    writeFileSync(join(home, ".grok", "sandbox.toml"), "[profiles.mine]\n");
    expect(plan(home, t, null)[0].op).toBe("conflict");
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor names each missing piece", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-"));
    const none = doctorChecks(home, (b) => b !== "socat", () => true);
    expect(none.ok).toBe(false);
    expect(none.lines.join("\n")).toContain("orch.rules");
    if (process.platform === "linux") expect(none.lines.join("\n")).toContain("missing socat");
    mkdirSync(join(home, ".codex", "rules"), { recursive: true });
    writeFileSync(join(home, ".codex", "rules", "orch.rules"), "x");
    expect(doctorChecks(home, () => true, () => true).lines.join("\n")).toContain("orch-lane");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "sandbox.toml"), render(loadProfile("max20")).find((t) => t.path === ".grok/sandbox.toml")!.content);
    expect(doctorChecks(home, () => true, () => true)).toEqual({ ok: true, lines: expect.any(Array) });
    if (process.platform === "linux") {
      const blocked = doctorChecks(home, () => true, () => false);
      expect(blocked.ok).toBe(false);
      expect(blocked.lines.join("\n")).toContain("nested user namespace");
    }
    rmSync(home, { recursive: true, force: true });
  });
});

test("project skills: one source in .agents/skills, linked for Claude and Grok", () => {
  const root = join(import.meta.dir, "..");
  const names = readdirSync(join(root, ".agents", "skills"));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(existsSync(join(root, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    for (const h of [".claude", ".grok"]) {
      const link = join(root, h, "skills", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
    }
  }
});
