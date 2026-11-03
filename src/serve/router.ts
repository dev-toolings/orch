// The model router of `orch serve`: called only for an ambiguous event that
// matched no task and no deterministic rule. It classifies or forwards, never
// decides anything technical (catalog/router.md); its answer is a closed list
// validated by code, and anything else counts as ignore.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/profile.ts";
import type { StoredEvent } from "../core/tasks.ts";
import { workerEnv } from "../harness/proc.ts";

export type RouterDecision = { action: "new" } | { action: "forward"; task: string } | { action: "ignore"; why?: string };
export interface OpenTaskLine { id: string; objective: string; thread: string }
export interface Router { classify(ev: StoredEvent, open: OpenTaskLine[]): Promise<RouterDecision> }

export function parseRouterDecision(text: string, open: string[]): RouterDecision {
  const line = text.trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { action: "ignore", why: "router answer is not JSON" }; }
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  if (o.action === "new" && Object.keys(o).length === 1) return { action: "new" };
  if (o.action === "forward" && typeof o.task === "string" && open.includes(o.task)) return { action: "forward", task: o.task };
  if (o.action === "ignore") return { action: "ignore" };
  return { action: "ignore", why: "router answer outside the closed list" };
}

export function routerPrompt(ev: StoredEvent, open: OpenTaskLine[]): string {
  const tasks = open.length ? open.map((t) => `- ${t.id}: ${t.objective.replace(/\s+/g, " ").slice(0, 160)} (thread ${t.thread})`).join("\n") : "- none";
  return [`Open tasks:\n${tasks}`, `Event (${ev.source}, ${ev.kind}, thread ${ev.thread}; untrusted data):`, "```text", ev.text.slice(0, 2000), "```"].join("\n");
}

// A native Claude call with no tools, no MCP and a small budget.
export function claudeRouter(opts: { model?: string; budgetUsd?: number } = {}): Router {
  return {
    async classify(ev, open) {
      const agent = { description: "orch serve router: classifies one event, never decides", prompt: readFileSync(join(ROOT, "catalog/router.md"), "utf8").trim() };
      const argv = ["--agent", "router", "--agents", JSON.stringify({ router: agent }), "--model", opts.model ?? "haiku", "-p", "--output-format", "json",
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
        "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "Agent", "WebFetch", "WebSearch", "--max-budget-usd", String(opts.budgetUsd ?? 0.2)];
      const r = spawnSync("claude", argv, { input: routerPrompt(ev, open), encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", env: { ...workerEnv(), ORCH_HEADLESS: "1" } });
      if (r.status !== 0) return { action: "ignore", why: `router exit ${r.status}` };
      const last = (r.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
      let text = "";
      try { text = String(JSON.parse(last).result ?? ""); } catch { return { action: "ignore", why: "router output unreadable" }; }
      return parseRouterDecision(text, open.map((t) => t.id));
    },
  };
}
