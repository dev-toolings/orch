import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../core/profile.ts";
import { notify } from "../presence/notify.ts";
import { loadPresenceConfig } from "../presence/presence.ts";
import { collect } from "../improve/improve.ts";
import { stateDir } from "../core/paths.ts";
import { acceptCandidate, latest, readCandidates, reflectDir, reflectionMaterials, rejectCandidate, runReflect } from "./reflect.ts";

export const REFLECT_USAGE = `usage: orch reflect digest        the last 24 h and current memory, no model call
       orch reflect run           reflect on that evidence and send the result to the phone
       orch reflect show [date]   the latest reflection, or that of YYYY-MM-DD
       orch reflect accept <n>    add a pending rule to USER.md
       orch reflect reject <n>    reject a pending rule
       orch reflect candidates   list pending rules`;

const projects = () => join(process.env.ORCH_HOME ?? homedir(), ".claude", "projects");
const candidateLine = (candidate: { n: number; text: string; evidence: string }) =>
  `${candidate.n}. ${candidate.text} (preuve : ${candidate.evidence})`;

function candidateNumber(value: string | undefined, action: string): number {
  const n = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`reflect ${action}: expected a positive candidate number`);
  return n;
}

export async function reflect(args: string[]): Promise<void> {
  const [sub, arg] = args;
  const state = stateDir();
  if (sub === "digest") {
    const digest = collect({ since: new Date(Date.now() - 86_400_000), projects: projects(), state });
    process.stdout.write(`${reflectionMaterials(state, digest.text)}\n`);
  } else if (sub === "run") {
    const profile = loadProfile();
    const c = loadPresenceConfig();
    const result = await runReflect({
      projects: projects(), state, choice: profile.improve ?? profile.lead.claude,
      timeoutMs: profile.limits.timeout_seconds * 1000,
      notify: async (notice) => { await notify(notice, c.notify); },
    });
    console.log(result.note);
    for (const candidate of result.candidates) console.log(`  ${candidateLine(candidate)}`);
  } else if (sub === "show") {
    if (arg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error("reflect show: date as YYYY-MM-DD");
    const path = arg ? join(reflectDir(state), `${arg}.md`) : latest(state);
    if (!path || !existsSync(path)) throw new Error(`reflect: no reflection${arg ? ` for ${arg}` : " yet"} (routine reflect, or orch reflect run)`);
    process.stdout.write(readFileSync(path, "utf8"));
  } else if (sub === "accept") {
    const result = acceptCandidate(candidateNumber(arg, "accept"), state);
    console.log(`accepted: ${result.line}`);
  } else if (sub === "reject") {
    const candidate = rejectCandidate(candidateNumber(arg, "reject"), state);
    console.log(`rejected: ${candidate.n}. ${candidate.text}`);
  } else if (sub === "candidates") {
    const pending = readCandidates(state).filter((candidate) => candidate.status === "pending");
    if (!pending.length) console.log("no pending candidates");
    else for (const candidate of pending) console.log(candidateLine(candidate));
  } else {
    console.log(REFLECT_USAGE);
    process.exitCode = 2;
  }
}
