import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processGroupAlive } from "../harness/proc.ts";
import { tryLock } from "./lock.ts";

const LOCK_TIMEOUT_MS = 5_000;
const reservations = new Map<string, number>();

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serialise budget checks as well as allocation. Keep every lock inode in
// place, including free slots; only the kernel decides whether it is held.
function takeLock(dir: string): number | null {
  const fd = openSync(join(dir, ".mutex"), "a", 0o600);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  try {
    while (!(held = tryLock(fd))) {
      if (Date.now() >= deadline) return null;
      sleep(10);
    }
    return fd;
  } finally {
    if (!held) closeSync(fd);
  }
}

// A runner killed with SIGKILL drops its flock while its worker may still
// run: a free lock whose slot records a live worker group (in its pid file,
// or in the lane state, written first) stays held.
function workerAlive(stateDir: string, slot: string): boolean {
  try {
    const [, id, pgid] = readFileSync(join(slot, "pid"), "utf8").split(" ");
    if (processGroupAlive(Number(pgid))) return true;
    if (!id) return false;
    return processGroupAlive(JSON.parse(readFileSync(join(stateDir, "lanes", id, "state.json"), "utf8")).workerPgid);
  } catch { return false; }
}

export function reserveSlot(stateDir: string, max: number, laneId: string, pool = "slots"): number | null {
  const dir = join(stateDir, pool);
  mkdirSync(dir, { recursive: true });
  const lock = takeLock(dir);
  if (lock === null) return null;
  const free = new Map<number, number>();
  try {
    // Count held slots above max too: a shrinking budget must not admit an
    // extra worker. Hold free descriptors until the allocation is finished.
    let used = 0;
    const indices = readdirSync(dir).filter((e) => /^\d+$/.test(e)).map(Number).sort((a, b) => a - b);
    for (const i of indices) {
      const fd = openSync(join(dir, String(i), "lock"), "a", 0o600);
      let held = false;
      try {
        if ((held = tryLock(fd) && !workerAlive(stateDir, join(dir, String(i))))) free.set(i, fd);
        else used++;
      } finally {
        if (!held) closeSync(fd);
      }
    }
    if (used >= max) return null;
    const i = free.keys().next().value ?? (indices.length ? indices.at(-1)! + 1 : 0);
    const slot = resolve(dir, String(i));
    if (!free.has(i)) {
      mkdirSync(slot, { recursive: true });
      const fd = openSync(join(slot, "lock"), "a", 0o600);
      let held = false;
      try {
        if (!(held = tryLock(fd))) return null;
        free.set(i, fd);
      } finally {
        if (!held) closeSync(fd);
      }
    }
    writeFileSync(join(slot, "pid"), `${process.pid} ${laneId}`);
    reservations.set(slot, free.get(i)!);
    free.delete(i);
    return i;
  } finally {
    for (const fd of free.values()) closeSync(fd);
    closeSync(lock);
  }
}

// The worker's process group, once spawned: see workerAlive.
export function recordSlotGroup(stateDir: string, slot: number, pgid: number, pool = "slots"): void {
  const path = resolve(stateDir, pool, String(slot));
  if (!reservations.has(path)) throw new Error("slot no longer belongs to this runner");
  const [owner, id] = readFileSync(join(path, "pid"), "utf8").split(" ");
  writeFileSync(join(path, "pid.tmp"), `${owner} ${id} ${pgid}`);
  renameSync(join(path, "pid.tmp"), join(path, "pid"));
}

// Released after the worker's group is gone: the pid file is emptied so a
// reused group id never keeps a free slot.
export function releaseSlot(stateDir: string, slot: number, pool = "slots"): void {
  const path = resolve(stateDir, pool, String(slot));
  const fd = reservations.get(path);
  if (fd === undefined) return;
  reservations.delete(path);
  writeFileSync(join(path, "pid"), "");
  closeSync(fd);
}
