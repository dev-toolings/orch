// Which running leads run older code or settings than this checkout: printed
// by `orch install` and `orch doctor`, never acted on (restarting a lead is
// the operator's call). A lead's code and argv are fixed at its launch, so a
// pull or a profile change reaches it only through a restart. Kiba runs on
// Claude only: a Codex or Grok lead, a conductor or a presence session
// started by an older launcher is told to quit.
import { ROOT } from "../core/profile.ts";
import { codeRevision, type LaunchRecord, liveLaunches, staleReason } from "../core/lead-pulse.ts";
import { stateDir } from "../core/paths.ts";
import { leadsFromProc } from "../dash/leads.ts";
import type { DashLead } from "../dash/types.ts";
import { currentLeadChoice } from "../lead.ts";

export interface RestartDeps {
  state?: string;
  rev?: string | null;
  launches?: LaunchRecord[];
  // Living leads from /proc with their parent map (tests pass fixtures).
  proc?: { leads: DashLead[]; parents: Map<number, number> };
  current?: () => { model: string | null; effort: string | null };
}

const retired = (rec: Pick<LaunchRecord, "harness" | "execution" | "presence">) =>
  rec.harness !== "claude" ? `Kiba runs on Claude only (${rec.harness} is a lane worker and reviewer)`
    : rec.presence ? "the presence lead is retired (orch serve replaced it)"
      : rec.execution !== "native" ? "the dispatch-only conductor is retired (orch serve replaced it)" : null;

export function restartNotes(d: RestartDeps = {}): string[] {
  const rev = d.rev === undefined ? codeRevision(ROOT) : d.rev;
  const current = d.current ?? currentLeadChoice;
  const launches = d.launches ?? liveLaunches(d.state ?? stateDir());
  const out: string[] = [];
  for (const rec of launches) {
    const gone = retired(rec);
    if (gone) { out.push(`RESTART ${rec.conductor ?? "kiba"} pid ${rec.pid} in ${rec.cwd}: ${gone}; quit it and start kiba in ${rec.cwd}`); continue; }
    const why = staleReason(rec, { rev, ...current() });
    if (why) out.push(`RESTART kiba pid ${rec.pid} in ${rec.cwd}: ${why}; quit it and start kiba again in ${rec.cwd}`);
  }
  // Leads started before launch records existed: judged on their argv only.
  const proc = d.proc ?? leadsFromProc();
  const known = new Set(launches.map((r) => r.pid));
  const tracked = (pid: number | null) => {
    for (let p = pid ?? 0, n = 0; p > 1 && n < 64; p = proc.parents.get(p) ?? 0, n++) if (known.has(p)) return true;
    return false;
  };
  for (const lead of proc.leads) {
    if (tracked(lead.pid)) continue;
    if (lead.harness !== "claude") { out.push(`RESTART lead pid ${lead.pid} in ${lead.cwd}: ${retired({ harness: lead.harness, execution: "native", presence: false })}; quit it and start kiba in ${lead.cwd}`); continue; }
    const want = current();
    const drift = [
      want.model && lead.model !== want.model ? `model ${lead.model} -> ${want.model}` : "",
      want.effort && lead.effort !== want.effort ? `effort ${lead.effort} -> ${want.effort}` : "",
    ].filter(Boolean).join(", ");
    out.push(`RESTART lead pid ${lead.pid} in ${lead.cwd}: started before launch tracking${drift ? `, ${drift}` : ", code unknown"}; quit it and start kiba again in ${lead.cwd}`);
  }
  return out;
}
