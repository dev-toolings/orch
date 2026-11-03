import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookPolicyDefaultsFile, loadHookPolicy, PERMISSION_DEFAULTS, type HookPermissionId } from "../src/core/hook-policy.ts";
import { runHook } from "../src/hooks/hook.ts";
import { leadSettings } from "../src/install/render.ts";
import { doctorChecks } from "../src/install/doctor.ts";

let root: string;
let env: NodeJS.ProcessEnv;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-hook-policy-"));
  env = { HOME: root, ORCH_STATE: join(root, "state"), ORCH_HOOK_POLICY: join(root, "hooks.yaml"), ORCH_LEAD: "1", ORCH_MEMORY: "off" };
  previous = process.env.ORCH_HOOK_POLICY;
  process.env.ORCH_HOOK_POLICY = env.ORCH_HOOK_POLICY;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCH_HOOK_POLICY;
  else process.env.ORCH_HOOK_POLICY = previous;
  rmSync(root, { recursive: true, force: true });
});

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const file = (tool_name: string, file_path: string) => ({ tool_name, tool_input: { file_path } });
function policy(value: unknown) { writeFileSync(env.ORCH_HOOK_POLICY!, JSON.stringify(value)); }
function decision(output: string): string {
  return output ? JSON.parse(output).hookSpecificOutput.permissionDecision : "off";
}

test("defaults preserve sensitive asks in default mode and cooperative bypass guards", () => {
  expect(loadHookPolicy(env).permissions).toEqual({
    "secrets.read": { bypass: "deny", default: "deny" },
    "secrets.edit": { bypass: "deny", default: "deny" },
    "orch.guard-files": { bypass: "off", default: "deny" },
    "rm.recursive": { bypass: "ask", default: "ask" },
    "rm.outside": { bypass: "ask", default: "ask" },
    "git.push": { bypass: "off", default: "ask" },
    "net.calls": { bypass: "off", default: "ask" },
    "git.hooks-path": { bypass: "off", default: "ask" },
    "guardrail.files": { bypass: "off", default: "ask" },
    "protected.paths": { bypass: "off", default: "ask" },
  });
  expect(loadHookPolicy({ ...env, ORCH_CONDUCTOR: "native" }).behaviors).toEqual({
    "nudge.post-edit": "off", "nudge.fresh-session": "off", "stop.lane-pending": "on",
  });
  expect(loadHookPolicy({ ...env, ORCH_CONDUCTOR: "kiba", ORCH_PRESENCE: "1" }).behaviors).toMatchObject({
    "nudge.post-edit": "on", "nudge.fresh-session": "on",
  });
});

const probes: Record<HookPermissionId, ReturnType<typeof bash> | ReturnType<typeof file>> = {
  "secrets.read": bash("cat secret.key"),
  "secrets.edit": bash("printf x > secret.key"),
  "orch.guard-files": bash("sed -i s/a/b/ src/hooks/hook.ts"),
  "rm.recursive": bash("rm -r output"),
  "rm.outside": bash("rm ../output"),
  "git.push": bash("git push origin topic"),
  "net.calls": bash("curl https://example.invalid"),
  "git.hooks-path": bash("git config core.hooksPath hooks"),
  "guardrail.files": bash("sed -i s/a/b/ package.json"),
  "protected.paths": file("Edit", "AGENTS.md"),
};
for (const id of Object.keys(probes) as HookPermissionId[]) {
  test(`${id}: live default/bypass overrides support deny, ask and off`, async () => {
    for (const mode of ["default", "bypass"] as const) {
      for (const value of ["deny", "ask", "off"] as const) {
        policy({ permissions: { [id]: { [mode]: value } } });
        expect(decision(await runHook("pre-bash", "claude", {
          ...probes[id], cwd: root, permission_mode: mode === "bypass" ? "bypassPermissions" : "default",
        }, env))).toBe(value);
        expect(loadHookPolicy(env).origins[id][mode]).toBe("file");
      }
    }
  });
}

