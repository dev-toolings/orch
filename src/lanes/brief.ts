// Worker brief: a clean, explicit hand-off. Never a dump of the parent session.
import type { Spec } from "./spec.ts";

export interface BriefInput {
  spec: Spec;
  cwd: string;
  context?: string;
}

export function formatBrief(input: BriefInput): string {
  const objective = (input.spec.fields.OBJECTIVE ?? "").trim() || "(unset)";
  const deliverable = (input.spec.fields.FILES ?? "").trim() || "(unset)";
  const done = [
    (input.spec.fields.ACCEPT ?? "").trim(),
    input.spec.verify ? `VERIFY exits 0: ${input.spec.verify}` : "",
  ].filter(Boolean).join("\n") || "(unset)";
  const context = [
    input.context?.trim(),
    (input.spec.fields.INTERFACES ?? "").trim() && `INTERFACES:\n${input.spec.fields.INTERFACES.trim()}`,
    (input.spec.fields.CONSTRAINTS ?? "").trim() && `CONSTRAINTS:\n${input.spec.fields.CONSTRAINTS.trim()}`,
  ].filter(Boolean).join("\n\n") || "(none)";
  return `BRIEF
OBJECTIVE: ${objective}
CWD: ${input.cwd}
CONTEXT:
${context}
DELIVERABLE:
${deliverable}
DONE:
${done}

This is a new conversation. Implement the brief here. Do not start another
orchestration. Do not run the full VERIFY command: lane runs it after you
finish. Run only targeted checks on what you touch.
VERIFY already runs from the worktree root. Run plain commands: a \`VAR=\`
prefix, a \`cd\` or a compound pipe may be refused. TMPDIR is your own
writable temp dir.
`;
}
