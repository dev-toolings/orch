import { spawnSync } from "node:child_process";
import type { Harness } from "../core/profile.ts";

// Every coding-agent CLI orch knows, and what orch may use it for. Install,
// doctor, lead and lane read this instead of assuming all of them are present.
export type HarnessId = Harness;

export interface HarnessInfo {
  id: HarnessId;
  bin: string;
  lead: boolean; // orch can start it as a lead session (lead <h>)
  worker: boolean; // lane run may give it write work
  review: boolean; // lane review / lane ask may use it
  // A write worker needs an OS sandbox orch controls.
  sandbox: boolean;
}

export const REGISTRY: Record<HarnessId, HarnessInfo> = {
  claude: { id: "claude", bin: "claude", lead: true, worker: true, review: true, sandbox: true },
  codex: { id: "codex", bin: "codex", lead: true, worker: true, review: true, sandbox: true },
  grok: { id: "grok", bin: "grok", lead: true, worker: true, review: true, sandbox: true },
};

export const HARNESS_IDS = Object.keys(REGISTRY) as HarnessId[];

export type Which = (bin: string) => boolean;
export const onPath: Which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;

// Installed harnesses, in registry order. Tests pass their own `which`.
export function detect(which: Which = onPath): HarnessId[] {
  return HARNESS_IDS.filter((h) => which(REGISTRY[h].bin));
}

export function installed(h: HarnessId, which: Which = onPath): boolean {
  return which(REGISTRY[h].bin);
}
