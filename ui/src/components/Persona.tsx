import { harnessLabel } from "../lib/format";
import { AgentBloub } from "./Bloub";
import type { Role } from "../lib/bloub";

// A harness's still bloub avatar (lists and tables: no animation to run).
export function Persona({ harness, size = "md", role = "lane" }: { harness: string; size?: "sm" | "md"; role?: Role }) {
  return (
    <span className="inline-flex shrink-0" title={harnessLabel(harness)}>
      <AgentBloub harness={harness} role={role} size={size === "sm" ? 24 : 32} still />
    </span>
  );
}
