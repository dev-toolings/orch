// Direct routing, persisted: one owner per thread, under a file lock.
// Extracted from src/kiba/store.ts (the old conductor keeps its file under
// `<state>/kiba/`); `orch serve` keeps its own under `<state>/tasks/`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "../lanes/lock.ts";

async function withThreads<T>(file: string, fn: (t: Record<string, string>) => T): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const r = await withFileLock(`${file}.lock`, () => {
    const t = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, string> : {};
    const out = fn(t);
    writeFileSync(file, JSON.stringify(t, null, 2) + "\n");
    return out;
  }, { waitMs: 5000 });
  if (r === null) throw new Error("threads: lock busy");
  return r;
}

// False when another owner already holds the thread: nothing changes.
export function subscribeThreadAt(file: string, thread: string, owner: string): Promise<boolean> {
  return withThreads(file, (t) => {
    if (t[thread] !== undefined && t[thread] !== owner) return false;
    t[thread] = owner;
    return true;
  });
}

export function releaseThreadAt(file: string, thread: string, owner: string): Promise<boolean> {
  return withThreads(file, (t) => {
    if (t[thread] !== owner) return false;
    delete t[thread];
    return true;
  });
}

// Every held thread and its owner.
export function heldThreadsAt(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>; } catch { return {}; }
}

export function threadHolderAt(file: string, thread: string): string | undefined {
  return heldThreadsAt(file)[thread];
}
