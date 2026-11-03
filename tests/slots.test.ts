import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSlot, reserveSlot } from "../src/lanes/slots.ts";
import { contender } from "./exclusion.ts";

// Each child holds its slot until the parent creates the release file, so the
// check does not depend on every child starting within a fixed window.
function runReservation(state: string, id: string, modulePath: string, release: string): { printed: Promise<string>; closed: Promise<void> } {
  const script = `
    import { existsSync } from "node:fs";
    import { reserveSlot } from ${JSON.stringify(modulePath)};
    const slot = reserveSlot(process.env.ORCH_SLOT_STATE!, 3, process.env.ORCH_SLOT_ID!);
    console.log(slot === null ? "null" : String(slot));
    const deadline = Date.now() + 20000;
    while (slot !== null && !existsSync(process.env.ORCH_SLOT_RELEASE!) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: state, ORCH_SLOT_STATE: state, ORCH_SLOT_ID: id, ORCH_SLOT_RELEASE: release },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const printed = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) resolve(stdout.trim());
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`reservation child failed (${code}): ${stderr}`))));
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  return { printed, closed };
}

describe("slots", () => {
  test("a runner killed with SIGKILL leaves its slot held while its worker group lives", async () => {
    const state = mkdtempSync(join(tmpdir(), "slots-live-group-"));
    const worker = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    const modulePath = join(process.cwd(), "src/lanes/slots.ts");
    const dead = spawnSync("true").pid;
    try {
      for (const pool of ["slots", "verify-slots"]) {
        // The runner: reserves, records the worker group, then dies without cleanup.
        const runner = spawnSync(process.execPath, ["-e", `
          import { recordSlotGroup, reserveSlot } from ${JSON.stringify(modulePath)};
          const slot = reserveSlot(${JSON.stringify(state)}, 1, "worker", ${JSON.stringify(pool)});
          recordSlotGroup(${JSON.stringify(state)}, slot, ${worker.pid}, ${JSON.stringify(pool)});
          process.kill(process.pid, "SIGKILL");
        `], { env: { ...process.env, HOME: state } });
        expect(runner.signal).toBe("SIGKILL");
        const pidPath = join(state, pool, "0", "pid");
        expect(readFileSync(pidPath, "utf8")).toEndWith(` worker ${worker.pid}`);
        expect(reserveSlot(state, 1, "blocked", pool)).toBeNull();
        // killed between the lane state write and the slot record
        mkdirSync(join(state, "lanes", "worker"), { recursive: true });
        writeFileSync(join(state, "lanes", "worker", "state.json"), JSON.stringify({ workerPgid: worker.pid }));
        writeFileSync(pidPath, `${dead} worker`);
        expect(reserveSlot(state, 1, "blocked", pool)).toBeNull();
      }
      worker.kill("SIGTERM");
      await exited;
      for (const pool of ["slots", "verify-slots"]) {
        const slot = reserveSlot(state, 1, "reclaimed", pool);
        expect(slot).toBe(0);
        releaseSlot(state, slot!, pool);
      }
    } finally {
      worker.kill("SIGKILL");
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("concurrent reservations are unique and an unlocked incomplete slot is reusable", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-slots-"));
    const state = join(root, "state");
    const modulePath = join(process.cwd(), "src/lanes/slots.ts");
    const release = join(root, "release");
    const children = Array.from({ length: 12 }, (_, i) => runReservation(state, String(i), modulePath, release));
    const results = await Promise.all(children.map((c) => c.printed));
    writeFileSync(release, "");
    await Promise.all(children.map((c) => c.closed));
    const claimed = results.filter((slot) => slot !== "null");
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed).size).toBe(claimed.length);

    const incomplete = join(root, "incomplete");
    mkdirSync(join(incomplete, "slots", "0"), { recursive: true });
    expect(reserveSlot(incomplete, 1, "fresh")).toBe(0);
    expect(existsSync(join(incomplete, "slots", "0"))).toBe(true);
    releaseSlot(incomplete, 0);
    rmSync(root, { recursive: true, force: true });
  });
});

test("two processes recovering a dead slot owner admit only one and preserve its inode", async () => {
  const state = mkdtempSync(join(tmpdir(), "slots-lock-owner-"));
  const holder = contender(state, "slot");
  const contenders: ReturnType<typeof contender>[] = [];
  try {
    await holder.ready;
    expect(await holder.start()).toBe("held");
    const lock = join(state, "slots", "0", "lock");
    const inode = statSync(lock).ino;
    expect(reserveSlot(state, 1, "blocked")).toBeNull();
    releaseSlot(state, 0); // a non-owner cannot release another process's slot
    await holder.stop();
    contenders.push(contender(state, "slot"), contender(state, "slot"));
    await Promise.all(contenders.map((c) => c.ready));
    expect((await Promise.all(contenders.map((c) => c.start()))).sort()).toEqual(["busy", "held"]);
    expect(reserveSlot(state, 1, "blocked-again")).toBeNull();
    expect(statSync(lock).ino).toBe(inode);
  } finally {
    await holder.stop();
    await Promise.all(contenders.map((c) => c.stop()));
    rmSync(state, { recursive: true, force: true });
  }
});

test("a shrunk budget counts a held slot above it: no extra worker is admitted", () => {
  const state = mkdtempSync(join(tmpdir(), "slots-shrink-"));
  expect(reserveSlot(state, 2, "a")).toBe(0);
  expect(reserveSlot(state, 2, "b")).toBe(1);
  releaseSlot(state, 0); // a finished, b still holds slot 1
  expect(reserveSlot(state, 1, "c")).toBeNull();
  expect(reserveSlot(state, 2, "c")).toBe(0);
  releaseSlot(state, 0);
  releaseSlot(state, 1);
  rmSync(state, { recursive: true, force: true });
});
