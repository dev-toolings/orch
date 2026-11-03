import { describe, expect, test } from "bun:test";
import { parseSsListeners, stopDashPorts } from "../src/dash/stop.ts";

describe("dash stop", () => {
  test("parseSsListeners extracts process names and pids", () => {
    const rows = parseSsListeners([
      "LISTEN 0      511        127.0.0.1:7895      0.0.0.0:*    users:((\"bun\",pid=111,fd=17),(\"node\",pid=222,fd=20))",
      "LISTEN 0      511        127.0.0.1:7894      0.0.0.0:*    users:((\"vite\",pid=333,fd=18))",
    ].join("\n"));
    expect(rows).toEqual([
      { pid: 111, command: "bun" },
      { pid: 222, command: "node" },
      { pid: 333, command: "vite" },
    ]);
  });

  test("stopDashPorts only terminates bun/node/vite listeners", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([111, 222, 333, 444]);
    const run = (cmd: string, args: string[]) => {
      if (cmd === "ss") {
        const port = args[1];
        if (port === "sport = :9001") {
          return {
            status: 0,
            stdout: "LISTEN 0 511 127.0.0.1:9001 0.0.0.0:* users:((\"bun\",pid=111,fd=1),(\"python\",pid=444,fd=2))\n",
            stderr: "",
          };
        }
        if (port === "sport = :9002") {
          return {
            status: 0,
            stdout: "LISTEN 0 511 127.0.0.1:9002 0.0.0.0:* users:((\"node\",pid=222,fd=1),(\"vite\",pid=333,fd=2))\n",
            stderr: "",
          };
        }
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const lines = await stopDashPorts(
      { DEV_PORT: "9001", DASH_API_PORT: "9002" },
      {
        run,
        alive: (pid) => alive.has(pid),
        kill: (pid, signal) => {
          killed.push({ pid, signal });
          alive.delete(pid);
        },
        sleep: async () => {},
      },
    );
    expect(lines.join("\n")).toContain("stopped 111");
    expect(lines.join("\n")).toContain("stopped 222");
    expect(lines.join("\n")).toContain("stopped 333");
    expect(lines.join("\n")).not.toContain("444");
    expect(killed.map((k) => k.pid).sort((a, b) => a - b)).toEqual([111, 222, 333]);
  });

  test("prints a no-op line when nothing is listening", async () => {
    const lines = await stopDashPorts(
      { DEV_PORT: "9001", DASH_API_PORT: "9002" },
      {
        run: () => ({ status: 1, stdout: "", stderr: "" }),
        sleep: async () => {},
      },
    );
    expect(lines).toEqual(["nothing listening on 9001, 9002"]);
  });
});
