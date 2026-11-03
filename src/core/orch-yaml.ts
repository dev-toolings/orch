// Project orch.yaml: walk up from cwd. Shared by the bus and role routing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export function orchYamlPath(cwd = process.cwd()): string {
  if (process.env.ORCH_CONFIG) return process.env.ORCH_CONFIG;
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, "orch.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return candidate;
    dir = parent;
  }
}

export function loadOrchDoc(cwd = process.cwd()): Record<string, unknown> | null {
  const path = orchYamlPath(cwd);
  if (!existsSync(path)) return null;
  const doc = parse(readFileSync(path, "utf8"));
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("orch.yaml: must be an object");
  return doc as Record<string, unknown>;
}
