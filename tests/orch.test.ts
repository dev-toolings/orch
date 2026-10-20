import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadArgv } from "../src/lead.ts";
import { apply, drift, plan, readManifest, uninstall } from "../src/manifest.ts";
import { loadProfile } from "../src/profile.ts";
import { leadPrompt, render } from "../src/render.ts";
import { doctorChecks } from "../src/doctor.ts";
import { CLAUDE_SANDBOX, workerArgv } from "../src/harness.ts";

let home: string;
let state: string;
const targets = render(loadProfile("max20"));

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  home = join(root, "home");
  state = join(root, "state");
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "project-auditor.md"), "user file");
});
afterAll(() => rmSync(join(home, ".."), { recursive: true, force: true }));

describe("render", () => {
  test("Claude lead pins the profile model, Grok files never do", () => {
    const by = Object.fromEntries(targets.map((t) => [t.path, t.content]));
    expect(by[".claude/agents/lead.md"]).toContain("model: opus");
    expect(by[".claude/agents/lead.md"]).toContain("effort: high");
    expect(by[".grok/agents/lead.md"]).not.toMatch(/^model:/m);
    expect(by[".grok/agents/lead-explore.md"]).not.toMatch(/^model:/m);
    // Codex gets no agent file, only the exec-policy rule for lane and orch.
    expect(targets.filter((t) => t.path.startsWith(".codex/")).map((t) => t.path)).toEqual([".codex/rules/orch.rules"]);
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
});

describe("lead launch argv", () => {
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

  test("Claude and Grok select the installed lead agent", () => {
    expect(leadArgv("claude", "max20")).toEqual(["claude", "--agent", "lead", "--model", "opus", "--effort", "high"]);
    expect(leadArgv("grok", "max20")).toEqual(["grok", "--agent", "lead"]);
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
  });

  test("the read-only Claude worker stays in plan mode", () => {
    expect(workerArgv("claude", {}, { ...opts, readOnly: true }).argv).toContain("plan");
  });

  test("install ships the Codex lead rule for lane and orch", () => {
    const rule = render(loadProfile("max20")).find((t) => t.path === ".codex/rules/orch.rules");
    expect(rule?.content).toContain('pattern = ["lane", ["run", "review", "status", "gc"]]');
    expect(rule?.content).toContain('pattern = ["orch", ["mem", "docs"]]');
  });

  test("doctor names each missing piece", () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-"));
    const none = doctorChecks(home, (b) => b !== "socat");
    expect(none.ok).toBe(false);
    expect(none.lines.join("\n")).toContain("orch.rules");
    if (process.platform === "linux") expect(none.lines.join("\n")).toContain("missing socat");
    mkdirSync(join(home, ".codex", "rules"), { recursive: true });
    writeFileSync(join(home, ".codex", "rules", "orch.rules"), "x");
    expect(doctorChecks(home, () => true)).toEqual({ ok: true, lines: expect.any(Array) });
    rmSync(home, { recursive: true, force: true });
  });
});
