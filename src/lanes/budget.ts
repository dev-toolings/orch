import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import type { Profile } from "../core/profile.ts";

export interface MachineFigures {
  cores: number;
  memAvailableGib: number;
}

export function readMachine(): MachineFigures {
  let memAvailableGib: number;
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const availableKb = Number(text.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
    memAvailableGib = Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : freemem() / 1024 ** 3;
  } catch {
    memAvailableGib = freemem() / 1024 ** 3;
  }
  return { cores: availableParallelism(), memAvailableGib };
}

export function laneBudget(
  limits: Profile["limits"],
  m: MachineFigures = readMachine(),
): { budget: number; cpu: number; ram: number; ceiling: number; limitedBy: "cpu" | "ram" | "ceiling" } {
  const cpu = Math.floor(m.cores / 2);
  const ram = Math.floor((m.memAvailableGib - limits.reserve_gib - limits.verify_concurrent * limits.verify_gib) / limits.worker_gib);
  const ceiling = limits.max_concurrent_ceiling;
  const lowest = Math.min(cpu, ram, ceiling);
  const limitedBy = cpu === lowest ? "cpu" : ram === lowest ? "ram" : "ceiling";
  return { budget: Math.max(1, lowest), cpu, ram, ceiling, limitedBy };
}
