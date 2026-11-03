import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, type MemoryDeps } from "../src/hooks/hook.ts";
import type { RecallHit, RetainItem } from "../src/memory/hindsight.ts";
import { readSpend } from "../src/core/policy.ts";

let root: string;
let state: string;
let fakeHome: string;
let readyRepos: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-hook-test-"));
  state = join(root, "state");
  fakeHome = join(root, "home");
  mkdirSync(state, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const repo = mkdtempSync(join(root, "repo-"));
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=hook-test", "-c", "user.email=hook@test.invalid", "commit", "--allow-empty", "-qm", "base"]);
    readyRepos.push(repo);
  }
}, 30_000);

afterAll(() => rmSync(root, { recursive: true, force: true }), 30_000);

function env(session: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ORCH_LEAD: "1", ORCH_SESSION: session, ORCH_STATE: state, HOME: fakeHome, ORCH_HOOK_POLICY: join(root, "hooks.yaml"), ...extra };
}

function bash(command: string, name = "Bash") {
  return { tool_name: name, tool_input: { command } };
}

function toolEdit(name: string, file: string, input: Record<string, unknown>) {
  return { tool_name: name, tool_input: { file_path: file, ...input } };
}

function memoryFakes(hits: RecallHit[] = []): {
  deps: MemoryDeps;
  recalls: Array<{ query: string; bank?: string; max_tokens?: number }>;
  retained: Array<{ items: RetainItem[]; bank?: string; async?: boolean }>;
  formatted: RecallHit[][];
} {
  const recalls: Array<{ query: string; bank?: string; max_tokens?: number }> = [];
  const retained: Array<{ items: RetainItem[]; bank?: string; async?: boolean }> = [];
  const formatted: RecallHit[][] = [];
  const deps: MemoryDeps = {
    config: () => ({ url: "http://localhost", bank: "kiba", recall_max_tokens: 1500, recall_budget: "low", timeout_ms: 4000 }),
    recall: async (_config, query, options) => {
      recalls.push({ query, bank: options?.bank, max_tokens: options?.max_tokens });
      const value = options?.bank === "kiba" ? hits.slice(0, 1) : hits.slice(1);
      return { ok: true, value };
    },
    retain: async (_config, items, options) => {
      retained.push({ items, bank: options?.bank, async: options?.async });
      return { ok: true, value: { items_count: items.length } };
    },
    format: (items) => {
      formatted.push(items);
      return items.map((hit) => hit.text).join("\n");
    },
  };
  return { deps, recalls, retained, formatted };
}

function laneRepo(): string {
  return readyRepos.pop() ?? (() => { throw new Error("laneRepo: pool empty"); })();
}

function addLane(repo: string, id: string, session: string) {
  const branch = `lane/${id}`;
  writeFileSync(join(repo, `${id}.txt`), id);
  execFileSync("git", ["-C", repo, "add", `${id}.txt`]);
  execFileSync("git", ["-C", repo, "-c", "user.name=hook-test", "-c", "user.email=hook@test.invalid", "commit", "-qm", id]);
  execFileSync("git", ["-C", repo, "branch", branch]);
  execFileSync("git", ["-C", repo, "reset", "-q", "--hard", "HEAD~1"]);
  const dir = join(state, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    id, to: "claude", repo, base: "", branch, worktree: "", status: "complete", changed: true,
    usage: {}, started: "", ended: "", session,
  }));
}

test("benchmark receipts attest hook execution without recording recalled text", async () => {
  const fake = memoryFakes([{ id: "one", type: "world", text: "private recalled body" }]);
  const scoped = join(root, "receipt-state");
  await runHook("prompt-submit", "claude", { prompt: "Where is the memory database running?", cwd: root }, env("receipt", { ORCH_STATE: scoped, ORCH_BENCH_RUN: "run", ORCH_MEM_SANDBOX: join(root, "sandbox"), ORCH_MEMORY_PROVIDER: "hindsight" }), fake.deps);
  const text = readFileSync(join(scoped, "hooks", "bench-receipts.jsonl"), "utf8");
  expect(JSON.parse(text)).toMatchObject({ run: "run", session: "receipt", event: "prompt-submit", provider: "hindsight" });
  expect(text).not.toContain("private recalled body");
});