test("file tools and shell input/output redirections distinguish secret reads and edits", async () => {
  policy({ permissions: { "secrets.read": { bypass: "off" }, "secrets.edit": { bypass: "ask" } } });
  for (const payload of [file("Read", "secret.key"), bash("cat < secret.key")]) {
    expect(await runHook("pre-bash", "claude", { ...payload, permission_mode: "bypassPermissions" }, env)).toBe("");
  }
  for (const payload of [file("Write", "secret.key"), file("Edit", "secret.key"), bash("printf x > secret.key")]) {
    expect(decision(await runHook("pre-bash", "claude", { ...payload, permission_mode: "bypassPermissions" }, env))).toBe("ask");
  }
});

test("all compound-command guards are evaluated and deny takes precedence", async () => {
  policy({ permissions: { "git.push": { bypass: "off" }, "rm.recursive": { bypass: "deny" } } });
  expect(decision(await runHook("pre-bash", "claude", {
    ...bash("git push origin topic && rm -r output"), permission_mode: "bypassPermissions",
  }, env))).toBe("deny");
});

test("headless asks become deny whatever the permission mode", async () => {
  const headless = { ...env, ORCH_HEADLESS: "1" };
  expect(decision(await runHook("pre-bash", "claude", bash("git push origin topic"), headless))).toBe("deny");
  expect(decision(await runHook("pre-bash", "claude", { ...bash("git push origin topic"), permission_mode: "default" }, headless))).toBe("deny");
});

test("credentials.json is a secret store and a plain awk read is a read", async () => {
  const read = (command: string) => runHook("pre-bash", "claude", { ...bash(command), permission_mode: "default" }, env);
  expect(decision(await read("cat credentials.json"))).toBe("deny");
  expect(decision(await runHook("pre-bash", "claude", { tool_name: "Read", tool_input: { file_path: "credentials.ts" }, permission_mode: "default" }, env))).toBe("off");
  policy({ permissions: { "secrets.read": { default: "deny" }, "secrets.edit": { default: "off" } } });
  expect(decision(await read("awk '{print}' id_rsa"))).toBe("deny");
  policy({ permissions: { "secrets.read": { default: "off" }, "secrets.edit": { default: "deny" } } });
  expect(decision(await read("awk '{print}' id_rsa"))).toBe("off");
  expect(decision(await read("perl -i -pe 's/a/b/' id_rsa"))).toBe("deny");
});

test("invalid and unreadable files discard all overrides and doctor warns", () => {
  for (const source of ["permissions: [", "permissions:\n  secrets.read: { bypass: off }\n  git.push: { default: invalid }", "behaviors: { stop.lane-pending: false }"]) {
    writeFileSync(env.ORCH_HOOK_POLICY!, source);
    const result = loadHookPolicy(env);
    expect(result.permissions).toEqual(PERMISSION_DEFAULTS);
    expect(result.error).toBeTruthy();
    expect(result.origins["secrets.read"].bypass).toBe("default");
    expect(doctorChecks(root, () => false, () => true, { provider: "brain", reachable: true }, env.ORCH_STATE).lines.join("\n")).toContain("WARN hook policy:");
  }
  rmSync(env.ORCH_HOOK_POLICY!);
  mkdirSync(env.ORCH_HOOK_POLICY!);
  expect(loadHookPolicy(env).error).toBeTruthy();
  expect(loadHookPolicy(env).permissions).toEqual(PERMISSION_DEFAULTS);
});

test("unknown ids warn and are ignored while valid overrides still apply", () => {
  policy({ permissions: { typo: "anything", "git.push": { default: "off" } }, behaviors: { typo: "anything" } });
  const result = loadHookPolicy(env);
  expect(result.error).toBeUndefined();
  expect(result.warnings).toHaveLength(2);
  expect(result.permissions["git.push"].default).toBe("off");
  expect(result.permissions["secrets.read"].default).toBe("deny");
});

test("render emits no ask and only the policy's unconditional denies, no tool denied as such", () => {
  {
    rmSync(env.ORCH_HOOK_POLICY!, { force: true });
    const baseline = JSON.parse(leadSettings()).permissions;
    expect(baseline.ask).toEqual([]);
    expect(baseline.deny).toContain("Read(~/.ssh/**)");
    expect(baseline.deny).toContain("Edit(~/.ssh/**)");
    expect(baseline.deny).not.toContain("Edit(src/hooks/hook.ts)");
    policy({ permissions: {
      "secrets.read": { bypass: "off", default: "ask" },
      "secrets.edit": { bypass: "ask", default: "deny" },
      "orch.guard-files": { bypass: "deny", default: "deny" },
    } });
    const changed = JSON.parse(leadSettings()).permissions;
    expect(changed.ask).toEqual([]);
    expect(changed.deny).not.toContain("Read(~/.ssh/**)");
    expect(changed.deny).not.toContain("Edit(~/.ssh/**)");
    expect(changed.deny).toContain("Edit(src/hooks/hook.ts)");
    expect(changed.deny.includes("Bash")).toBe(false);
  }
});

