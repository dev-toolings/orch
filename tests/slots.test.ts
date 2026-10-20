import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveSlot } from "../src/slots.ts";

function runReservation(state: string, id: string, modulePath: string): Promise<string> {
  const script = `
    import { reserveSlot } from ${JSON.stringify(modulePath)};
    const slot = reserveSlot(process.env.ORCH_SLOT_STATE!, 3, process.env.ORCH_SLOT_ID!);
    console.log(slot === null ? "null" : String(slot));
    if (slot !== null) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, ORCH_SLOT_STATE: state, ORCH_SLOT_ID: id },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`reservation child failed (${code}): ${stderr}`));
    });
  });
}

describe("slots", () => {
  test("concurrent reservations are unique and a fresh incomplete slot is protected", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-slots-"));
    const state = join(root, "state");
    const modulePath = join(process.cwd(), "src/slots.ts");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => runReservation(state, String(i), modulePath)));
    const claimed = results.filter((slot) => slot !== "null");
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed).size).toBe(claimed.length);

    const incomplete = join(root, "incomplete");
    mkdirSync(join(incomplete, "slots", "0"), { recursive: true });
    expect(reserveSlot(incomplete, 1, "fresh")).toBeNull();
    expect(existsSync(join(incomplete, "slots", "0"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

test("the slot mutex is never taken from a live owner, however old; a dead owner's is", () => {
  const state = mkdtempSync(join(tmpdir(), "slots-lock-owner-"));
  const lock = join(state, "slots", ".lock");
  const holder = spawn("sleep", ["30"]);
  try {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), String(holder.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(reserveSlot(state, 1, "blocked")).toBeNull();
    expect(existsSync(lock)).toBe(true);
    const dead = spawnSync("true").pid!;
    writeFileSync(join(lock, "owner"), String(dead));
    expect(reserveSlot(state, 1, "reclaimed")).toBe(0);
  } finally {
    holder.kill();
    rmSync(state, { recursive: true, force: true });
  }
}, 15_000);
