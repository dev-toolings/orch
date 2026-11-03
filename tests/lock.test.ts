import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock, withFileLock } from "../src/lanes/lock.ts";

let root: string;
let lock: string;
let holder: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lock-test-"));
  lock = join(root, "state", "integrate.lck");
  holder = join(root, "holder.ts");
  // Another process takes the lock, says so, then holds it until killed.
  writeFileSync(holder, `import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "lanes", "lock.ts"))};
await withFileLock(process.argv[2], async () => { console.log("locked"); await new Promise(() => {}); });
`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ready resolves once the child holds the lock (a full "locked" line, however
// stdout is chunked) and rejects if it fails to spawn or exits first. done
// settles in every case, a failed spawn included ("close" follows "error").
function holdInChild(): { child: ChildProcess; ready: Promise<void>; done: Promise<unknown> } {
  const child = spawn(process.execPath, [holder, lock], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise((r) => child.on("close", r));
  const ready = new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => { out += String(d); if (out.split("\n").includes("locked")) resolve(); });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`holder exited (${code}) before locking`)));
  });
  return { child, ready, done };
}

async function stop(c: { child: ChildProcess; done: Promise<unknown> }) {
  if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL");
  await c.done;
}

// No timing: every check is a single non-blocking attempt (waitMs 0) made
// while the state under test is established, not hoped for.
describe("withFileLock", () => {
  test("a second caller in the same process cannot enter while the first holds it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const first = withFileLock(lock, async () => { entered(); await held; return "first"; });
    try {
      await inside;
      expect(await withFileLock(lock, () => "second", { waitMs: 0 })).toBeNull();
    } finally {
      release();
    }
    expect(await first).toBe("first");
    expect(await withFileLock(lock, () => "second", { waitMs: 0 })).toBe("second");
  });

  test("a live holder in another process is never stolen", async () => {
    const holding = holdInChild();
    try {
      await holding.ready;
      expect(await withFileLock(lock, () => "stolen", { waitMs: 0 })).toBeNull();
    } finally {
      await stop(holding);
    }
  });

  test("a holder killed with SIGKILL leaves the lock free", async () => {
    const holding = holdInChild();
    try {
      await holding.ready;
    } finally {
      await stop(holding);
    }
    expect(holding.child.signalCode).toBe("SIGKILL");
    expect(await withFileLock(lock, () => "mine", { waitMs: 0 })).toBe("mine");
  });

  test("the lock is released when fn throws", async () => {
    await expect(withFileLock(lock, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withFileLock(lock, () => "free", { waitMs: 0 })).toBe("free");
  });

  test("a holder that fails to spawn settles instead of hanging", async () => {
    const child = spawn(join(root, "missing-binary"), [], { stdio: "ignore" });
    const done = new Promise((r) => child.on("close", r));
    child.on("error", () => {});
    await done;
    expect(child.exitCode === null || child.exitCode !== 0).toBe(true);
  });

  test("a flock failure that is not contention throws instead of waiting", () => {
    const fd = openSync(join(root, "closed.lck"), "a");
    closeSync(fd);
    expect(() => tryLock(fd)).toThrow(/flock failed, errno 9/);
  });
});
