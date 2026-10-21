import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_TIMEOUT_MS = 5_000;
const STALE_MS = 30_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    return false; // gone: its owner released it, retry instead of removing a new one
  }
}

// The mutex is a directory holding its owner's pid. It is taken from another
// process only when that owner is dead (or, with no owner file, when the
// directory is older than STALE_MS: a crash between mkdir and the write). A
// live owner keeps it however long it is suspended.
function lockOwner(lock: string): number | null {
  try {
    return Number(readFileSync(join(lock, "owner"), "utf8")) || null;
  } catch {
    return null;
  }
}

function takeLock(dir: string): string | null {
  const lock = join(dir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    let made = false;
    try {
      mkdirSync(lock);
      made = true;
    } catch {}
    if (made) {
      try {
        writeFileSync(join(lock, "owner"), String(process.pid));
        return lock;
      } catch {
        continue; // removed under us as stale: take it again
      }
    }
    const owner = lockOwner(lock);
    if (owner ? !alive(owner) : stale(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    sleep(10);
  }
  return null;
}

function releaseLock(lock: string): void {
  if (lockOwner(lock) === process.pid) rmSync(lock, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reserveSlot(stateDir: string, max: number, laneId: string, pool = "slots"): number | null {
  const dir = join(stateDir, pool);
  mkdirSync(dir, { recursive: true });
  const lock = takeLock(dir);
  if (!lock) return null;
  try {
    // Count every live reservation, not only indices below max: the budget can
    // shrink between two lanes, and a high slot still held must count against it.
    const held = (slot: string): boolean => {
      try {
        const owner = Number(readFileSync(join(slot, "pid"), "utf8").split(" ")[0]);
        return !!owner && alive(owner);
      } catch {
        return existsSync(slot) && !stale(slot); // between mkdir and the pid write
      }
    };
    const used = readdirSync(dir).filter((e) => /^\d+$/.test(e) && held(join(dir, e))).length;
    if (used >= max) return null;
    for (let i = 0; ; i++) {
      const slot = join(dir, String(i));
      if (held(slot)) continue;
      rmSync(slot, { recursive: true, force: true });
      try {
        mkdirSync(slot);
      } catch {
        continue;
      }
      writeFileSync(join(slot, "pid"), `${process.pid} ${laneId}`);
      return i;
    }
  } finally {
    releaseLock(lock);
  }
}

export function releaseSlot(stateDir: string, slot: number, pool = "slots"): void {
  const dir = join(stateDir, pool);
  mkdirSync(dir, { recursive: true });
  const lock = takeLock(dir);
  if (!lock) return;
  try {
    const slotDir = join(dir, String(slot));
    let owner = 0;
    try {
      owner = Number(readFileSync(join(slotDir, "pid"), "utf8").split(" ")[0]);
    } catch {
      return;
    }
    if (owner === process.pid) rmSync(slotDir, { recursive: true, force: true });
  } finally {
    releaseLock(lock);
  }
}
