// Temporary engine outages affect routing, never the effort ladder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { withFileLock } from "../lanes/lock.ts";
import type { HarnessId } from "./registry.ts";
import type { EngineUnavailable } from "./harness.ts";

interface Health { kind: EngineUnavailable["kind"]; reason: string; until: number }
const path = (root: string) => join(root, "engine-health.json");

export function engineHealth(root = stateDir()): Partial<Record<HarnessId, Health>> {
  try {
    const doc = JSON.parse(readFileSync(path(root), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch { return {}; }
}

export function usableEngines(engines: HarnessId[], root = stateDir(), now = Date.now()): HarnessId[] {
  const health = engineHealth(root);
  return engines.filter((h) => (health[h]?.until ?? 0) <= now);
}

export async function markEngineUnavailable(engine: HarnessId, why: EngineUnavailable, root = stateDir(), now = Date.now()): Promise<void> {
  mkdirSync(root, { recursive: true });
  const saved = await withFileLock(`${path(root)}.lock`, () => {
    const health = engineHealth(root);
    health[engine] = { ...why, until: now + (why.kind === "auth" ? 30 : 15) * 60_000 };
    const tmp = `${path(root)}.tmp`;
    writeFileSync(tmp, JSON.stringify(health) + "\n", { mode: 0o600 });
    renameSync(tmp, path(root));
    return true;
  }, { waitMs: 5000 });
  if (!saved) throw new Error("engine health: lock busy");
}
