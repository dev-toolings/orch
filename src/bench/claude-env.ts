import { join } from "node:path";
import { ROOT } from "../core/profile.ts";
import { projectKey } from "../core/project.ts";

const STRIP = /^(ORCH_LEAD|ORCH_HARNESS|ORCH_SESSION|ORCH_STATE|ORCH_MEMORY|ORCH_MEMORY_PROVIDER|ORCH_MEM_SANDBOX|ORCH_BRAIN_CONFIG|ORCH_BRAIN_SNAPSHOT|ORCH_BRAIN_PROJECT|ORCH_BENCH_RUN|ORCH_LLM_CONFIG|ORCH_LANE|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/;

export interface ClaudeEnvCtx {
  out: string;
  stateDirs: Record<string, string>;
  run: { id: string };
  binPaths: Partial<Record<string, string>>;
  benchBrains: Partial<Record<string, string>>;
  llmConfig: string;
  brainSnapshot?: string;
  brainProject?: string;
  envOverrides?: Record<string, string>;
}

export function claudeEnv(config: string, session: string, ctx: ClaudeEnvCtx, sandboxId = session): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIP.test(key)) env[key] = value;
  }
  Object.assign(env, ctx.envOverrides);
  env.ORCH_MEM_SANDBOX = join(ctx.out, `mem-${config}`, sandboxId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  Object.assign(env, { ORCH_STATE: ctx.stateDirs[config], ORCH_BENCH_RUN: ctx.run.id, ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  env.ORCH_LLM_CONFIG = ctx.llmConfig;
  if (ctx.binPaths[config]) env.PATH = ctx.binPaths[config] + ":" + (env.PATH ?? "");
  if (ctx.brainSnapshot) env.ORCH_BRAIN_SNAPSHOT = ctx.brainSnapshot;
  if (ctx.brainProject) env.ORCH_BRAIN_PROJECT = ctx.brainProject;
  if (config === "A") return env;
  Object.assign(env, { ORCH_LEAD: "1", ORCH_HARNESS: "claude", ORCH_SESSION: session });
  if (config === "B") env.ORCH_MEMORY = "off";
  if (config === "C") {
    env.ORCH_BRAIN_CONFIG = ctx.benchBrains.C!;
    env.ORCH_MEMORY_PROVIDER = "hindsight";
  }
  if (config === "D") {
    env.ORCH_BRAIN_CONFIG = ctx.benchBrains.D!;
    env.ORCH_MEMORY_PROVIDER = "brain";
    env.ORCH_BRAIN_SNAPSHOT = ctx.brainSnapshot!;
    env.ORCH_BRAIN_PROJECT = ctx.brainProject ?? projectKey(ROOT);
  }
  return env;
}