test("post-edit nudge defaults off in native and file on takes effect immediately", async () => {
  const native = { ...env, ORCH_CONDUCTOR: "native", ORCH_SESSION: "native-edits" };
  const edit = { tool_name: "Write", tool_input: { file_path: "app.ts", content: "x\n".repeat(61) } };
  expect(await runHook("post-edit", "claude", edit, native)).toBe("");
  policy({ behaviors: { "nudge.post-edit": "on" } });
  expect(await runHook("post-edit", "claude", edit, native)).toContain("Delegate the rest");
});

test("fresh-session nudge runs only in presence by default and respects off", async () => {
  const input = { cwd: root, context_window: { used_percentage: 90, context_window_size: 200_000 } };
  expect(await runHook("prompt-submit", "claude", input, { ...env, ORCH_SESSION: "standalone" })).toBe("");
  expect(await runHook("prompt-submit", "claude", input, { ...env, ORCH_SESSION: "presence", ORCH_PRESENCE: "1" })).toContain("Supervisor is starting");
  policy({ behaviors: { "nudge.fresh-session": "off" } });
  expect(await runHook("prompt-submit", "claude", input, { ...env, ORCH_SESSION: "disabled", ORCH_PRESENCE: "1" })).toBe("");
});

test("stop.lane-pending off disables a real pending-lane block", async () => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.name=policy-test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
  writeFileSync(join(root, "app.txt"), "change");
  git("add", "app.txt");
  git("-c", "user.name=policy-test", "-c", "user.email=test@example.invalid", "commit", "-qm", "change");
  git("branch", "lane/policy");
  git("reset", "--hard", "HEAD~1");
  const lane = join(env.ORCH_STATE!, "lanes", "policy");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "state.json"), JSON.stringify({ id: "policy", repo: root, branch: "lane/policy", status: "complete", session: "stop", to: "claude", changed: true }));
  const input = { cwd: root, session_id: "stop" };
  policy({ behaviors: { "stop.lane-pending": "off" } });
  expect(await runHook("stop", "claude", input, env)).toBe("");
  policy({ behaviors: { "stop.lane-pending": "on" } });
  expect(JSON.parse(await runHook("stop", "claude", input, env)).decision).toBe("block");
});

test("the retired codex.conductor-deny behavior is ignored without a warning, and a Codex lead hook does nothing", async () => {
  policy({ behaviors: { "codex.conductor-deny": "off" } });
  const result = loadHookPolicy(env);
  expect(result.warnings).toEqual([]);
  expect(Object.keys(result.behaviors)).not.toContain("codex.conductor-deny");
  expect(await runHook("pre-bash", "codex", bash("ls"), { ...env, ORCH_CONDUCTOR: "kiba" })).toBe("");
});

test("policy CLI shows origins, creates through EDITOR and resets to contextual defaults", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "../src/orch.ts"), "policy", ...args], {
    encoding: "utf8", env: { ...process.env, ...env, ORCH_CONDUCTOR: "native", EDITOR: "true" },
  });
  expect(cli("edit").status).toBe(0);
  expect(readFileSync(env.ORCH_HOOK_POLICY!, "utf8")).toBe(hookPolicyDefaultsFile());
  policy({ permissions: { "git.push": { bypass: "deny" } } });
  const shown = cli("show");
  expect(shown.status).toBe(0);
  expect(shown.stdout).toContain("git.push\tdeny\task\tfile/default");
  expect(shown.stdout).toContain("Inherited user/managed permissions");
  expect(cli("reset").status).toBe(0);
  expect(loadHookPolicy(env).permissions).toEqual(PERMISSION_DEFAULTS);
  expect(loadHookPolicy({ ...env, ORCH_CONDUCTOR: "native" }).behaviors["nudge.post-edit"]).toBe("off");
});
