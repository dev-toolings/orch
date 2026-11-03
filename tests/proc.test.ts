import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SANDBOX, workerArgv } from "../src/harness/harness.ts";
import { laneDepth, processGroupAlive, workerEnv } from "../src/harness/proc.ts";

test("runner signals stop every owned group, escalate after grace and exit without resuming", async () => {
  const root = mkdtempSync(join(tmpdir(), "proc-signals-"));
  const worker = join(root, "worker.ts");
  const runner = join(root, "runner.ts");
  writeFileSync(worker, `
    import { writeFileSync } from "node:fs";
    const [tag, mode] = process.argv.slice(2);
    process.on("SIGTERM", () => {
      writeFileSync(tag + ".term", "received");
      if (mode === "graceful") setTimeout(() => process.exit(0), 100);
    });
    setInterval(() => {}, 1000);
    writeFileSync(tag + ".pid", String(process.pid));
  `);
  writeFileSync(runner, `
    import { writeFileSync } from "node:fs";
    import { runLogged } from ${JSON.stringify(join(import.meta.dir, "../src/harness/proc.ts"))};
    const prefix = process.argv[2];
    await Promise.all(["graceful", "stubborn"].map(mode => runLogged(
      [process.execPath, ${JSON.stringify(worker)}, prefix + mode, mode],
      { cwd: ${JSON.stringify(root)}, logPath: prefix + mode + ".log", timeoutMs: 30000, env: { HOME: ${JSON.stringify(root)} } },
    )));
    writeFileSync(prefix + "resumed", "unexpected");
  `);
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 12000;
    while (!ready() && Date.now() < deadline) await Bun.sleep(20);
    expect(ready()).toBe(true);
  };
  try {
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
      const prefix = join(root, signal);
      const child = spawn(process.execPath, [runner, prefix], { env: { HOME: root }, stdio: "ignore" });
      let result: { code: number | null; signal: string | null } | undefined;
      const exited = new Promise<void>((resolve) => child.once("exit", (code, signal) => { result = { code, signal }; resolve(); }));
      const pgids: number[] = [];
      try {
        await waitFor(() => ["graceful", "stubborn"].every(mode => existsSync(prefix + mode + ".pid")));
        for (const mode of ["graceful", "stubborn"]) pgids.push(Number(readFileSync(prefix + mode + ".pid", "utf8")));
        const started = Date.now();
        child.kill(signal);
        await waitFor(() => ["graceful", "stubborn"].every(mode => existsSync(prefix + mode + ".term")));
        child.kill(signal); // repeated signals must not bypass cleanup
        await waitFor(() => result !== undefined);
        expect(result).toEqual({ code, signal: null });
        expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
        for (const pgid of pgids) expect(processGroupAlive(pgid)).toBe(false);
        expect(existsSync(prefix + "resumed")).toBe(false);
      } finally {
        for (const mode of ["graceful", "stubborn"]) {
          const path = prefix + mode + ".pid";
          if (existsSync(path)) {
            try { process.kill(-Number(readFileSync(path, "utf8")), "SIGKILL"); } catch {}
          }
        }
        child.kill("SIGKILL");
        await exited;
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45000);

describe("workerEnv", () => {
  test("the lane's own temp dir becomes TMPDIR; other extra keys stay refused", () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = "/lead/tmp";
    try {
      expect(workerEnv({}, { tmpDir: "/tmp/orch-lane-ab12" }).TMPDIR).toBe("/tmp/orch-lane-ab12");
      expect(() => workerEnv({}, { tmpDir: "relative/tmp" })).toThrow(/not an absolute path/);
      expect(() => workerEnv({ TMPDIR: "/x" })).toThrow(/not a LANE_\* variable/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("a Claude write worker's sandbox may write the lane temp dir, never /tmp or HOME", async () => {
    const { workerArgv } = await import("../src/harness/harness.ts");
    const call = workerArgv("claude", { model: "sonnet" }, { cwd: "/wt", promptPath: "/p", readOnly: false, lastMessagePath: "/l", tmpDir: "/tmp/orch-lane-ab12" });
    const settings = JSON.parse(call.argv[call.argv.indexOf("--settings") + 1]) as { sandbox: { filesystem?: { allowWrite?: string[] } } };
    expect(settings.sandbox.filesystem?.allowWrite).toEqual(["/tmp/orch-lane-ab12"]);
  });

  test("passes lane variables and excludes unlisted parent variables", () => {
    const savedSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = "parent-secret";

    try {
      const env = workerEnv({ LANE_REPO: "/repo" });
      expect(env.LANE_REPO).toBe("/repo");
      expect(env.SECRET_TOKEN).toBeUndefined();
      expect(env.ORCH_LANE).toBe("1");
      expect(env.ORCH_LANE_DEPTH).toBe(String(laneDepth() + 1));
      expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      expect(env.BUN_INSTALL_CACHE_DIR).toBeTruthy();
    } finally {
      if (savedSecretToken === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = savedSecretToken;
    }
  });

  test("a lead's CLAUDE_CODE_EFFORT_LEVEL never reaches a worker: the lane's --effort decides", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    try {
      expect(workerEnv().CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
    }
  });

  test("forces ORCH_LANE_DEPTH to parent depth + 1 and ignores a forged parent value on extra", () => {
    const savedLane = process.env.ORCH_LANE;
    const savedDepth = process.env.ORCH_LANE_DEPTH;
    process.env.ORCH_LANE = "1";
    process.env.ORCH_LANE_DEPTH = "2";
    try {
      expect(laneDepth()).toBe(2);
      expect(workerEnv().ORCH_LANE_DEPTH).toBe("3");
    } finally {
      if (savedLane === undefined) delete process.env.ORCH_LANE;
      else process.env.ORCH_LANE = savedLane;
      if (savedDepth === undefined) delete process.env.ORCH_LANE_DEPTH;
      else process.env.ORCH_LANE_DEPTH = savedDepth;
    }
  });

  test("rejects an extra ORCH_LANE override", () => {
    expect(() => workerEnv({ ORCH_LANE: "0" })).toThrow(
      "workerEnv: extra key ORCH_LANE is not a LANE_* variable",
    );
  });

  test("rejects other non-LANE extra keys", () => {
    expect(() => workerEnv({ SECRET_TOKEN: "injected" })).toThrow(
      "workerEnv: extra key SECRET_TOKEN is not a LANE_* variable",
    );
  });

  test("forces ENABLE_CLAUDEAI_MCP_SERVERS off even when the parent exported true", () => {
    const saved = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "true";
    try {
      expect(workerEnv({ LANE_REPO: "/repo" }).ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    } finally {
      if (saved === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
      else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = saved;
    }
  });

  test("rejects values containing a NUL byte", () => {
    expect(() => workerEnv({ LANE_REPO: "/repo\0/secret" })).toThrow(
      "workerEnv: value for LANE_REPO contains a NUL byte",
    );
  });
});

describe("worker sandbox argv", () => {
  const opts = { cwd: "/worktree", promptPath: "/tmp/prompt", readOnly: false, lastMessagePath: "/tmp/last" };

  test("Codex worker argv does not add host-wide access flags", () => {
    const argv = workerArgv("codex", {}, opts).argv;
    for (const flag of ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--add-dir"]) {
      expect(argv).not.toContain(flag);
    }
  });

  test("search opt-in enables live web search on codex and claude, never by default", () => {
    expect(workerArgv("codex", {}, opts).argv).not.toContain('web_search="live"');
    expect(workerArgv("codex", {}, { ...opts, readOnly: true, search: true }).argv).toContain('web_search="live"');
    const claude = workerArgv("claude", {}, { ...opts, readOnly: true, search: true }).argv;
    expect(claude.slice(claude.lastIndexOf("--allowedTools"))).toEqual(["--allowedTools", "WebSearch", "WebFetch"]);
    expect(workerArgv("claude", {}, { ...opts, readOnly: true }).argv).not.toContain("WebSearch");
  });

  test("Claude worker sandbox fails closed and disallows unsandboxed commands", () => {
    const argv = workerArgv("claude", {}, opts).argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    // the sandbox plus the write guard hook, nothing else
    expect({ ...settings, hooks: undefined }).toEqual({ ...CLAUDE_SANDBOX, hooks: undefined });
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
  });
});
