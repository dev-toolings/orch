import { spawn } from "node:child_process";
import { join } from "node:path";

// Each process waits at a start barrier, then keeps its lock until killed.
export function contender(state: string, kind: "routine" | "slot") {
  const script = `
    import { acquire } from ${JSON.stringify(join(import.meta.dir, "../src/routines/routines.ts"))};
    import { reserveSlot } from ${JSON.stringify(join(import.meta.dir, "../src/lanes/slots.ts"))};
    process.stdin.once("data", async () => {
      const held = process.env.KIND === "routine"
        ? !!(await acquire(process.env.STATE + "/lock", 0))
        : reserveSlot(process.env.STATE, 1, "contender") !== null;
      console.log(held ? "held" : "busy");
      setInterval(() => {}, 1000);
    });
    console.log("ready");
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: state, ORCH_STATE: state, STATE: state, KIND: kind },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const listeners: (() => void)[] = [];
  child.stdout.on("data", (data) => { output += data; for (const notify of listeners) notify(); });
  child.stderr.on("data", (data) => { errors += data; });
  const line = (pattern: RegExp) => new Promise<string>((resolve, reject) => {
    const check = () => { const match = output.match(pattern); if (match) resolve(match[0]); };
    listeners.push(check);
    child.on("error", reject);
    child.on("close", () => reject(new Error(`contender closed: ${errors}`)));
    check();
  });
  const done = new Promise((resolve) => child.on("close", resolve));
  return {
    ready: line(/^ready$/m),
    start: () => { const result = line(/^(held|busy)$/m); child.stdin.write("start\n"); return result; },
    stop: async () => { child.kill("SIGKILL"); await done; },
  };
}
