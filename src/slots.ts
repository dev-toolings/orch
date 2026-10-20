import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One directory per slot; mkdir is atomic, so two lanes can never take the
// same slot. A slot whose owner pid is gone is reclaimed.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reserveSlot(stateDir: string, max: number, laneId: string): number | null {
  const dir = join(stateDir, "slots");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < max; i++) {
    const slot = join(dir, String(i));
    try {
      mkdirSync(slot);
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(slot, "pid"), "utf8").split(" ")[0]);
      } catch {}
      if (owner && alive(owner)) continue;
      rmSync(slot, { recursive: true, force: true });
      try {
        mkdirSync(slot);
      } catch {
        continue;
      }
    }
    writeFileSync(join(slot, "pid"), `${process.pid} ${laneId}`);
    return i;
  }
  return null;
}

export function releaseSlot(stateDir: string, slot: number): void {
  rmSync(join(stateDir, "slots", String(slot)), { recursive: true, force: true });
}
