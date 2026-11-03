// Code-first event filter with provenance, extracted from src/kiba/rules.ts
// (which re-exports it for the old conductor). Shared by orch serve: drops
// chatter, green CI and status pings, and routes an event whose thread has
// an owner straight to it. No model call.
export type EventSource = "operator" | "ci" | "lane" | "orch";
export type EventKind = "task" | "chatter" | "comment" | "ci_fail" | "ci_pass" | "cancel";
export interface InboundEvent { id: string; source: EventSource; kind: EventKind; task?: string; text: string; repo?: string; owner?: string }

export type Verdict =
  | { to: "drop"; why: string }
  | { to: "lane"; task: string; owner: string }
  | { to: "fast-path"; task: string }
  | { to: "lead" };

// Status pings and acknowledgements: answered from the task state by code.
const NUDGES = [/^\+1\b/, /^(ok|merci|thanks?|bien vu|noté)\b/i, /tu en es o[uù]/i, /[çc]a avance/i, /pas press[ée]/i, /des nouvelles/i, /^(ping|up)\b/i, /any update/i, /status\s*\?/i];
export const isNudge = (text: string) => text.trim().length <= 40 && NUDGES.some((re) => re.test(text.trim()));

export interface FilterContext {
  // Lane holding this thread, if any (direct routing).
  holder: (task: string) => string | undefined;
  fastPath: boolean;
  trivial: (task: string) => boolean;
}

export function filterEvent(ev: InboundEvent, ctx: FilterContext): Verdict {
  if (ev.kind === "chatter") return { to: "drop", why: "chatter: acknowledged by code" };
  if (ev.kind === "ci_pass") return { to: "drop", why: "green CI: nothing to do" };
  if (ev.kind === "task") {
    if (ev.task && ctx.fastPath && ctx.trivial(ev.task)) return { to: "fast-path", task: ev.task };
    return { to: "lead" };
  }
  if (ev.kind === "comment" && isNudge(ev.text)) return { to: "drop", why: "status ping: answered from the task state" };
  const owner = ev.task ? ctx.holder(ev.task) : undefined;
  if (ev.task && owner) return { to: "lane", task: ev.task, owner };
  return { to: "lead" };
}

// Every event shown to the lead carries its origin; outside text is never trusted.
export function provenance(ev: InboundEvent): string {
  return ev.source === "orch" ? "src=orch" : `src=${ev.source} untrusted`;
}

