import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { render } from "../src/install/render.ts";
import { loadProfile } from "../src/core/profile.ts";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { allocateRun } from "../src/bench/index.ts";
import { claudeEnv as consoEnv, drainOwnedBanks, exactOwnedBankUsage, main as consoMain, parseClaudeResult, parseConsoOptions, positiveInteger, runPrompt, sourceHookSettings } from "../src/checks/conso.ts";
import { claudeEnv as memoireEnv, main as memoireMain, parseMemoireOptions, parseJudgeScores, assertHookReceipts, RECALL_INSTRUCTIONS, runClaude } from "../src/checks/memoire.ts";
import { projectKey } from "../src/core/project.ts";
import { ROOT } from "../src/core/profile.ts";

const roots: string[] = [];
const makeRoot = () => {
  const path = mkdtempSync(join(tmpdir(), "orch-bench-runner-test-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runAt(root: string) {
  return allocateRun({ suite: "runner-test", feature: "isolation", source: { revision: "test-ref", dirtyHash: null }, corpus: {}, settings: {}, models: {}, protocol: {}, paid: false, root });
}

describe("benchmark runner safeguards", () => {
  test("dry-run allocation, artifacts, state paths, and finalization write nothing", () => {
    const root = join(makeRoot(), "absent");
    const run = allocateRun({ suite: "runner-test", feature: "dry", source: { revision: "test-ref", dirtyHash: null }, corpus: {}, settings: {}, models: {}, protocol: {}, paid: false, root, dryRun: true });
    run.stateDirFor("C");
    run.writeArtifact("report.md", "preview");
    run.finalize([]);
    expect(existsSync(root)).toBe(false);
  });

  test("both CLI dry-runs preview C without a snapshot and create no state tree", async () => {
    const root = makeRoot();
    const oldState = process.env.ORCH_STATE;
    process.env.ORCH_STATE = join(root, "state");
    try {
      await consoMain(["--dry-run", "--config", "A,C", "--session", "explore"]);
      await memoireMain(["--dry-run", "--config", "A,C", "--family", "rappel"]);
      expect(existsSync(join(root, "state"))).toBe(false);
    } finally {
      if (oldState === undefined) delete process.env.ORCH_STATE;
      else process.env.ORCH_STATE = oldState;
    }
  });

  test("both runners reject caller-selected output reuse and numeric arguments must be positive integers", () => {
    expect(() => parseConsoOptions(["--dry-run", "--out", "/tmp/existing"])).toThrow();
    expect(() => parseMemoireOptions(["--dry-run", "--out", "/tmp/existing"])).toThrow();
    expect(positiveInteger("jobs", "3")).toBe(3);
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) expect(() => positiveInteger("jobs", value)).toThrow("positive integer");
  });

  test("valid JSON with a nonzero Claude exit keeps its reported cost and becomes an error", () => {
    const parsed = parseClaudeResult('{"result":"partial answer","total_cost_usd":0.12}', "failed after response", 7);
    expect(parsed.json?.result).toBe("partial answer");
    expect(parsed.error).toContain("claude exited 7");
    expect(parseClaudeResult("null", "", 0).error).toContain("invalid Claude JSON object");
    expect(parseClaudeResult("[]", "", 0).error).toContain("invalid Claude JSON object");
  });

  test("run environments replace inherited global state with a run snapshot and namespace", () => {
    const root = makeRoot();
    const run = runAt(join(root, "bench"));
    const stateDirs = { A: join(root, "state-A"), B: join(root, "state-B"), C: join(root, "state-C"), D: join(root, "state-D") };
    const brainSnapshot = join(root, "snapshot.json");
    const brainProject = projectKey(ROOT);
    const old = {
      ORCH_STATE: process.env.ORCH_STATE, ORCH_BENCH_RUN: process.env.ORCH_BENCH_RUN,
      ORCH_MEMORY_PROVIDER: process.env.ORCH_MEMORY_PROVIDER, ORCH_BRAIN_SNAPSHOT: process.env.ORCH_BRAIN_SNAPSHOT,
      ORCH_BRAIN_PROJECT: process.env.ORCH_BRAIN_PROJECT,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env.ORCH_STATE = "/operator/state";
    process.env.ORCH_BENCH_RUN = "other-run";
    process.env.ORCH_MEMORY_PROVIDER = "wrong-provider";
    process.env.ORCH_BRAIN_SNAPSHOT = "/operator/snapshot.json";
    process.env.ORCH_BRAIN_PROJECT = "other-project";
    process.env.ANTHROPIC_API_KEY = "fake-paid-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "fake-paid-token";
    try {
      const consoCtx = {
        run, out: run.outDir, cwds: { A: root, B: root, C: root, D: root }, stateDirs, binPaths: {},
        banks: { C: run.bankId("C"), D: run.bankId("D") },
        benchBrains: { C: join(root, "brain-C.yaml"), D: join(root, "brain-D.yaml") },
        leadSettings: {}, llmConfig: join(root, "llm.yaml"), claudeExecutable: "/fake/claude", brainSnapshot, brainProject, sourceRevision: "test-ref",
      };
      const c = consoEnv("C", run.sessionNamespace + "-C-session", consoCtx);
      const d = consoEnv("D", run.sessionNamespace + "-D-session", consoCtx);
      expect(c.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      expect(c.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(c.ORCH_STATE).toBe(stateDirs.C);
      expect(c.ORCH_SESSION).toContain(run.sessionNamespace);
      expect(c.ORCH_BRAIN_SNAPSHOT).toBe(brainSnapshot);
      expect(c.ORCH_BRAIN_CONFIG).toBe(consoCtx.benchBrains.C);
      expect(c.ORCH_LLM_CONFIG).toBe(consoCtx.llmConfig);
      expect(d.ORCH_MEMORY_PROVIDER).toBe("brain");
      expect(d.ORCH_BRAIN_PROJECT).toBe(brainProject);
      expect(d.ORCH_BENCH_RUN).toBe(run.id);

      const memoireCtx = {
        run, out: run.outDir, cwds: { A: root, B: root, C: root, D: root }, sourceCwd: root, sourceConfig: "A" as const, stateDirs, binPaths: {},
        benchBrains: consoCtx.benchBrains, leadSettings: {}, llmConfig: join(root, "llm.yaml"), claudeExecutable: "/fake/claude", brainSnapshot, brainProject,
      };
      const memD = memoireEnv("D", run.sessionNamespace + "-D-case", memoireCtx);
      expect(memD.ANTHROPIC_API_KEY).toBeUndefined();
      expect(memD.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(memD.ORCH_STATE).toBe(stateDirs.D);
      expect(memD.ORCH_MEMORY_PROVIDER).toBe("brain");
      expect(memD.ORCH_BRAIN_SNAPSHOT).toBe(brainSnapshot);
      expect(memD.ORCH_LLM_CONFIG).toBe(memoireCtx.llmConfig);
    } finally {
      for (const key of Object.keys(old) as (keyof typeof old)[]) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key];
      }
    }
  });

  test("runClaude records a failed nonzero JSON attempt using a fake binary and temp HOME", async () => {
    const root = makeRoot();
    const home = join(root, "home");
    const bin = join(root, "bin");
    const cwd = join(root, "cwd");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, ".claude", "sentinel"), "preserve");
    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BENCH_ARGV_FILE\"\nprintf '%s' '{\"result\":\"partial\",\"total_cost_usd\":0.12,\"num_turns\":1,\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}'\nexit 7\n");
    chmodSync(fakeClaude, 0o755);

    const run = runAt(join(root, "bench"));
    run.writeArtifact("runs.jsonl", "");
    const ctx = {
        run, out: run.outDir, cwds: { A: cwd, B: cwd, C: cwd, D: cwd }, sourceCwd: cwd, sourceConfig: "A" as const,
        stateDirs: { A: join(root, "s-A"), B: join(root, "s-B"), C: join(root, "s-C"), D: join(root, "s-D") },
        binPaths: {}, benchBrains: {}, leadSettings: {}, llmConfig: join(root, "llm.yaml"), claudeExecutable: fakeClaude, envOverrides: { HOME: home, BENCH_ARGV_FILE: join(root, "argv.txt") },
    };
    const result = await runClaude("A", { id: "r1", family: "rappel", level: 1, question: "q", expect: "fact" }, "q", "question", "run-session", ctx, undefined, true);
    const argv = readFileSync(join(root, "argv.txt"), "utf8").split("\n");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(RECALL_INSTRUCTIONS);
    expect(result.error).toContain("claude exited 7");
    expect(result.cost_usd).toBe(0.12);
    const row = JSON.parse(readFileSync(join(run.outDir, "runs.jsonl"), "utf8").trim());
    expect(row.error).toContain("claude exited 7");
    expect(row.cost_usd).toBe(0.12);
    expect(readFileSync(join(home, ".claude", "sentinel"), "utf8")).toBe("preserve");
  });

  test("B/C/D launch native Kiba as `kiba` starts it (the snapshot's agent); recall keeps every MCP out", async () => {
    const root = makeRoot();
    const fakeClaude = join(root, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BENCH_ARGV_FILE\"\nprintf '%s' '{\"result\":\"ok\"}'\n");
    chmodSync(fakeClaude, 0o755);
    const run = runAt(join(root, "bench"));
    run.writeArtifact("runs.jsonl", "");
    const argvFile = join(root, "argv.txt");
    const settings = join(root, "settings-B.json");
    const denied = ["WebFetch"];
    const base = {
      run, out: run.outDir, cwds: { A: ROOT, B: ROOT, C: ROOT, D: ROOT }, sourceCwd: ROOT, sourceConfig: "B" as const,
      stateDirs: { A: join(root, "s-A"), B: join(root, "s-B"), C: join(root, "s-C"), D: join(root, "s-D") },
      binPaths: {}, benchBrains: {}, leadSettings: { B: settings }, leadDenied: { B: denied }, llmConfig: join(root, "llm.yaml"), claudeExecutable: fakeClaude,
    };
    const readArgv = () => readFileSync(argvFile, "utf8").split("\n");
    const pins = (argv: string[]) => {
      expect(argv[argv.indexOf("--agent") + 1]).toBe("kiba");
      expect(JSON.parse(argv[argv.indexOf("--agents") + 1]).kiba.prompt).toBe(readFileSync(join(ROOT, "catalog", "kiba-native.md"), "utf8").trim());
      expect(argv).not.toContain("--append-system-prompt-file");
      expect(argv.join(" ")).not.toContain("kiba mcp");
      expect(argv[argv.indexOf("--settings") + 1]).toBe(settings);
      expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe(denied.join(","));
      expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
      expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    };

    const memoireCtx = { ...base, envOverrides: { HOME: root, BENCH_ARGV_FILE: argvFile } };
    await runClaude("B", { id: "p1", family: "persona", level: 1, question: "q", expect: "x" }, "s1", "question", "run-p", memoireCtx);
    let argv = readArgv();
    pins(argv);

    await runClaude("B", { id: "r1", family: "rappel", level: 1, question: "q", expect: "fact" }, "q", "question", "run-r", memoireCtx);
    argv = readArgv();
    pins(argv);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');

    const prev = process.env.BENCH_ARGV_FILE;
    process.env.BENCH_ARGV_FILE = argvFile;
    try {
      await runPrompt("B", "explore", 0, 0, "hello", "claude-id", { ...base, banks: {}, sourceRevision: "test-ref" });
    } finally {
      if (prev === undefined) delete process.env.BENCH_ARGV_FILE;
      else process.env.BENCH_ARGV_FILE = prev;
    }
    argv = readArgv();
    pins(argv);
  });

  test("rendered source hooks execute from an empty HOME rather than the installed global path", () => {
    const home = makeRoot();
    const script = join(home, "hook.ts");
    writeFileSync(script, 'console.log("source hook executed");');
    const original = render(loadProfile(), ["claude"]).find((target) => target.path === ".claude/orch/lead-settings.json")!;
    const entrypoint = `'${process.execPath}' '${script}'`;
    const settings = JSON.parse(sourceHookSettings(original.content, entrypoint));
    expect(settings.disableClaudeAiConnectors).toBe(true);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command).not.toContain("readlink");
      const result = spawnSync("sh", ["-c", command], { cwd: home, env: { HOME: home, ORCH_LEAD: "1", PATH: process.env.PATH }, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("source hook executed");
    }
    expect(() => sourceHookSettings('{"hooks":{}}', entrypoint)).toThrow("not fully rewritten");
  });

  test("scored recall requires native hook receipts for every session and the selected provider", () => {
    const dir = makeRoot(); mkdirSync(join(dir, "hooks"));
    expect(() => assertHookReceipts(dir, "run", "brain", ["one"])).toThrow("missing native hook");
    writeFileSync(join(dir, "hooks", "bench-receipts.jsonl"), ["session-start", "prompt-submit"].map((event) => JSON.stringify({ run: "run", session: "one", provider: "brain", event })).join("\n"));
    assertHookReceipts(dir, "run", "brain", ["one"]);
    expect(() => assertHookReceipts(dir, "run", "hindsight", ["one"])).toThrow("missing native hook");
    expect(() => assertHookReceipts(dir, "run", "brain", ["one", "two"])).toThrow("missing native hook");
  });

  test("judge failures and incomplete or duplicate score sheets cannot become a successful evaluation", () => {
    expect(() => parseJudgeScores("EXIT: 1", "SCORE MR01 A exact", ["MR01:A"])).toThrow("exit 1");
    expect(() => parseJudgeScores("STATUS: unavailable", "", ["MR01:A"])).toThrow("missing EXIT");
    expect(() => parseJudgeScores("EXIT: 0", "", ["MR01:A"])).toThrow("omitted");
    expect(() => parseJudgeScores("EXIT: 0", "SCORE MR01 A exact\nSCORE MR01 A wrong", ["MR01:A"])).toThrow("duplicate");
    expect(parseJudgeScores("EXIT: 0", "SCORE MR01 A exact\nSCORE MR01 B partial", ["MR01:A", "MR01:B"])).toEqual({ "MR01:A": "exact", "MR01:B": "partial" });
  });

  test("Hindsight stats and drain requests target only both run-owned banks", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return path.endsWith("/operations") ? Response.json({ total: 0 }) : Response.json({ buckets: [] });
      },
    });
    try {
      const banks = ["bench-0123456789abcdef-C", "bench-0123456789abcdef-C-orch"];
      await exactOwnedBankUsage("http://127.0.0.1:" + server.port, banks);
      expect(await drainOwnedBanks("http://127.0.0.1:" + server.port, banks, 100)).toBe(0);
      expect(paths.length).toBe(8);
      expect(paths.every((path) => banks.some((bank) => path.includes("/banks/" + bank + "/")))).toBe(true);
      expect(paths.some((path) => path.includes("bench-kiba"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("malformed successful Hindsight stats and queue responses fail closed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        return path.endsWith("/operations") ? Response.json({}) : Response.json({});
      },
    });
    try {
      const base = "http://127.0.0.1:" + server.port;
      const banks = ["bench-owned-C", "bench-owned-C-orch"];
      await expect(exactOwnedBankUsage(base, banks)).rejects.toThrow("missing buckets[]");
      await expect(drainOwnedBanks(base, banks, 100)).rejects.toThrow("invalid total");
    } finally {
      server.stop(true);
    }
  });
});
