import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_ONLY, leadArgs, leadArgv, leadAvailability, leadGuard } from "../src/lead.ts";
import { loadPolicy, resolveLeadPolicy } from "../src/core/policy.ts";
import { apply, drift, plan, readManifest, uninstall } from "../src/install/manifest.ts";
import { loadProfile, validateProfile } from "../src/core/profile.ts";
import { hookCommand, leadPrompt, POST_TOOL_BACKGROUND_MATCHER, render, type Target } from "../src/install/render.ts";
import { doctorChecks, missingSystemPackages } from "../src/install/doctor.ts";
import { CLAUDE_FINISH, CLAUDE_SANDBOX, finishLine, resolveLaneStatus, workerArgv } from "../src/harness/harness.ts";

let home: string;
let state: string;
let originalHome: string | undefined;
const profile = loadProfile("max20");
let targets: Target[];
let originalHookPolicy: string | undefined;

function fakePath(root: string, harnesses: string[]): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync("/bin/sh", join(bin, "sh"));
  for (const harness of harnesses) symlinkSync("/bin/true", join(bin, harness));
  return bin;
}

function runInstall(root: string, bin: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "install", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(root, "home"),
      ORCH_HOME: join(root, "home"),
      ORCH_STATE: join(root, "state"),
      PATH: bin,
    },
  });
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  home = join(root, "home");
  state = join(root, "state");
  originalHome = process.env.HOME;
  originalHookPolicy = process.env.ORCH_HOOK_POLICY;
  process.env.ORCH_HOOK_POLICY = join(root, "hooks.yaml");
  targets = render(profile, ["claude", "codex", "grok"]);
  process.env.HOME = home;
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "project-auditor.md"), "user file");
});
afterAll(() => {
  if (originalHookPolicy === undefined) delete process.env.ORCH_HOOK_POLICY;
  else process.env.ORCH_HOOK_POLICY = originalHookPolicy;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(join(home, ".."), { recursive: true, force: true });
});

test("orch reports a subcommand error as one stderr line without a stack trace", () => {
  // files mode, whatever the shipped catalog/brain.yaml says
  const brainConfig = join(home, "brain.yaml");
  writeFileSync(brainConfig, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\nmem: files\n");
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "mem", "forget", "nope"], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, HOME: home, ORCH_HOME: home, ORCH_STATE: state, ORCH_LANE: "0", ORCH_LEAD: "0", ORCH_BRAIN_CONFIG: brainConfig },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("orch: mem: no readable note nope\n");
  expect(result.stderr).not.toMatch(/^\s+at /m);
});

test("orch hook ignores a leftover Codex lead hook: Kiba runs on Claude only", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-hook-retired-"));
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "hook", "pre-bash", "--harness", "codex"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), encoding: "utf8",
    env: { ...process.env, HOME: join(root, "home"), ORCH_HOME: join(root, "home"), ORCH_STATE: join(root, "state"), ORCH_LEAD: "1", ORCH_LANE: "0" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("");
  rmSync(root, { recursive: true, force: true });
});

