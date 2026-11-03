import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDash, collectSubagents } from "../src/dash/collect.ts";
import { runHook } from "../src/hooks/hook.ts";
import { tempEnv } from "./e2e/kiba/harness.ts";

test("subagent start and stop append two light events and collect one finished session record", async () => {
  const fixture = tempEnv();
  try {
    const env: Record<string, string> = { ...fixture.env, ORCH_LEAD: "1", ORCH_LEAD_PID: "4242" };
    const input = { session_id: "native-session", agent_id: "worker-1", agent_type: "general-purpose", cwd: fixture.root };
    expect(await runHook("subagent-start", "claude", input, env)).toBe("");
    expect(collectSubagents(env.ORCH_STATE)).toMatchObject([{ running: true, ended: null }]);
    expect(await runHook("subagent-stop", "claude", { ...input,
      agent_transcript_path: join(fixture.root, "agent.jsonl"), last_assistant_message: "x".repeat(400),
    }, env)).toBe("");
    const records = readFileSync(join(env.ORCH_STATE, "subagents/native-session.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((row) => row.event)).toEqual(["subagent-start", "subagent-stop"]);
    expect(records[1].last_assistant_message).toHaveLength(300);
    const snapshot = collectDash({
      state: env.ORCH_STATE, home: env.HOME, projectsRoot: fixture.root, labRoot: fixture.root,
      busRoot: null, procRoot: null, claudeProjects: fixture.root,
      policy: { spend: { daily_usd: 0, embed_usd_per_million: 0 }, paid_routines: [] }, machine: { cores: 4, memAvailableGib: 8 },
      lanes: [], leads: [], ledger: [], spendRows: [], planUsed: 0, logs: [], skills: [], installed: [],
    });
    expect(snapshot.subagents).toHaveLength(1);
    expect(snapshot.subagents![0]).toMatchObject({ agent_id: input.agent_id, agent_type: input.agent_type, cwd: input.cwd, session: input.session_id,
      lead_pid: 4242, running: false, started: records[0].at, ended: records[1].at,
      transcript_path: join(fixture.root, "agent.jsonl"), last_assistant_message: "x".repeat(300),
    });
    // Async hook scheduling may persist the stop first.
    writeFileSync(join(env.ORCH_STATE, "subagents/native-session.jsonl"), records.reverse().map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(collectSubagents(env.ORCH_STATE)).toEqual(snapshot.subagents!);
  } finally { fixture.cleanup(); }
});
