import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProcess } from "../src/bench/process.ts";

describe("benchmark process capture", () => {
  test("keeps stdout, stderr, and a nonzero exit separate", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orch-capture-output-"));
    try {
      const result = await captureProcess([
        process.execPath,
        "-e",
        "process.stdout.write('answer\\n'); process.stderr.write('diagnostic\\n'); process.exit(7)",
      ], { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 2_000, stdin: "ignored input" });
      expect(result).toEqual({ stdout: "answer\n", stderr: "diagnostic\n", exit: 7, timedOut: false });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("timeout stops an ignoring descendant before capture returns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orch-capture-descendant-"));
    const record = join(cwd, "pids.json");
    const source = join(cwd, "worker.ts");
    writeFileSync(source, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(record)}, JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
    `);
    let parentPid: number | undefined;
    try {
      const result = await captureProcess([process.execPath, source], { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 250 });
      const pids = JSON.parse(readFileSync(record, "utf8")) as { parent: number; child: number };
      parentPid = pids.parent;
      expect(result.timedOut).toBe(true);
      expect(result.exit).not.toBe(0);
      if (process.platform === "linux") {
        const stat = spawnSync("cat", [`/proc/${pids.child}/stat`], { encoding: "utf8" });
        if (stat.status === 0) {
          const fields = stat.stdout.slice(stat.stdout.lastIndexOf(")") + 2).trim().split(/\s+/);
          expect(["Z", "X"]).toContain(fields[0]);
        }
      } else {
        let alive = true;
        try { process.kill(pids.child, 0); } catch { alive = false; }
        expect(alive).toBe(false);
      }
    } finally {
      if (parentPid) try { process.kill(-parentPid, "SIGKILL"); } catch {}
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("caps combined captured output at 16 MiB and marks truncation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orch-capture-limit-"));
    try {
      const result = await captureProcess([
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(12 * 1024 * 1024)); process.stderr.write('y'.repeat(12 * 1024 * 1024))",
      ], { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5_000 });
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.stdout + result.stderr).toContain("[output truncated]");
      expect(result.exit).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 10_000);
});