describe("lead lifecycle hooks", () => {
  test("non-lead sessions get no output", async () => {
    expect(await runHook("pre-bash", "claude", bash('codex exec "q"'), { ORCH_SESSION: "plain" })).toBe("");
  });

  test("new Claude memory events stay silent for Codex and Grok", async () => {
    const fake = memoryFakes();
    for (const harness of ["codex", "grok"] as const) {
      expect(await runHook("session-start", harness, {}, env(`new-event-start-${harness}`), fake.deps)).toBe("");
      expect(await runHook("post-tool", harness, {}, env(`new-event-tool-${harness}`), fake.deps)).toBe("");
    }
    expect(fake.recalls).toHaveLength(0);
    expect(fake.retained).toHaveLength(0);
  });

  test("pre-bash closes stdin and nudges once per session", async () => {
    const first = JSON.parse(await runHook("pre-bash", "claude", bash('codex exec "q" &'), env("pre-once")));
    expect(first.hookSpecificOutput.updatedInput.command).toBe('{\ncodex exec "q" &\n} < /dev/null');
    expect(first.hookSpecificOutput.additionalContext).toContain("lane ask");
    expect(first.hookSpecificOutput).not.toHaveProperty("permissionDecision"); // an allow would skip Claude's permission flow

    const second = JSON.parse(await runHook("pre-bash", "claude", bash('codex exec "q" &'), env("pre-once")));
    expect(second.hookSpecificOutput.updatedInput.command).toBe('{\ncodex exec "q" &\n} < /dev/null');
    expect(second.hookSpecificOutput).not.toHaveProperty("additionalContext");
  });

  test("pre-bash catches another harness's binary: a Claude lead running codex exec in the background", async () => {
    const out = JSON.parse(await runHook("pre-bash", "claude", bash('codex exec -m gpt-6.1-sol "q" > out.txt &'), env("cross")));
    expect(out.hookSpecificOutput.updatedInput.command).toEndWith("} < /dev/null");
    expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    const global = JSON.parse(await runHook("pre-bash", "claude", bash("codex -m x exec q"), env("cross-global")));
    expect(global.hookSpecificOutput.updatedInput.command).toEndWith("} < /dev/null");
  });

  test("Claude pre-bash asks on git push, network, secrets and protected edits", async () => {
    const ask = (output: string, reason: RegExp) => {
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
    };
    const deny = (output: string, reason: RegExp) => {
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
    };
    ask(await runHook("pre-bash", "claude", bash("git push origin feat"), env("ask-push")), /git push/);
    ask(await runHook("pre-bash", "claude", bash("curl https://example.invalid"), env("ask-curl")), /network/);
    ask(await runHook("pre-bash", "claude", bash("rm -rf /tmp/x"), env("ask-rm")), /rm/);
    deny(await runHook("pre-bash", "claude", bash("cat .env.local"), env("ask-env")), /untracked env file/);
    ask(await runHook("pre-bash", "claude", {
      tool_name: "Edit", tool_input: { file_path: "CLAUDE.md", old_string: "a", new_string: "b" },
    }, env("ask-edit-claude")), /CLAUDE.md/);
    ask(await runHook("pre-bash", "claude", {
      tool_name: "Write", tool_input: { file_path: ".github/workflows/ci.yml", content: "x" },
    }, env("ask-write-github")), /\.github/);
    const absRepo = process.cwd();
    ask(await runHook("pre-bash", "claude", {
      cwd: absRepo,
      tool_name: "Edit", tool_input: { file_path: join(absRepo, "CLAUDE.md"), old_string: "a", new_string: "b" },
    }, env("ask-edit-abs-claude")), /CLAUDE.md/);
    ask(await runHook("pre-bash", "claude", {
      cwd: absRepo,
      tool_name: "Write", tool_input: { file_path: join(absRepo, ".github", "workflows", "x.yml"), content: "x" },
    }, env("ask-write-abs-github")), /\.github/);
    expect(await runHook("pre-bash", "claude", bash("git status"), env("ask-ok"))).toBe("");
    expect(await runHook("pre-bash", "claude", bash("grep -n -i -E 'SENTRY|ERRORTRACK' .env.example .env.dev"), env("ask-sentry-env"))).toBe("");
    expect(await runHook("pre-bash", "claude", bash("cat config/packages/sentry.yaml; grep -n -i sentry composer.lock; grep -rn -i sentry config/bundles.php src"), env("ask-sentry-cfg"))).toBe("");
    // Kiba runs on Claude only: a leftover Codex lead hook does nothing.
    expect(await runHook("pre-bash", "codex", bash("git push origin feat"), env("codex-push"))).toBe("");
  });

  test("Claude pre-bash in bypassPermissions asks only for destructive rm", async () => {
    const ask = (output: string, reason: RegExp) => {
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
    };
    const bypass = (payload: Record<string, unknown>) => ({ ...payload, permission_mode: "bypassPermissions" });
    const protectedEdit = {
      tool_name: "Edit", tool_input: { file_path: "CLAUDE.md", old_string: "a", new_string: "b" },
    };
    expect(await runHook("pre-bash", "claude", bypass(bash("git push origin feat")), env("bypass-push"))).toBe("");
    expect(await runHook("pre-bash", "claude", bypass(bash("curl x")), env("bypass-curl"))).toBe("");
    expect(await runHook("pre-bash", "claude", bypass(protectedEdit), env("bypass-edit"))).toBe("");
    ask(await runHook("pre-bash", "claude", bypass(bash("rm -rf x")), env("bypass-rm-rf")), /recursive rm/);
    ask(await runHook("pre-bash", "claude", bypass(bash("rm ../x")), env("bypass-rm-out")), /outside/);
    const deny = (output: string, reason: RegExp) => {
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
    };
    deny(await runHook("pre-bash", "claude", bypass(bash("cat .env.local")), env("bypass-env")), /untracked env file/);
    deny(await runHook("pre-bash", "claude", bypass(bash("cat ~/.ssh/id_ed25519")), env("bypass-ssh")), /private key/);
    deny(await runHook("pre-bash", "claude", bypass(bash("cat ~/.ssh/config")), env("bypass-ssh-dir")), /ssh path/);
    deny(await runHook("pre-bash", "claude", bypass(bash("cat ~/.aws/credentials")), env("bypass-aws")), /credential store/);
    deny(await runHook("pre-bash", "claude", bypass(bash("cat key.pem")), env("bypass-pem")), /private key/);
    deny(await runHook("pre-bash", "claude", bypass({
      tool_name: "Read", tool_input: { file_path: ".env.local" },
    }), env("bypass-read-env")), /untracked env file/);
    deny(await runHook("pre-bash", "claude", bypass({
      tool_name: "Write", tool_input: { file_path: "id_rsa", content: "x" },
    }), env("bypass-write-id")), /private key/);
    for (const payload of [
      { tool_name: "Edit", tool_input: { file_path: "src/hooks/hook.ts", old_string: "a", new_string: "b" } },
      { tool_name: "Write", tool_input: { file_path: ".claude/orch/lead-settings.json", content: "{}" } },
      { tool_name: "Edit", tool_input: { file_path: "catalog/policy.yaml", old_string: "a", new_string: "b" } },
      bash("sed -i s/x/y/ src/hooks/hook.ts"),
    ]) {
      expect(await runHook("pre-bash", "claude", bypass(payload), env("bypass-guard"))).toBe("");
      deny(await runHook("pre-bash", "claude", { ...payload, permission_mode: "default" }, env("default-guard")), /orch guard/);
    }
    ask(await runHook("pre-bash", "claude", { ...bash("git push origin feat"), permission_mode: "default" }, env("default-push")), /git push/);
    ask(await runHook("pre-bash", "claude", { ...bash("curl x"), permission_mode: "default" }, env("default-curl")), /network/);
    ask(await runHook("pre-bash", "claude", { ...protectedEdit, permission_mode: "default" }, env("default-edit")), /CLAUDE.md/);
    for (const mode of ["auto", "acceptEdits", "plan"]) {
      ask(await runHook("pre-bash", "claude", { ...bash("git push origin feat"), permission_mode: mode }, env(`mode-${mode}-push`)), /git push/);
    }
    ask(await runHook("pre-bash", "claude", bash("git push origin feat"), env("missing-push")), /git push/);
    ask(await runHook("pre-bash", "claude", bash("curl x"), env("missing-curl")), /network/);
    ask(await runHook("pre-bash", "claude", protectedEdit, env("missing-edit")), /CLAUDE.md/);
    expect(await runHook("pre-bash", "codex", { ...bash("codex exec q"), permission_mode: "bypassPermissions" }, env("codex-deny-bypass"))).toBe("");
  });

  test("pre-bash leaves inspections and provided stdin untouched", async () => {
    for (const command of [
      "codex --version",
      "codex features list",
      "codex mcp list",
      "codex login status",
      "codex exec - < f.md",
      "printf q | codex exec -",
      "codex exec - <<EOF\nq\nEOF",
    ]) {
      expect(await runHook("pre-bash", "claude", bash(command), env("pre-silent-" + command.length))).toBe("");
    }
  });

  test("post-edit nudges at the threshold once and resets on prompt-submit", async () => {
    const session = "edit-threshold";
    expect(await runHook("post-edit", "claude", toolEdit("Write", "a.ts", { content: "a\n" }), env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "b.ts", { content: "b\n" }), env(session))).toBe("");
    const crossed = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "c.ts", { content: "c\n" }), env(session)));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("3 files, 3 lines");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "d.ts", { content: "d\n" }), env(session))).toBe("");
    expect(await runHook("prompt-submit", "claude", {}, env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "e.ts", { content: "e\n" }), env(session))).toBe("");
    expect(await runHook("post-edit", "claude", toolEdit("Write", "f.ts", { content: "f\n" }), env(session))).toBe("");
    const afterReset = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "g.ts", { content: "g\n" }), env(session)));
    expect(afterReset.hookSpecificOutput.additionalContext).toContain("3 files, 3 lines");
  });

  test("post-tool counts Edit|Write like post-edit and leaves the other tools out of the count", async () => {
    const session = "post-tool-edit";
    expect(await runHook("post-tool", "claude", toolEdit("Write", "a.ts", { content: "a\n" }), env(session))).toBe("");
    expect(await runHook("post-tool", "claude", { tool_name: "Read", tool_input: { file_path: "b.ts" } }, env(session))).toBe("");
    expect(await runHook("post-tool", "claude", toolEdit("Write", "c.ts", { content: "c\n" }), env(session))).toBe("");
    const crossed = JSON.parse(await runHook("post-tool", "claude", toolEdit("Edit", "d.ts", { old_string: "x", new_string: "y" }), env(session)));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("3 files, 3 lines");
  });

  test("post-tool still counts Edit|Write when the turn log cannot be written", async () => {
    const session = "log-unwritable";
    mkdirSync(join(state, "hooks", `${session}.turn.jsonl`), { recursive: true });
    const content = Array.from({ length: 61 }, () => "line").join("\n");
    const crossed = JSON.parse(await runHook("post-tool", "claude", toolEdit("Write", "large.ts", { content }), env(session)));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("1 files, 61 lines");
  });

  test("a tool summary that lands after the Stop reset stays out of the next turn's retain", async () => {
    const fake = memoryFakes();
    const session = "late-summary";
    const e = env(session);
    await runHook("prompt-submit", "claude", { prompt: "first turn of this session" }, e, fake.deps);
    await runHook("post-tool", "claude", { tool_name: "Read", tool_input: { file_path: "src/a.ts" }, tool_response: {} }, e, fake.deps);
    await runHook("stop", "claude", { session_id: session, cwd: "/repo/alpha", last_assistant_message: "a".repeat(80) }, e, fake.deps);
    // The background hook of turn 1 lands after that Stop: its line carries turn 1.
    writeFileSync(join(state, "hooks", `${session}.turn.jsonl`), JSON.stringify({ t: new Date().toISOString(), tool: "Grep", summary: "late", failed: false, turn: 1 }) + "\n");
    await runHook("prompt-submit", "claude", { prompt: "second turn of this session" }, e, fake.deps);
    await runHook("post-tool", "claude", { tool_name: "Read", tool_input: { file_path: "src/b.ts" }, tool_response: {} }, e, fake.deps);
    await runHook("stop", "claude", { session_id: session, cwd: "/repo/alpha", last_assistant_message: "b".repeat(80) }, e, fake.deps);
    expect(fake.retained).toHaveLength(2);
    const second = fake.retained[1].items[0].content;
    expect(second).toContain("OUTILS : 1 appels");
    expect(second).toContain("- Read src/b.ts");
    expect(second).not.toContain("late");
  });

  test("post-edit also nudges after more than 60 lines in one file", async () => {
    const content = Array.from({ length: 61 }, () => "line").join("\n");
    const crossed = JSON.parse(await runHook("post-edit", "claude", toolEdit("Write", "large.ts", { content }), env("edit-lines")));
    expect(crossed.hookSpecificOutput.additionalContext).toContain("1 files, 61 lines");
  });

  test("ORCH_MEMORY=off keeps every hook but the living memory: no injection, no recall, no retain", async () => {
    const fake = memoryFakes([{ id: "hit", text: "remembered", type: "world", scores: { final: 1 } }]);
    const off = env("memory-off", { ORCH_MEMORY: "off" });
    expect(await runHook("session-start", "claude", { cwd: root }, off, fake.deps)).toBe("");
    expect(await runHook("prompt-submit", "claude", { prompt: "où tourne la base mémoire ?", cwd: root }, off, fake.deps)).toBe("");
    expect(await runHook("post-tool", "claude", bash("ls"), off, fake.deps)).toBe("");
    await runHook("stop", "claude", { last_assistant_message: "x".repeat(80), cwd: root }, off, fake.deps);
    expect(fake.recalls).toHaveLength(0);
    expect(fake.retained).toHaveLength(0);
    // the bash guard still runs
    expect(await runHook("pre-bash", "claude", bash("claude -p hi"), off, fake.deps)).not.toBe("");
  });

  test("session-start injects capped notes and sorted recalls, then returns empty when none exist", async () => {
    const notes = join(state, "kiba-memory");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "USER.md"), "operator preferences");
    writeFileSync(join(notes, "MEMORY.md"), "m".repeat(2301));
    const oldQueue = join(state, "hooks", "start-memory.turn.jsonl");
    mkdirSync(join(state, "hooks"), { recursive: true });
    writeFileSync(oldQueue, "old turn\n");
    const hits: RecallHit[] = [
      { id: "operator", text: "operator hit", type: "world", scores: { final: 0.2 } },
      { id: "project", text: "project hit", type: "experience", scores: { final: 0.9 } },
    ];
    const fake = memoryFakes(hits);
    const output = JSON.parse(await runHook("session-start", "claude", {
      session_id: "start-memory", cwd: "/repo/alpha", source: "startup",
    }, env("start-memory"), fake.deps));
    const context = output.hookSpecificOutput.additionalContext as string;
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(context).toContain("USER.md:\noperator preferences");
    expect(context).toContain(`MEMORY.md:\n${"m".repeat(2200)}\n[tronqué: 101 caractères de trop]`);
    expect(context.endsWith("project hit\noperator hit")).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "hooks", "start-memory.json"), "utf8")).recalled)
      .toEqual(["project", "operator"]);
    expect(fake.recalls.map((call) => call.bank).sort()).toEqual(["kiba", "kiba-alpha"]);
    expect(fake.recalls[0].max_tokens).toBe(800);
    expect(readFileSync(oldQueue, "utf8")).toBe("");

    rmSync(join(notes, "USER.md"));
    rmSync(join(notes, "MEMORY.md"));
    const empty = memoryFakes();
    expect(await runHook("session-start", "claude", { session_id: "start-empty", cwd: "/repo/alpha" }, env("start-empty"), empty.deps)).toBe("");
  });

  test("a session in a subfolder or a linked worktree recalls the repository's bank", async () => {
    const repo = join(mkdtempSync(join(tmpdir(), "hook-bank-")), "beta");
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", join(repo, "..", "wt-C")]);
    for (const cwd of [join(repo, "src"), join(repo, "..", "wt-C")]) {
      const fake = memoryFakes([{ id: "hit", text: "remembered", type: "world", scores: { final: 1 } }]);
      await runHook("prompt-submit", "claude", { session_id: "bank-key", cwd, prompt: "Please help me with this task" }, env("bank-key"), fake.deps);
      expect(fake.recalls.map((call) => call.bank).sort()).toEqual(["kiba", "kiba-beta"]);
    }
    rmSync(join(repo, ".."), { recursive: true, force: true });
  }, 20_000);

  test("prompt-submit recalls qualifying Claude prompts and stores the bounded prompt", async () => {
    const fake = memoryFakes([{ id: "hit", text: "remembered", type: "world", scores: { final: 1 } }]);
    const promptText = "Please help me with this task";
    const output = JSON.parse(await runHook("prompt-submit", "claude", {
      session_id: "prompt-memory", cwd: "/repo/alpha", prompt: promptText,
    }, env("prompt-memory"), fake.deps));
    expect(output.hookSpecificOutput.additionalContext).toBe("Souvenirs :\nremembered");
    expect(fake.recalls).toHaveLength(2);
    expect(fake.recalls.every((call) => call.query === promptText && call.max_tokens === 1500)).toBe(true);
    expect(fake.recalls.map((call) => call.bank).sort()).toEqual(["kiba", "kiba-alpha"]);
    expect(JSON.parse(readFileSync(join(state, "hooks", "prompt-memory.json"), "utf8")).turnPrompt).toBe(promptText);

    const skipped = memoryFakes();
    expect(await runHook("prompt-submit", "claude", { prompt: "/help command" }, env("prompt-slash"), skipped.deps)).toBe("");
    expect(await runHook("prompt-submit", "claude", { prompt: "12345678901" }, env("prompt-short"), skipped.deps)).toBe("");
    expect(skipped.recalls).toHaveLength(0);
  });

  test("recall privacy filtering applies before either memory provider is called", async () => {
    const fake = memoryFakes();
    await runHook("prompt-submit", "claude", { session_id: "private-query", cwd: "/repo/alpha", prompt: "Find example@example.test in /home/example/project" }, env("private-query"), fake.deps);
    expect(fake.recalls).toHaveLength(2);
    expect(fake.recalls.every((call) => call.query === "Find [email] in /home/[user]/project")).toBe(true);
    const blocked = memoryFakes();
    expect(await runHook("prompt-submit", "claude", { session_id: "secret-query", cwd: "/repo/alpha", prompt: "Find OPENAI_API_KEY=sk-secretvalue1234567890" }, env("secret-query"), blocked.deps)).toBe("");
    expect(blocked.recalls).toHaveLength(0);
    expect(readFileSync(join(state, "hooks", "hindsight.log"), "utf8")).not.toContain("sk-secretvalue1234567890");
  });

  test("prompt-submit does not inject the same recall hit twice in one session", async () => {
    const fake = memoryFakes([{ id: "repeat-hit", text: "remembered once", type: "world", scores: { final: 1 } }]);
    const sessionEnv = env("prompt-memory-dedup");
    const first = await runHook("prompt-submit", "claude", {
      session_id: "prompt-memory-dedup", prompt: "Please recall this memory", cwd: "/repo/alpha",
    }, sessionEnv, fake.deps);
    expect(first).toContain("remembered once");

    const second = await runHook("prompt-submit", "claude", {
      session_id: "prompt-memory-dedup", prompt: "Please recall this memory again", cwd: "/repo/alpha",
    }, sessionEnv, fake.deps);
    expect(second).toBe("");
    expect(JSON.parse(readFileSync(join(state, "hooks", "prompt-memory-dedup.json"), "utf8")).recalled)
      .toEqual(["repeat-hit"]);
  });

  test("prompt-submit prioritizes project hits and lets operator hits fill the full budget when project is empty", async () => {
    const projectHits: RecallHit[] = [
      { id: "project-1", text: "p1", type: "world", scores: { final: 0.8 } },
      { id: "project-2", text: "p2", type: "world", scores: { final: 0.7 } },
    ];
    const operatorHits: RecallHit[] = [
      { id: "operator-1", text: "o1", type: "world", scores: { final: 0.9 } },
      { id: "operator-2", text: "o2", type: "world", scores: { final: 0.6 } },
    ];
    const fake = memoryFakes();
    fake.deps.config = () => ({ url: "http://localhost", bank: "kiba", recall_max_tokens: 10, recall_budget: "low", timeout_ms: 4000 });
    fake.deps.recall = async (_config, query, options) => {
      fake.recalls.push({ query, bank: options?.bank, max_tokens: options?.max_tokens });
      return { ok: true, value: options?.bank === "kiba-alpha" ? projectHits : operatorHits };
    };
    fake.deps.format = (hits) => {
      fake.formatted.push(hits);
      return hits.map((hit) => hit.text).join("\n");
    };
    const output = JSON.parse(await runHook("prompt-submit", "claude", {
      session_id: "prompt-project-priority", prompt: "Which memories should be returned?", cwd: "/repo/alpha",
    }, env("prompt-project-priority"), fake.deps));
    expect(output.hookSpecificOutput.additionalContext).toBe("Souvenirs :\np1\np2\no1");
    expect(fake.formatted[0].map((hit) => hit.id)).toEqual(["project-1", "project-2", "operator-1"]);

    const emptyProject = memoryFakes();
    emptyProject.deps.config = fake.deps.config;
    emptyProject.deps.recall = async (_config, query, options) => {
      emptyProject.recalls.push({ query, bank: options?.bank, max_tokens: options?.max_tokens });
      return { ok: true, value: options?.bank === "kiba-alpha" ? [] : [
        { id: "operator-a", text: "a", type: "world", scores: { final: 0.9 } },
        { id: "operator-b", text: "b", type: "world", scores: { final: 0.8 } },
        { id: "operator-c", text: "c", type: "world", scores: { final: 0.7 } },
        { id: "operator-d", text: "d", type: "world", scores: { final: 0.6 } },
      ] };
    };
    emptyProject.deps.format = (hits) => {
      emptyProject.formatted.push(hits);
      return hits.map((hit) => hit.text).join("\n");
    };
    const emptyOutput = JSON.parse(await runHook("prompt-submit", "claude", {
      session_id: "prompt-empty-project-budget", prompt: "Return available operator memories", cwd: "/repo/alpha",
    }, env("prompt-empty-project-budget"), emptyProject.deps));
    expect(emptyOutput.hookSpecificOutput.additionalContext).toBe("Souvenirs :\na\nb\nc");
    expect(emptyProject.formatted[0].map((hit) => hit.id)).toEqual(["operator-a", "operator-b", "operator-c"]);
  });

  test("prompt-submit skips an oversized first hit and recalls a later hit within budget", async () => {
    const fake = memoryFakes();
    fake.deps.config = () => ({ url: "http://localhost", bank: "kiba", recall_max_tokens: 5, recall_budget: "low", timeout_ms: 4000 });
    fake.deps.recall = async (_config, query, options) => {
      fake.recalls.push({ query, bank: options?.bank, max_tokens: options?.max_tokens });
      return { ok: true, value: options?.bank === "kiba-alpha" ? [
        { id: "too-large", text: "x".repeat(50), type: "world", scores: { final: 1 } },
        { id: "small-later", text: "p2", type: "world", scores: { final: 0.8 } },
      ] : [] };
    };
    fake.deps.format = (hits) => {
      fake.formatted.push(hits);
      return hits.map((hit) => hit.text).join("\n");
    };

    const output = await runHook("prompt-submit", "claude", {
      session_id: "prompt-skip-oversized", prompt: "Return a memory that fits", cwd: "/repo/alpha",
    }, env("prompt-skip-oversized"), fake.deps);

    expect(output).toContain("p2");
    expect(fake.formatted[0].map((hit) => hit.id)).toEqual(["small-later"]);
    expect(JSON.parse(readFileSync(join(state, "hooks", "prompt-skip-oversized.json"), "utf8")).recalled)
      .toEqual(["small-later"]);
  });

  test("prompt-submit reads a prior state file without recalled ids", async () => {
    const session = "prompt-memory-old-state";
    const hooks = join(state, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, `${session}.json`), JSON.stringify({
      preBashNudged: false, editFiles: [], editLines: 0, editNudged: false,
      blockedLaneSets: [], reportedModel: "", turnPrompt: "", busSeen: [],
    }));
    const fake = memoryFakes([{ id: "old-state-hit", text: "available from old state", type: "world", scores: { final: 1 } }]);
    const output = await runHook("prompt-submit", "claude", {
      session_id: session, prompt: "Read memory with older state", cwd: "/repo/alpha",
    }, env(session), fake.deps);
    expect(output).toContain("available from old state");
    expect(JSON.parse(readFileSync(join(hooks, `${session}.json`), "utf8")).recalled).toEqual(["old-state-hit"]);
  });

  test("a resumed session rechecks real state; compact injects the log, not a summary", async () => {
    const fake = memoryFakes([{ id: "hit", text: "remembered", type: "world", scores: { final: 1 } }]);
    const cwd = join(root, "resume-alpha");
    mkdirSync(cwd, { recursive: true });
    const first = await runHook("session-start", "claude", { session_id: "resume-memory", cwd, source: "startup" }, env("resume-memory"), fake.deps);
    expect(first).not.toBe("");
    const firstCtx = JSON.parse(first).hookSpecificOutput.additionalContext as string;
    expect(firstCtx.length).toBeLessThanOrEqual(10000);
    const resume = await runHook("session-start", "claude", { session_id: "resume-memory", cwd, source: "resume" }, env("resume-memory"), fake.deps);
    expect(resume).toContain("RECHECK");
    expect(resume).toContain("Do not trust a compacted summary");
    const resumeCtx = JSON.parse(resume).hookSpecificOutput.additionalContext as string;
    expect(resumeCtx.length).toBeLessThanOrEqual(10000);
    const compact = await runHook("session-start", "claude", { session_id: "resume-memory", cwd, source: "compact" }, env("resume-memory"), fake.deps);
    expect(compact).not.toBe("");
    expect(compact).toContain("Compaction is not the source of truth");
    const compactCtx = JSON.parse(compact).hookSpecificOutput.additionalContext as string;
    expect(compactCtx.length).toBeLessThanOrEqual(10000);
  });

  test("per-prompt recall drops hits below recall_min_semantic; session_recall_tokens 0 skips the session recall", async () => {
    const fake = memoryFakes([
      { id: "close", text: "close hit", type: "world", scores: { final: 1, semantic: 0.7 } },
      { id: "far", text: "far hit", type: "world", scores: { final: 1, semantic: 0.3 } },
    ]);
    fake.deps.config = () => ({ url: "http://localhost", bank: "kiba", recall_max_tokens: 1500, recall_budget: "low", timeout_ms: 4000, recall_min_semantic: 0.5, session_recall_tokens: 0 });
    const output = JSON.parse(await runHook("prompt-submit", "claude", { session_id: "gate-memory", cwd: "/repo/alpha", prompt: "Please help me with this task" }, env("gate-memory"), fake.deps));
    expect(output.hookSpecificOutput.additionalContext).toBe("Souvenirs :\nclose hit");
    const recallsBefore = fake.recalls.length;
    await runHook("session-start", "claude", { session_id: "gate-start", cwd: "/repo/alpha", source: "startup" }, env("gate-start"), fake.deps);
    expect(fake.recalls.length).toBe(recallsBefore);
  });

  test("Stop retains nothing when retain is false", async () => {
    const fake = memoryFakes();
    fake.deps.config = () => ({ url: "http://localhost", bank: "kiba", recall_max_tokens: 1500, recall_budget: "low", timeout_ms: 4000, retain: false });
    await runHook("prompt-submit", "claude", { session_id: "no-retain", prompt: "Please help me with this task" }, env("no-retain"), fake.deps);
    await runHook("stop", "claude", { session_id: "no-retain", last_assistant_message: "a".repeat(80) }, env("no-retain"), fake.deps);
    expect(fake.retained).toHaveLength(0);
  });

  test("post-tool queues one summary per call and Stop retains then clears the turn", async () => {
    const fake = memoryFakes();
    const session = "turn-memory";
    const envForTurn = env(session);
    const promptText = "p".repeat(2050);
    await runHook("prompt-submit", "claude", { prompt: promptText }, envForTurn, fake.deps);
    expect(await runHook("post-tool", "claude", {
      tool_name: "Edit", tool_input: { file_path: "src/a.ts", command: "edit command" },
      tool_response: { is_error: true },
    }, envForTurn, fake.deps)).toBe("");
    await runHook("post-tool", "claude", {
      tool_name: "Read", tool_input: { file_path: "src/b.ts", query: "ignored" }, tool_response: {},
    }, envForTurn, fake.deps);
    await runHook("post-tool", "claude", {
      tool_name: "Search", tool_input: { pattern: "src/**/*.ts" }, tool_response: { error: "not found" },
    }, envForTurn, fake.deps);
    const queue = join(state, "hooks", `${session}.turn.jsonl`);
    const queued = readFileSync(queue, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(queued).toHaveLength(3);
    expect(queued[0]).toMatchObject({ tool: "Edit", summary: "edit command", failed: true });
    expect(queued[1]).toMatchObject({ tool: "Read", summary: "src/b.ts", failed: false });
    expect(queued[2]).toMatchObject({ tool: "Search", summary: "src/**/*.ts", failed: true });

    const answer = "a".repeat(4100);
    await runHook("stop", "claude", {
      session_id: session, cwd: "/repo/alpha", last_assistant_message: answer,
    }, envForTurn, fake.deps);
    expect(fake.retained).toHaveLength(1);
    expect(fake.retained[0].bank).toBe("kiba-alpha");
    expect(fake.retained[0].async).toBe(true);
    const item = fake.retained[0].items[0];
    expect(item.document_id).toBe(`session:${session}`);
    expect(item.update_mode).toBe("append");
    expect(item.context).toBe("claude-code turn");
    expect(item.tags).toEqual(["project:alpha", "harness:claude"]);
    expect(item.metadata).toEqual({ cwd: "/repo/alpha", session });
    expect(item.content).toContain(`OPÉRATEUR : ${promptText.slice(0, 2000)}\n`);
    expect(item.content).not.toContain(promptText);
    expect(item.content).toContain("OUTILS : 3 appels, 2 échecs");
    expect(item.content.indexOf("- Edit edit command")).toBeLessThan(item.content.indexOf("- Search src/**/*.ts"));
    expect(item.content.indexOf("- Search src/**/*.ts")).toBeLessThan(item.content.indexOf("- Read src/b.ts"));
    expect(item.content.endsWith(`KIBA : ${answer.slice(0, 4000)}`)).toBe(true);
    expect(item.content).not.toContain(answer);
    expect(readFileSync(queue, "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(state, "hooks", `${session}.json`), "utf8")).turnPrompt).toBe("");
  });

  test("Stop skips short answers but always drains the turn queue", async () => {
    const fake = memoryFakes();
    const session = "turn-short-answer";
    const envForTurn = env(session);
    await runHook("post-tool", "claude", { tool_name: "Read", tool_input: { file_path: "a.ts" } }, envForTurn, fake.deps);
    await runHook("stop", "claude", {
      session_id: session, cwd: "/repo/alpha", last_assistant_message: "a".repeat(20),
    }, envForTurn, fake.deps);
    expect(fake.retained).toHaveLength(0);
    expect(readFileSync(join(state, "hooks", `${session}.turn.jsonl`), "utf8")).toBe("");
  });

  test("one bank failing with 404 keeps the other bank's hits and logs nothing", async () => {
    const fake = memoryFakes([{ id: "h1", text: "le port est 8899", type: "world", scores: { final: 0.9 } }]);
    fake.deps.recall = async (config, query, options) => options?.bank === "kiba"
      ? { ok: false, error: "HTTP 404: bank not found" }
      : { ok: true, value: [{ id: "h1", text: "le port est 8899", type: "world", scores: { final: 0.9 } }] };
    const out = await runHook("prompt-submit", "claude", { prompt: "sur quel port tourne la mémoire ?", cwd: "/w/orch" }, env("memory-one-bank"), fake.deps);
    expect(out).toContain("le port est 8899");
    expect(existsSync(join(state, "hooks", "hindsight.log")) && readFileSync(join(state, "hooks", "hindsight.log"), "utf8").includes("404")).toBe(false);
  });

  test("Hindsight throws and failed results are logged without prompt text", async () => {
    const promptText = "secret user prompt that must never be logged";
    const throwing = memoryFakes();
    throwing.deps.recall = async () => { throw new Error("backend unavailable"); };
    expect(await runHook("prompt-submit", "claude", { prompt: promptText }, env("memory-throws"), throwing.deps)).toBe("");
    const failed = memoryFakes();
    failed.deps.recall = async () => ({ ok: false, error: "backend returned failure" });
    expect(await runHook("prompt-submit", "claude", { prompt: promptText }, env("memory-failed-result"), failed.deps)).toBe("");
    const log = readFileSync(join(state, "hooks", "hindsight.log"), "utf8");
    expect(log).toContain(" prompt-submit backend unavailable");
    expect(log).toContain(" prompt-submit backend returned failure");
    expect(log).not.toContain(promptText);
  });

  test("an unknown memory provider logs the failure and leaves the hook fail-open", async () => {
    const prompt = "secret prompt used to verify redaction";
    const session = "unknown-memory-provider";
    const output = await runHook("prompt-submit", "claude", { prompt }, env(session, { ORCH_MEMORY_PROVIDER: "unknown" }));

    expect(output).toBe("");
    const log = readFileSync(join(state, "hooks", "hindsight.log"), "utf8");
    expect(log).toContain("prompt-submit unknown memory provider: unknown");
    expect(log).not.toContain(prompt);
  });

  test("the brain provider is selected from the environment and fails open on an unavailable snapshot", async () => {
    const prompt = "prompt text kept out of the memory failure log";
    const session = "brain-provider-snapshot";
    const output = await runHook("prompt-submit", "claude", { prompt }, env(session, {
      ORCH_MEMORY_PROVIDER: "brain",
      ORCH_BRAIN_SNAPSHOT: join(root, "missing-brain-snapshot.json"),
    }));

    expect(output).toBe("");
    const log = readFileSync(join(state, "hooks", "hindsight.log"), "utf8");
    expect(log).toContain("prompt-submit brain recall unavailable (embedding or store failure)");
    expect(log).not.toContain(prompt);
  });

  test("stop blocks once for this session's unintegrated lanes", async () => {
    const repo = laneRepo();
    addLane(repo, "mine", "stop-session");
    addLane(repo, "theirs", "other-session");
    const input = { session_id: "stop-session", stop_hook_active: false };
    const first = JSON.parse(await runHook("stop", "claude", input, env("stop-session")));
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("Lane mine is complete");
    expect(first.reason).not.toContain("theirs");
    expect(await runHook("stop", "claude", input, env("stop-session"))).toBe("");
    expect(await runHook("stop", "claude", { ...input, stop_hook_active: true }, env("stop-active"))).toBe("");
  }, 20_000);

  test("stop blocks once per lane: a new lane blocks for itself, an already reported one never again", async () => {
    const repo = laneRepo();
    addLane(repo, "a", "per-lane");
    addLane(repo, "b", "per-lane");
    const input = { session_id: "per-lane" };
    const blocked = JSON.parse(await runHook("stop", "claude", input, env("per-lane")));
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("lane integrate b");
    rmSync(join(state, "lanes", "a"), { recursive: true, force: true }); // a integrated, b still pending
    expect(await runHook("stop", "claude", input, env("per-lane"))).toBe("");
    addLane(repo, "c", "per-lane");
    expect(JSON.parse(await runHook("stop", "claude", input, env("per-lane"))).reason).toContain("Lane c");
  }, 20_000);

  test("Claude stop/session-end ingest transcript usage into spend.jsonl with an offset cursor", async () => {
    const transcript = join(root, "spend-claude.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        message: {
          id: "m1",
          model: "claude-opus-4-5",
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-01T10:01:00.000Z",
        message: {
          id: "m2",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        },
      }),
      "",
    ].join("\n"));
    const spendEnv = env("spend-claude", { ORCH_MEMORY: "off" });
    await runHook("stop", "claude", {
      session_id: "spend-claude",
      cwd: "/repo/alpha",
      transcript_path: transcript,
      last_assistant_message: "Done.",
    }, spendEnv);
    const first = readSpend(state).filter((row) => row.source.startsWith("lead:claude"));
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      provider: "claude",
      project: "alpha",
      session: "spend-claude",
      model: "claude-opus-4-5",
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 },
    });
    expect(first[1]).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-5",
    });

    await runHook("session-end", "claude", {
      session_id: "spend-claude",
      cwd: "/repo/alpha",
      transcript_path: transcript,
    }, spendEnv);
    expect(readSpend(state).filter((row) => row.source.startsWith("lead:claude"))).toHaveLength(2);

    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}${JSON.stringify({
      timestamp: "2026-11-01T10:02:00.000Z",
      message: { id: "m3", model: "claude-opus-4-5", usage: { input_tokens: 1, output_tokens: 2 } },
    })}\n`);
    await runHook("session-end", "claude", {
      session_id: "spend-claude",
      cwd: "/repo/alpha",
      transcript_path: transcript,
    }, spendEnv);
    expect(readSpend(state).filter((row) => row.source.startsWith("lead:claude"))).toHaveLength(3);
  });

  test("blocked Stop preserves the turn, then an active continuation retains it once", async () => {
    const fake = memoryFakes();
    const session = "stop-block-preserves-turn";
    const sessionEnv = env(session);
    const prompt = "Please integrate the completed lane before finishing.";
    const answer = "The lane is now integrated and the requested work is complete.";
    const repo = laneRepo();
    addLane(repo, "blocked-stop", session);

    await runHook("prompt-submit", "claude", { session_id: session, prompt, cwd: "/repo/alpha" }, sessionEnv, fake.deps);
    await runHook("post-tool", "claude", {
      tool_name: "Read", tool_input: { file_path: "src/a.ts" },
    }, sessionEnv, fake.deps);
    const blocked = JSON.parse(await runHook("stop", "claude", {
      session_id: session, last_assistant_message: answer,
    }, sessionEnv, fake.deps));

    expect(blocked.decision).toBe("block");
    expect(fake.retained).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(state, "hooks", `${session}.json`), "utf8")).turnPrompt).toBe(prompt);
    expect(readFileSync(join(state, "hooks", `${session}.turn.jsonl`), "utf8")).toContain("src/a.ts");

    rmSync(join(state, "lanes", "blocked-stop"), { recursive: true, force: true });
    expect(await runHook("stop", "claude", {
      session_id: session, stop_hook_active: true, last_assistant_message: answer,
    }, sessionEnv, fake.deps)).toBe("");

    expect(fake.retained).toHaveLength(1);
    expect(fake.retained[0].items[0].content).toContain(`OPÉRATEUR : ${prompt}`);
    expect(fake.retained[0].items[0].content).toContain("OUTILS : 1 appels, 0 échecs");
    expect(readFileSync(join(state, "hooks", `${session}.turn.jsonl`), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(state, "hooks", `${session}.json`), "utf8")).turnPrompt).toBe("");
  }, 20_000);

  test("Claude retains the existing pre-bash rewrite behavior; a Grok lead hook does nothing", async () => {
    const claude = JSON.parse(await runHook("pre-bash", "claude", bash('codex exec "q" &'), env("legacy-claude")));
    expect(claude.hookSpecificOutput.updatedInput.command).toEndWith("} < /dev/null");
    expect(await runHook("pre-bash", "grok", bash('codex exec "q" &', "run_terminal_command"), env("legacy-grok"))).toBe("");
  });
});