describe("render", () => {
  test("orch and doctor do not import lane", () => {
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, "src/orch.ts"), "utf8")).not.toContain('from "./lane.ts"');
    expect(readFileSync(join(root, "src/install/doctor.ts"), "utf8")).not.toContain('from "./lane.ts"');
  });

  test("renders the Claude lead files and hooks only, never a Codex or Grok lead file", () => {
    const by = Object.fromEntries(targets.map((t) => [t.path, t.content]));
    expect(by[".claude/agents/kiba.md"]).toContain("model: opus");
    expect(by[".claude/agents/kiba.md"]).toContain("effort: high");
    expect(targets.map((t) => t.path)).toContain(".claude/agents/Explore.md");
    expect(by[".claude/agents/Explore.md"]).toMatch(/^name: Explore$/m);
    expect(by[".claude/agents/Explore.md"]).toMatch(/^model: haiku$/m);
    expect(by[".claude/agents/Explore.md"]).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(by[".claude/agents/Explore.md"]).not.toMatch(/Bash/);
    expect(by[".claude/agents/lead-explore.md"]).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(by[".claude/agents/lead-explore.md"]).toMatch(/^model: haiku$/m);
    expect(by[".claude/agents/lead-explore.md"]).not.toMatch(/Bash/);
    expect(by[".claude/agents/kiba.md"]).toContain("Work directly by default");
    expect(by[".claude/agents/kiba.md"]).toContain("Never ask the operator to open a new Kiba session because of context");
    expect(targets.some((t) => t.path.startsWith(".codex/"))).toBe(false);
    expect(targets.map((t) => t.path)).not.toContain(".grok/managed_config.toml");
    expect(by[".claude/orch/lead-settings.json"]).toContain('"UserPromptSubmit"');
    const settings = JSON.parse(by[".claude/orch/lead-settings.json"]);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.hooks.SessionStart.map((entry: { matcher?: string }) => entry.matcher)).toEqual(["startup", "resume", "compact"]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand("session-start"));
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand("session-end"));
    for (const [hook, event] of [["SubagentStart", "subagent-start"], ["SubagentStop", "subagent-stop"]]) {
      expect(settings.hooks[hook]).toEqual([{ hooks: [{ type: "command", command: hookCommand(event), timeout: 10, async: true }] }]);
    }
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    // Operator's decision: native Kiba has zero PreToolUse hook.
    expect(settings.hooks.PreToolUse).toBeUndefined();
    // One process per tool call: Edit|Write synchronous, every other tool in the background.
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write");
    expect(settings.hooks.PostToolUse[0].hooks[0]).toMatchObject({ command: hookCommand("post-tool"), timeout: 10 });
    expect(settings.hooks.PostToolUse[0].hooks[0]).not.toHaveProperty("async");
    expect(settings.hooks.PostToolUse[1].matcher).toBe(POST_TOOL_BACKGROUND_MATCHER);
    expect(settings.hooks.PostToolUse[1].hooks[0]).toMatchObject({ command: hookCommand("post-tool"), async: true });
    const background = new RegExp(POST_TOOL_BACKGROUND_MATCHER);
    expect(["Read", "Bash", "Grep", "NotebookEdit", "mcp__kiba__status"].every((tool) => background.test(tool))).toBe(true);
    expect(["Edit", "Write"].some((tool) => background.test(tool))).toBe(false);
    expect(settings.permissions.ask).toEqual([]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      "Read(.env.local)", "Read(.env.*.local)", "Read(.env.prod)",
      "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)",
      "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.claude/.credentials*)",
      "Read(~/.codex/auth.json)", "Read(~/.npmrc)",
      "Edit(.env.local)", "Edit(~/.ssh/**)",
    ]));
    for (const path of ["catalog/policy.yaml", ".claude/orch/lead-settings.json", "src/hooks/hook.ts", "src/core/sensitive.ts"]) {
      expect(settings.permissions.deny).not.toContain(`Edit(${path})`);
    }
    expect(settings.permissions.deny).not.toEqual(expect.arrayContaining([
      "Read(.env)", "Read(.env.*)", "Read(**/.env.*)", "Read(**/*token*)",
    ]));
    const allow: string[] = settings.permissions.allow;
    expect(allow).toEqual([
      "Bash(orch mem search *)", "Bash(orch mem recent *)", "Bash(orch mem show *)",
      "Bash(orch mem add *)", "Bash(orch mem supersede *)", "Bash(orch mem forget *)",
      "Bash(orch mem review *)", "Bash(orch docs search *)", "Bash(orch docs status)",
      "Bash(orch ops usage)", "Bash(orch ops usage *)", "Bash(orch ops check)",
      "Bash(orch routine status)", "Bash(orch brain status)", "Bash(orch presence status)",
      "Bash(lane review *)", "Bash(lane status)", "Bash(lane status *)", "Bash(lane gc)",
    ]);
    for (const path of [".grok/hooks/orch.json", ".grok/agents/kiba.md", ".grok/agents/lead-explore.md", ".config/systemd/user/orch-kiba.service"]) expect(by[path]).toBeUndefined();
    // The hook runs src/hooks/hook.ts directly (found through the orch symlink), never the orch CLI.
    const entry = 'bun --no-env-file "$(dirname "$(readlink -f "$HOME/.local/bin/orch")")/hooks/hook.ts"';
    expect(hookCommand("post-tool")).toBe(`[ "$ORCH_LEAD" = 1 ] || exit 0; exec ${entry} post-tool --harness claude`);
  });

  test("renders targets only for detected harnesses and always keeps the bin links", () => {
    const claude = render(profile, ["claude"]);
    expect(claude.some((target) => target.path.startsWith(".grok/") || target.path.startsWith(".codex/"))).toBe(false);
    expect(claude.filter((target) => target.path.startsWith(".local/bin/")).map((target) => target.path)).toEqual([
      ".local/bin/lane", ".local/bin/lead", ".local/bin/kiba", ".local/bin/orch",
    ]);
    expect(render(profile, ["codex"]).some((target) => target.harness)).toBe(false);
    // Grok is a lane worker: only its worker sandbox profile, no lead file.
    const grok = render(profile, ["grok"]);
    expect(grok.filter((target) => target.harness).map((target) => target.path)).toEqual([".grok/sandbox.toml"]);
  });

  test("package bin map matches the installed bin links", () => {
    const root = join(import.meta.dir, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin: Record<string, string> };
    const links = render(profile, ["claude"]).filter((target) => target.path.startsWith(".local/bin/"));
    expect(Object.fromEntries(links.map((target) => [target.path.slice(".local/bin/".length), target.content]))).toEqual(
      Object.fromEntries(Object.entries(pkg.bin).map(([name, path]) => [name, join(root, path)])),
    );
  });

  test("install detects harnesses, honors --harness, and adds targets for a newly installed CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-detect-"));
    const bin = fakePath(root, ["claude"]);
    const first = runInstall(root, bin, ["--no-system-deps"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("harnesses: claude\n");
    expect(existsSync(join(root, "home", ".claude", "agents", "kiba.md"))).toBe(true);
    expect(existsSync(join(root, "home", ".grok", "sandbox.toml"))).toBe(false);
    expect(existsSync(join(root, "home", ".local", "bin", "orch"))).toBe(true);

    symlinkSync("/bin/true", join(bin, "grok"));
    const second = runInstall(root, bin, ["--no-system-deps"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("harnesses: claude, grok\n");
    expect(existsSync(join(root, "home", ".grok", "sandbox.toml"))).toBe(true);
    rmSync(join(bin, "grok"));
    const third = runInstall(root, bin, ["--no-system-deps"]);
    expect(third.status).toBe(0);
    expect(third.stdout).toContain("kept ~/.grok/sandbox.toml (harness absent)");
    expect(existsSync(join(root, "home", ".grok", "sandbox.toml"))).toBe(true);
    rmSync(root, { recursive: true, force: true });

    const overrideRoot = mkdtempSync(join(tmpdir(), "orch-override-"));
    const overrideBin = fakePath(overrideRoot, ["grok"]);
    const overridden = runInstall(overrideRoot, overrideBin, ["--dry-run", "--no-system-deps", "--harness", "claude,codex"]);
    expect(overridden.status).toBe(0);
    expect(overridden.stdout).toContain("harnesses: claude, codex\n");
    expect(overridden.stdout).toContain("~/.claude/agents/kiba.md");
    expect(overridden.stdout).not.toContain("~/.grok/");
    rmSync(overrideRoot, { recursive: true, force: true });
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
    mkdirSync(join(other, ".claude", "agents"), { recursive: true });
    writeFileSync(join(other, ".claude", "agents", "kiba.md"), "someone else's lead");
    const acts = plan(other, targets, null);
    expect(acts.find((a) => a.path === ".claude/agents/kiba.md")?.op).toBe("conflict");
    expect(() => apply(other, join(other, "st"), "max20", targets, acts)).toThrow();
    rmSync(other, { recursive: true, force: true });
  });

  test("uninstall keeps an edited file and removes the rest", () => {
    const edited = join(home, ".claude", "agents", "lead-explore.md");
    writeFileSync(edited, "hand edit");
    expect(drift(home, state)).toContain("edited .claude/agents/lead-explore.md");
    const out = uninstall(home, state, false);
    expect(out).toContain("kept .claude/agents/lead-explore.md (edited since install)");
    expect(existsSync(join(home, ".claude", "agents", "kiba.md"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "lane"))).toBe(false);
    expect(existsSync(edited)).toBe(true);
    expect(readManifest(state)?.entries.map((e) => e.path)).toEqual([".claude/agents/lead-explore.md"]);
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

  test("install and dry run report removal of unchanged retired files", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-retired-remove-"));
    const bin = fakePath(root, ["claude"]);
    const installHome = join(root, "home");
    const installState = join(root, "state");
    const retired: Target[] = [
      { path: ".claude/agents/retired.md", kind: "file", content: "old\n", harness: "claude" },
      { path: ".claude/agents/legacy.md", kind: "file", content: "old\n" },
      { path: ".orch/old.txt", kind: "file", content: "old\n" },
      { path: ".orch/gone.txt", kind: "file", content: "gone\n" },
    ];
    apply(installHome, installState, profile.name, retired, plan(installHome, retired, null));
    rmSync(join(installHome, ".orch/gone.txt"));
    const manifest = readManifest(installState);
    const actions = plan(installHome, render(profile, ["claude"]), manifest);
    expect(actions.some((action) => action.path === ".orch/gone.txt")).toBe(false);
    for (const target of retired.slice(0, -1)) {
      expect(actions).toContainEqual({ path: target.path, op: "remove" });
    }

    const dry = runInstall(root, bin, ["--dry-run", "--no-system-deps"]);
    expect(dry.status).toBe(0);
    expect(readManifest(installState)).toEqual(manifest);
    for (const target of retired.slice(0, -1)) {
      expect(dry.stdout).toContain(`remove    ~/${target.path}`);
      expect(readFileSync(join(installHome, target.path), "utf8")).toBe(target.content);
    }
    const installed = runInstall(root, bin, ["--no-system-deps"]);
    expect(installed.status).toBe(0);
    for (const target of retired) {
      if (target.path !== ".orch/gone.txt") expect(installed.stdout).toContain(`remove    ~/${target.path}`);
      expect(existsSync(join(installHome, target.path))).toBe(false);
      expect(readManifest(installState)?.entries.some((entry) => entry.path === target.path)).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("install and dry run report keeping edited retired files", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-retired-edited-"));
    const bin = fakePath(root, ["claude"]);
    const installHome = join(root, "home");
    const installState = join(root, "state");
    const retired: Target[] = [
      { path: ".claude/agents/retired.md", kind: "file", content: "old\n", harness: "claude" },
      { path: ".claude/agents/legacy.md", kind: "file", content: "old\n" },
      { path: ".orch/edited.txt", kind: "file", content: "old\n" },
    ];
    apply(installHome, installState, profile.name, retired, plan(installHome, retired, null));
    for (const target of retired) writeFileSync(join(installHome, target.path), "hand edit\n");
    const manifest = readManifest(installState);
    const actions = plan(installHome, render(profile, ["claude"]), manifest);
    for (const target of retired) {
      expect(actions).toContainEqual({ path: target.path, op: "kept", reason: "edited since install" });
    }

    for (const args of [["--dry-run", "--no-system-deps"], ["--no-system-deps"]]) {
      const result = runInstall(root, bin, args);
      expect(result.status).toBe(0);
      if (args.includes("--dry-run")) expect(readManifest(installState)).toEqual(manifest);
      for (const target of retired) {
        expect(result.stdout).toContain(`kept ~/${target.path} (edited since install)`);
        expect(readFileSync(join(installHome, target.path), "utf8")).toBe("hand edit\n");
        expect(readManifest(installState)?.entries).toContainEqual(manifest?.entries.find((entry) => entry.path === target.path));
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("install keeps manifest targets for an absent harness and reports them", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-absent-"));
    const installHome = join(root, "home");
    const installState = join(root, "state");
    apply(installHome, installState, profile.name, targets, plan(installHome, targets, null));

    const claudeTargets = render(profile, ["claude"]);
    const actions = plan(installHome, claudeTargets, readManifest(installState));
    expect(actions).toContainEqual({ path: ".grok/sandbox.toml", op: "kept", reason: "harness absent" });
    expect(actions.filter((action) => action.op === "kept").map((action) => `kept ~/${action.path} (${action.reason})`)).toContain(
      "kept ~/.grok/sandbox.toml (harness absent)",
    );
    apply(installHome, installState, profile.name, claudeTargets, actions);
    expect(existsSync(join(installHome, ".grok", "sandbox.toml"))).toBe(true);
    expect(readManifest(installState)?.entries.map((entry) => entry.path)).toContain(".grok/sandbox.toml");
    const claudeDrift = drift(installHome, installState, ["claude"]);
    expect(claudeDrift.some((line) => line.endsWith(".claude/agents/kiba.md"))).toBe(true);
    expect(claudeDrift.some((line) => line.includes(".codex/") || line.includes(".grok/"))).toBe(false);

    uninstall(installHome, installState, false);
    expect(existsSync(join(installHome, ".grok", "sandbox.toml"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("the retired presence unit is never rendered; orch serve comes with Claude; routine units always", () => {
    const paths = (h: ("claude" | "codex" | "grok")[]) => render(profile, h).map((t) => t.path);
    expect(paths(["claude", "codex", "grok"])).not.toContain(".config/systemd/user/orch-kiba.service");
    expect(paths(["claude"])).toContain(".config/systemd/user/orch-serve.service");
    expect(paths(["codex"])).toContain(".config/systemd/user/orch-routines.timer");
    expect(paths(["codex"])).toContain(".config/systemd/user/orch-logs-prune.timer");
    expect(paths(["codex"])).toContain(".config/systemd/user/orch-logs-prune.service");
  });

  test("install ensures Claude cleanupPeriodDays and backs up an existing settings file", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-cleanup-"));
    const installHome = join(root, "home");
    const bin = fakePath(root, ["claude"]);
    mkdirSync(join(installHome, ".claude"), { recursive: true });
    writeFileSync(join(installHome, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark", cleanupPeriodDays: 1 }, null, 2)}\n`);
    const first = runInstall(root, bin, ["--no-system-deps"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("set ~/.claude/settings.json cleanupPeriodDays=7");
    const merged = JSON.parse(readFileSync(join(installHome, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(merged.theme).toBe("dark");
    expect(merged.cleanupPeriodDays).toBe(7);
    expect(readdirSync(join(installHome, ".claude")).some((name) => name.startsWith("settings.json.bak-orch-"))).toBe(true);
    const second = runInstall(root, bin, ["--no-system-deps"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("kept ~/.claude/settings.json cleanupPeriodDays=7");
    rmSync(root, { recursive: true, force: true });
  });

  test("a retired lead file of a selected harness is removed, not kept as absent", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-retired-"));
    const home = join(root, "home");
    const state = join(root, "state");
    mkdirSync(join(home, ".codex", "rules"), { recursive: true });
    writeFileSync(join(home, ".codex", "rules", "orch.rules"), "old rules\n");
    const targets = render(profile, ["claude", "codex"]);
    apply(home, state, profile.name, [...targets, { path: ".codex/rules/orch.rules", kind: "file", content: "old rules\n", harness: "codex" }], plan(home, [...targets, { path: ".codex/rules/orch.rules", kind: "file", content: "old rules\n", harness: "codex" }], null));
    expect(plan(home, targets, readManifest(state), ["claude", "codex"])).toContainEqual({ path: ".codex/rules/orch.rules", op: "remove" });
    expect(plan(home, targets, readManifest(state), ["claude"])).toContainEqual({ path: ".codex/rules/orch.rules", op: "kept", reason: "harness absent" });
    rmSync(root, { recursive: true, force: true });
  });
});

describe("lead launch argv", () => {
  test("a lane worker is refused before lead launch", () => {
    expect(leadGuard({ ORCH_LEAD: "1" })).toBe("lead: a lead session cannot start another lead; use a plain terminal or `env -u ORCH_LEAD kiba`");
    expect(leadGuard({ ORCH_LANE: "1" })).toBe("lead: a lane worker cannot start a lead session");
    expect(leadGuard({ ORCH_LANE: "0" })).toBeNull();
  });

  test("Claude is the only lead; a Codex or Grok first argument is parsed so it can be refused", () => {
    expect(leadAvailability((bin) => bin === "grok")).toBe(`lead: claude is not installed (detected: grok); ${CLAUDE_ONLY}`);
    expect(leadAvailability((bin) => bin === "claude")).toBeNull();
    expect(leadArgs([])).toEqual({ harness: "claude", extra: [] });
    expect(leadArgs(["--foo"])).toEqual({ harness: "claude", extra: ["--foo"] });
    expect(leadArgs(["claude", "--resume"])).toEqual({ harness: "claude", extra: ["--resume"] });
    expect(leadArgs(["claude", "--foo"])).toEqual({ harness: "claude", extra: ["--foo"] });
    expect(leadArgs(["codex", "-m", "x"])).toEqual({ harness: "codex", extra: ["-m", "x"] });
    expect(leadArgs(["grok", "x"])).toEqual({ harness: "grok", extra: ["x"] });

    const root = mkdtempSync(join(tmpdir(), "lead-absent-"));
    const bin = fakePath(root, ["grok"]);
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/lead.ts")], {
      encoding: "utf8",
      env: { ...process.env, HOME: join(root, "home"), ORCH_LANE: "0", ORCH_LEAD: "0", PATH: bin },
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(`lead: claude is not installed (detected: grok); ${CLAUDE_ONLY}`);
    rmSync(root, { recursive: true, force: true });
  });

  test("kiba started in a directory with a .env does not hand its variables to Claude", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-dotenv-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$KIBA_ARGS_FILE\"\necho \"dotenv=${ORCH_TEST_DOTENV-unset} autocompact=${CLAUDE_CODE_AUTO_COMPACT_WINDOW-unset} $*\"\n", { mode: 0o755 });
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".env"), "ORCH_TEST_DOTENV=leaked\n");
    // through the shebang, as ~/.local/bin/kiba runs it
    const oldHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const expectedFor = (extra: string[]) => leadArgv("kiba", extra).slice(1);
      const invoke = (args: string[]) => spawnSync(join(import.meta.dir, "../src/lead.ts"), args, {
        cwd: project, encoding: "utf8",
        env: { HOME: join(root, "home"), KIBA_ARGS_FILE: join(root, "argv"), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });
      const defaultLead = invoke([]);
      expect(defaultLead.status).toBe(0);
      expect(defaultLead.stdout).toContain("dotenv=unset");
      // A single native agent, with memory hooks and no mandatory worker relay.
      expect(defaultLead.stdout).toContain("--agent kiba");
      expect(defaultLead.stdout).not.toContain("--disallowedTools Bash,Edit,Write,NotebookEdit,Agent");
      expect(defaultLead.stdout).toContain("--permission-mode bypassPermissions");
      expect(defaultLead.stdout).toContain(`autocompact=${resolveLeadPolicy(loadPolicy()).autocompact_tokens}`);
      expect(readFileSync(join(root, "argv"), "utf8").trim().split("\n")).toEqual(expectedFor([]));
      const explicitClaude = invoke(["claude", "--foo"]);
      expect(explicitClaude.status).toBe(0);
      expect(readFileSync(join(root, "argv"), "utf8").trim().split("\n")).toEqual(expectedFor(["--foo"]));
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("Claude Kiba works natively; no restricted conductor argv remains", () => {
    const kiba = leadArgv();
    expect(kiba.slice(0, 3)).toEqual(["claude", "--agent", "kiba"]);
    expect(kiba).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "medium", "--permission-mode", "bypassPermissions"]));
    expect(kiba).not.toContain("--disallowedTools");
    const settings = JSON.parse(kiba[kiba.indexOf("--settings") + 1]);
    expect(settings.permissions.deny).not.toContain("Bash");
    expect(settings.permissions.deny).not.toContain("Edit");
    expect(settings.permissions.deny).toContain("Read(~/.ssh/**)");
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(JSON.parse(kiba[kiba.indexOf("--agents") + 1]).kiba.prompt).toContain("Work directly by default");
    expect(kiba).not.toContain("--mcp-config");
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(leadArgv(undefined, ["--model", "custom", "--effort", "low"])).not.toContain("opus");
    expect(leadArgv(undefined, ["--permission-mode", "plan"])).not.toContain("bypassPermissions");
    expect(leadArgv(undefined, ["--yolo"])).toContain("--dangerously-skip-permissions");
  });

  test("profile validation keeps only the Claude lead and rejects invalid review routing", () => {
    const base = loadProfile("max20");
    const older = validateProfile({ ...base, lead: { ...base.lead, codex: { model: "x" }, grok: { model: "y" } } as never });
    expect(Object.keys(older.lead)).toEqual(["claude"]);
    expect(() => validateProfile({ ...base, lead: {} as never })).toThrow("missing lead.claude");
    expect(() => validateProfile({ ...base, review: { ...base.review, grok: { ...base.review.grok, to: "unknown" as "claude" } } }))
      .toThrow("invalid review target for grok");
    expect(() => validateProfile({ ...base, review: { ...base.review, codex: { ...base.review.codex, fallback: ["unknown" as "claude"] } } }))
      .toThrow("invalid review fallback for codex");
    expect(base.limits.fresh_session_percent).toBe(60);
    expect(() => validateProfile({ ...base, limits: { ...base.limits, fresh_session_percent: 0 } }))
      .toThrow("fresh_session_percent");
  });
});

describe("external workers", () => {
  const opts = { cwd: "/w", promptPath: "/p", readOnly: false, lastMessagePath: "/l" };

  test("the Claude write worker runs Bash in the OS sandbox, never with a prompt", () => {
    const { argv } = workerArgv("claude", { model: "sonnet" }, opts);
    expect(argv).toContain("dontAsk");
    expect(argv).not.toContain("acceptEdits");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]).sandbox).toEqual(CLAUDE_SANDBOX.sandbox);
    expect(CLAUDE_SANDBOX.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(argv).toContain("Edit(/**)");
    expect(argv).not.toContain("Bash");
    // no inherited settings source may widen the worker's permissions
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
  });

  test("the Claude write worker uses file tools and still runs its targeted check after a Bash denial", () => {
    const { argv } = workerArgv("claude", {}, opts);
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("Write files with Edit or Write, never through shell redirection or shell scripts");
    expect(prompt).toContain("One denied Bash command does not mean Bash is unavailable");
    expect(prompt).toContain("do not retry the denied action through another shell command");
    expect(prompt).toContain("still run your targeted check (the test that covers your change) in a separate Bash call before reporting completion");
  });

  test("the Claude write worker must end on a LANE line, and lane reads only the last line", () => {
    const { argv } = workerArgv("claude", {}, opts);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(CLAUDE_FINISH);
    expect(workerArgv("claude", {}, { ...opts, readOnly: true }).argv).not.toContain("--append-system-prompt");
    expect(finishLine("Migrated both endpoints.\nLANE: done\n")).toBe("done");
    expect(finishLine("LANE: blocked: no DB fixture")).toBe("blocked: no DB fixture");
    expect(finishLine("Next I will update the tests.")).toBeNull();
    expect(finishLine("LANE: done\nThen I will add tests.")).toBeNull();
    expect(finishLine("LANE: blocked:")).toBeNull();
    expect(finishLine("Done.\n`LANE: done`")).toBe("done");
    expect(finishLine("**LANE: blocked: no DB fixture**")).toBe("blocked: no DB fixture");
  });

  test("resolveLaneStatus: orch VERIFY is authoritative over the worker LANE line", () => {
    expect(resolveLaneStatus({
      status: "complete", verifyOk: true, changed: true, finish: "blocked: Bash tool denied",
    })).toEqual({ status: "complete", reason: "worker blocked: Bash tool denied" });
    expect(resolveLaneStatus({
      status: "complete", verifyOk: false, changed: true, finish: "done",
    })).toEqual({ status: "failed" });
    expect(resolveLaneStatus({
      status: "noop", verifyOk: true, changed: false, finish: "blocked: no fixture",
    }).status).toBe("blocked");
  });

  test("the read-only Claude worker is tool-scoped, not plan mode", () => {
    const argv = workerArgv("claude", { model: "haiku" }, { ...opts, readOnly: true }).argv;
    expect(argv).toContain("haiku");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Bash");
    expect(argv).not.toContain("plan");
    expect(argv).not.toContain("--permission-mode");
  });

  test("install maps missing sandbox binaries to their apt packages", () => {
    const want = process.platform === "linux" ? ["socat"] : [];
    expect(missingSystemPackages((b) => b !== "socat")).toEqual(want);
    expect(missingSystemPackages(() => true)).toEqual([]);
  });

  test("doctor reports Codex worker requirements without probing lead shell features", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-codex-lead-"));
    const which = (bin: string) => ["codex", "git"].includes(bin);
    const result = doctorChecks(home, which, () => true);
    // Codex is a lane worker: without Claude there is no lead to run.
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("ok   memory provider hindsight");
    expect(result.lines).toContain("ok   codex worker");
    expect(result.lines.some((line) => line.includes("codex lead"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
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
    const grokProfile = render(profile, ["claude", "codex", "grok"]).find((t) => t.path === ".grok/sandbox.toml");
    expect(grokProfile?.content).toMatch(/\[profiles\.orch-lane\]\nextends = "workspace"\nrestrict_network = true/);
    expect(grokProfile?.content).toMatch(/\[profiles\.orch-review\]\nextends = "read-only"\nrestrict_network = true/);
    for (const p of ["~/.grok/agents", "~/.grok/bin", "~/.grok/downloads"]) expect(grokProfile?.content).toContain(`"${p}"`);
  });

  test("install adopts an empty pre-existing file, never a non-empty one", () => {
    const home = mkdtempSync(join(tmpdir(), "adopt-"));
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "sandbox.toml"), "");
    const t = render(profile, ["claude", "codex", "grok"]).filter((x) => x.path === ".grok/sandbox.toml");
    expect(plan(home, t, null)[0].op).toBe("update");
    writeFileSync(join(home, ".grok", "sandbox.toml"), "[profiles.mine]\n");
    expect(plan(home, t, null)[0].op).toBe("conflict");
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor names each missing piece", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-"));
    const none = doctorChecks(home, (b) => b !== "socat", () => true);
    expect(none.ok).toBe(false);
    if (process.platform === "linux") expect(none.lines.join("\n")).toContain("missing socat");
    expect(doctorChecks(home, () => true, () => true).lines.join("\n")).toContain("orch-lane");
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "sandbox.toml"), render(profile, ["claude", "codex", "grok"]).find((t) => t.path === ".grok/sandbox.toml")!.content);
    expect(doctorChecks(home, () => true, () => true)).toEqual({ ok: true, lines: expect.any(Array) });
    if (process.platform === "linux") {
      const blocked = doctorChecks(home, () => true, () => false);
      expect(blocked.ok).toBe(false);
      expect(blocked.lines.join("\n")).toContain("nested user namespace");
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor skips absent harnesses and passes with one healthy lead harness", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-one-harness-"));
    const result = doctorChecks(home, (bin) => ["claude", "git", "bwrap", "socat"].includes(bin), () => true);
    expect(result.ok).toBe(true);
    expect(result.lines).toContain("skip codex (not installed)");
    expect(result.lines).toContain("skip grok (not installed)");
    expect(result.lines.some((line) => line.includes("grok worker"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor rejects an unknown memory provider and an unreachable one", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-memory-"));
    const which = (bin: string) => ["codex", "git"].includes(bin);
    const unknown = doctorChecks(home, which, () => true, { provider: "vector-db" });
    expect(unknown.ok).toBe(false);
    expect(unknown.lines.join("\n")).toContain("FAIL memory provider: unknown vector-db");
    const down = doctorChecks(home, which, () => true, { provider: "hindsight", reachable: false });
    expect(down.ok).toBe(false);
    expect(down.lines.join("\n")).toContain("FAIL memory reachability: hindsight unreachable");
    rmSync(home, { recursive: true, force: true });
  });

  test("doctor fails without any installed lead harness", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-no-lead-"));
    const result = doctorChecks(home, () => false, () => true);
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("skip claude (not installed)");
    expect(result.lines).toContain("skip codex (not installed)");
    expect(result.lines).toContain("skip grok (not installed)");
    expect(result.lines.join("\n")).toContain("FAIL lead harness: missing Claude Code (install Claude Code: Kiba runs on Claude only");
    const codexOnly = doctorChecks(home, (bin) => ["codex", "git"].includes(bin), () => true);
    expect(codexOnly.ok).toBe(false);
    // Leftover lead files of the retired Codex/Grok leads and conductor: one warning.
    mkdirSync(join(home, ".grok", "hooks"), { recursive: true });
    writeFileSync(join(home, ".grok", "hooks", "orch.json"), "{}");
    const leftover = doctorChecks(home, (bin) => ["claude", "git", "bwrap", "socat"].includes(bin), () => true).lines.filter((l) => l.startsWith("WARN retired lead files"));
    expect(leftover).toEqual([expect.stringContaining("~/.grok/hooks/orch.json")]);
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
