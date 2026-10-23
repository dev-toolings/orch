// An exclusive lock held by the kernel (flock), not by a file's content: the
// kernel releases it when its holder exits or dies, so a stale lock cannot
// exist and no takeover protocol is needed. Each call opens its own
// descriptor, so callers in the same process are serialised too.
import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;
// EWOULDBLOCK: the lock is held by another descriptor.
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

type Libc = { flock: (fd: number, op: number) => number; errno: () => number };
let libc: Libc | undefined;

// glibc, musl and macOS; anything else fails loudly instead of degrading.
function loadLibc(): Libc {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  const names = process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", `libc.musl-${arch}.so.1`, "libc.so"];
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  for (const name of names) {
    try {
      const { symbols } = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      });
      const errnoAt = symbols[errnoSymbol] as () => number;
      return { flock: symbols.flock as (fd: number, op: number) => number, errno: () => read.i32(errnoAt() as never, 0) };
    } catch {}
  }
  throw new Error(`lock: no libc with flock found (tried ${names.join(", ")}); supported: glibc, musl, macOS`);
}

// true: locked; false: held by someone else. Any other failure (ENOLCK, a
// filesystem without locks, a bad descriptor) throws: it is not contention.
export function tryLock(fd: number): boolean {
  libc ??= loadLibc();
  for (;;) {
    if (libc.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
    const errno = libc.errno();
    if (errno === EINTR) continue;
    if (errno === EWOULDBLOCK) return false;
    throw new Error(`lock: flock failed, errno ${errno}`);
  }
}

// Runs fn while holding the lock on path; null when it stayed held by
// someone else for waitMs (0: a single attempt).
export async function withFileLock<T>(path: string, fn: () => T | Promise<T>, opts: { waitMs?: number; pollMs?: number } = {}): Promise<T | null> {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    const until = Date.now() + (opts.waitMs ?? 60_000);
    while (!tryLock(fd)) {
      if (Date.now() >= until) return null;
      await Bun.sleep(opts.pollMs ?? 100);
    }
    try { return await fn(); } finally { libc!.flock(fd, LOCK_UN); }
  } finally {
    closeSync(fd);
  }
}
