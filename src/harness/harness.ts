import type { Harness, ModelChoice } from "../core/profile.ts";

// Scopes the run and opts out of any orchestration rule the worker's global
// instructions may carry. Wording taken from fable-advisor's luna-implementer:
// it does not ask the worker to ignore its instructions.
export const PREAMBLE = `Scope of this run: one implementation task, already planned and delegated by
an orchestrating session. Implement it directly in this run. I explicitly opt
out of starting an orchestration or delegation workflow for it. The model and
reasoning effort for this run are the ones set on the command line.
Do not run the full VERIFY command: lane runs it after you finish and reports its output. Run only targeted checks on what you touch (a typecheck of the touched files, the test that covers the change).

`;

export const REVIEW_PREAMBLE = `Scope of this run: one read-only review, delegated by an orchestrating session.
Do it directly in this run. I explicitly opt out of starting an orchestration or
delegation workflow. Do not modify any file.

`;

export interface WorkerCall {
  argv: string[];
  // file fed on stdin (codex, claude) or passed as --prompt-file (grok)
  promptPath: string;
  stdin: boolean;
}

// A headless Claude worker must run its own checks (tests, typecheck) like a
// Codex or Grok worker, with no one to approve a prompt. `acceptEdits` approves
// no shell command, so every Bash call was denied. Bash runs instead inside
// Claude Code's OS sandbox (bubblewrap + socat on Linux), where it is approved
// automatically and cannot write outside the worktree; `dontAsk` refuses
// whatever would still need a prompt rather than hanging. Edit and Write are
// allowed only under the worktree (`/` is the project root in permission
// rules). Without the sandbox's dependencies the worker refuses to start
// (failIfUnavailable) instead of running unconfined. No settings source is
// loaded (`--setting-sources ""`): the operator's or the repository's settings
// (excludedCommands, allowWrite, additionalDirectories, allow rules, hooks)
// would otherwise widen what the worker may do; only the flags below apply.
export const GROK_WRITE_PROFILE = "orch-lane";
export const GROK_REVIEW_PROFILE = "orch-review";

export const CLAUDE_SANDBOX = {
  sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
};
const CLAUDE_WRITE_WORKER = [
  "--permission-mode", "dontAsk",
  "--settings", JSON.stringify(CLAUDE_SANDBOX),
  "--allowedTools", "Read", "Glob", "Grep", "Edit(/**)", "Write(/**)",
];

export function workerArgv(
  to: Harness,
  choice: ModelChoice,
  // bin: the executable to run instead of the harness name (lane pins Grok's).
  opts: { cwd: string; promptPath: string; effort?: string; readOnly: boolean; lastMessagePath: string; bin?: string },
): WorkerCall {
  const effort = opts.effort ?? choice.effort;
  if (to === "codex") {
    const argv = ["codex", "exec"];
    if (choice.model) argv.push("--model", choice.model);
    if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
    argv.push(
      "-c", "agents.enabled=false",
      "-s", opts.readOnly ? "read-only" : "workspace-write",
      "--skip-git-repo-check", "-C", opts.cwd,
      "-o", opts.lastMessagePath, "-",
    );
    return { argv, promptPath: opts.promptPath, stdin: true };
  }
  if (to === "grok") {
    // the model is pinned on the command line (operator rule: grok-4.7-build-fast, high);
    // agent files still carry no model line (see src/install/render.ts)
    const argv = [
      opts.bin ?? "grok", "--cwd", opts.cwd, "--prompt-file", opts.promptPath,
      "--output-format", "json", "--no-subagents", "--always-approve", "--no-auto-update",
      // orch's profiles: no child network, ~/.grok agents/skills/binaries denied (catalog/grok-sandbox.toml)
      "--sandbox", opts.readOnly ? GROK_REVIEW_PROFILE : GROK_WRITE_PROFILE,
    ];
    if (choice.model) argv.push("--model", choice.model);
    if (effort) argv.push("--reasoning-effort", effort);
    return { argv, promptPath: opts.promptPath, stdin: false };
  }
  const argv = ["claude", "-p", "--output-format", "json", "--setting-sources", "", "--disallowedTools", "Agent"];
  if (choice.model) argv.push("--model", choice.model);
  if (effort) argv.push("--effort", effort);
  if (opts.readOnly) argv.push("--permission-mode", "plan");
  else argv.push(...CLAUDE_WRITE_WORKER);
  return { argv, promptPath: opts.promptPath, stdin: true };
}

export interface Usage {
  input?: number;
  cached?: number;
  output?: number;
  total?: number;
}

// Last JSON object printed by grok / claude headless runs.
function lastJson(log: string): any {
  const start = log.lastIndexOf("\n{");
  const text = start >= 0 ? log.slice(start + 1) : log.trimStart().startsWith("{") ? log : "";
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseWorkerOutput(to: Harness, log: string, lastMessage: string): { message: string; usage: Usage } {
  if (to === "codex") {
    const m = /tokens used\s*\n\s*([\d\s,.]+)/.exec(log);
    const total = m ? Number(m[1].replace(/[^\d]/g, "")) : undefined;
    return { message: lastMessage, usage: { total } };
  }
  const o = lastJson(log) ?? {};
  const u = o.usage ?? {};
  const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    message: String(o.result ?? o.text ?? lastMessage ?? ""),
    usage: {
      input: u.input_tokens,
      cached: cached || undefined,
      output: u.output_tokens,
      total: u.total_tokens ?? (u.input_tokens != null ? u.input_tokens + cached + (u.output_tokens ?? 0) : undefined),
    },
  };
}

const BLOCKED = /permission denied|not permitted|operation not allowed|blocked by (policy|sandbox|classifier)|denied by/i;
const UNAVAILABLE = /not logged in|unauthori[sz]ed|\b401\b|authentication|model .* (not found|unavailable|not supported)|command not found|ENOENT/i;

export type Status = "complete" | "noop" | "refused" | "blocked" | "failed" | "timeout" | "unavailable";

export function classify(input: {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  changed: boolean;
  verifyOk: boolean | null;
  log: string;
}): Status {
  if (input.timedOut) return "timeout";
  if (input.spawnError || (!input.changed && input.code !== 0 && UNAVAILABLE.test(input.log))) return "unavailable";
  if (!input.changed && BLOCKED.test(input.log)) return "blocked";
  if (input.code !== 0) return "failed";
  if (!input.changed) return input.verifyOk ? "noop" : "refused";
  return input.verifyOk === false ? "failed" : "complete";
}
