import { claudeWorkerSettings } from "../lanes/guard.ts";
import { estimateUsageUsd } from "../core/paid.ts";
import type { HarnessId } from "./registry.ts";
import type { ModelChoice } from "../core/profile.ts";

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

// Appended to a headless Claude write worker's system prompt. Claude Opus 5.5
// can end a turn on a progress note while work is still owed, and under
// `claude -p` that ends the run. Adapted from the "unattended agentic runs"
// section of Anthropic's Opus 5.5 prompting guide. The LANE line lets lane
// tell a finished run from an early stop.
export const CLAUDE_FINISH = `You run headless: nobody reads your messages until the run ends, and a message with no tool call ends the run. Do not end a message with a summary that announces the next step, an offer to continue, a list of decisions that block nothing, or a report written because a milestone is done. Put status notes in the same message as your next tool call and keep going. Write files with Edit or Write, never through shell redirection or shell scripts. One denied Bash command does not mean Bash is unavailable: do not retry the denied action through another shell command, but still run your targeted check (the test that covers your change) in a separate Bash call before reporting completion. End the run only when the spec's ACCEPT criteria are met, or when nothing can advance without the operator. The last line of your final message is exactly \`LANE: done\` or \`LANE: blocked: <what blocks you>\`.`;

// Sent as the next user message when a Claude run ended without a LANE line.
export const CLAUDE_CONTINUE = `Your last message did not end with a LANE line, so lane treats the task as unfinished. Continue with what the spec still requires. End with \`LANE: done\` once ACCEPT is met, or \`LANE: blocked: <what blocks you>\` if nothing can advance.
`;

export interface WorkerCall {
  argv: string[];
  // file fed on stdin (codex, claude) or passed as --prompt-file (grok)
  promptPath: string;
  stdin: boolean;
}

// A worker writes only its worktree and temporary directories.
// Its harness argv must never grant access beyond that boundary.

// A headless Claude worker must run its own checks (tests, typecheck) like a
// Codex or Grok worker, with no one to approve a prompt. `acceptEdits` approves
// no shell command, so every Bash call was denied. Bash runs instead inside
// Claude Code's OS sandbox (bubblewrap + socat on Linux), where it is approved
// automatically and cannot write outside the worktree; `dontAsk` refuses
// whatever would still need a prompt rather than hanging. File writes are
// allowed only under the worktree through Edit(/**) (`/` is the project root
// in permission rules; Claude Code checks Write through Edit rules, see
// src/install/claude-rules.ts). Without the sandbox's dependencies the worker refuses to start
// (failIfUnavailable) instead of running unconfined. No settings source is
// loaded (`--setting-sources ""`): the operator's or the repository's settings
// (excludedCommands, allowWrite, additionalDirectories, allow rules, hooks)
// would otherwise widen what the worker may do; only the flags below apply.
export const GROK_WRITE_PROFILE = "orch-lane";
export const GROK_REVIEW_PROFILE = "orch-review";

export const CLAUDE_SANDBOX = {
  sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
};
// The sandbox of a Claude write worker given the lane's own temp dir (its
// TMPDIR): that one directory joins the writable paths, nothing broader (not
// /tmp, not HOME). Claude Code's sandbox makes /tmp read-only, so without it
// `bun test` dies on mkdtemp.
export function claudeSandbox(tmpDir?: string): object {
  if (!tmpDir) return CLAUDE_SANDBOX;
  return { sandbox: { ...CLAUDE_SANDBOX.sandbox, filesystem: { allowWrite: [tmpDir] } } };
}
export const CLAUDE_WRITE_WORKER = [
  "--permission-mode", "dontAsk",
  "--settings", JSON.stringify(CLAUDE_SANDBOX),
  "--allowedTools", "Read", "Glob", "Grep", "Edit(/**)",
];

// Read-only consults (ask / review / judge). `--permission-mode plan` makes
// Claude Code pick sonnet instead of the requested haiku (~10×). Tools
// enforce read-only; the --model flag then stays haiku.
export const CLAUDE_READ_TOOLS = [
  "--allowedTools", "Read", "Grep", "Glob",
  "--disallowedTools", "Edit", "Write", "Bash", "Agent",
];

export function workerArgv(
  to: HarnessId,
  choice: ModelChoice,
  // bin: the executable to run instead of the harness name (lane pins Grok's).
  // search: live web search for the worker (codex: web_search config; claude: WebSearch/WebFetch; grok: unsupported, ignored).
  // tmpDir: the lane's own temp dir (its TMPDIR); a Claude write worker's sandbox may write it.
  opts: { cwd: string; promptPath: string; effort?: string; readOnly: boolean; lastMessagePath: string; bin?: string; search?: boolean; tmpDir?: string },
): WorkerCall {
  const effort = opts.effort ?? choice.effort;
  if (to === "codex") {
    const argv = ["codex", "exec", "--json"];
    if (choice.model) argv.push("--model", choice.model);
    if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
    if (opts.search) argv.push("-c", 'web_search="live"');
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
  // A write worker streams its events (stream-json) so lane can follow it
  // live (progress.json); its final `result` event carries the same fields
  // as the json format. Read-only consults keep the single json object.
  const argv = ["claude", "-p", ...(opts.readOnly ? ["--output-format", "json"] : ["--output-format", "stream-json", "--verbose"]), "--setting-sources", ""];
  if (choice.model) argv.push("--model", choice.model);
  if (effort) argv.push("--effort", effort);
  if (opts.readOnly) argv.push(...CLAUDE_READ_TOOLS);
  else {
    // The write guard (src/lanes/guard.ts) joins the sandbox settings: a file
    // tool aimed outside the worktree is denied before it runs.
    const write = [...CLAUDE_WRITE_WORKER];
    write[write.indexOf("--settings") + 1] = JSON.stringify(claudeWorkerSettings(opts.cwd, claudeSandbox(opts.tmpDir)));
    argv.push("--disallowedTools", "Agent", ...write, "--append-system-prompt", CLAUDE_FINISH);
  }
  if (opts.search) argv.push("--allowedTools", "WebSearch", "WebFetch");
  return { argv, promptPath: opts.promptPath, stdin: true };
}

export interface Usage {
  input?: number;
  cached?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  total?: number;
  costUsd?: number;
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

// One parsed JSON line per stream-json event; other lines (stderr) are null.
function jsonLine(line: string): any {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

const isStreamEvent = (o: any) => typeof o?.type === "string" && o.type !== "result";

// The final object of a Claude run: the last `result` event of a stream-json
// log, else the single object of a json log. A stream that ended without a
// result (timeout, crash) has none: undefined, as a json run with no output.
export function claudeResult(log: string): any {
  const lines = log.split("\n");
  let streamed = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = jsonLine(lines[i]);
    if (!o) continue;
    if (o.type === "result") return o;
    if (isStreamEvent(o)) streamed = true;
  }
  return streamed ? undefined : lastJson(log);
}

// What classify reads from a Claude log: stderr and the final result, as the
// json format printed, never the streamed transcript (a tool output saying
// "permission denied" is not a sandbox denial of the run).
export function classifyLog(to: HarnessId, log: string): string {
  if (to === "codex") return log.split("\n").filter((line) => {
    const o = jsonLine(line);
    return !o || !/^(item|turn|thread)\./.test(o.type ?? "") || o.type === "turn.failed";
  }).join("\n");
  if (to !== "claude") return log;
  return log.split("\n").filter((line) => {
    const o = jsonLine(line);
    return !isStreamEvent(o) || o.type === "error" || (o.type === "system" && o.subtype === "error");
  }).join("\n");
}

function firstModelId(o: { model?: unknown; modelUsage?: unknown }): string | undefined {
  if (typeof o.model === "string" && o.model.trim()) return o.model.trim();
  if (o.modelUsage && typeof o.modelUsage === "object") {
    const id = Object.keys(o.modelUsage as object)[0];
    if (id) return id;
  }
  return undefined;
}

function parseCodexTokenCount(line: string): null | { model: string; usage: Usage } {
  let row: any;
  try { row = JSON.parse(line); } catch { return null; }
  const payload = row?.payload ?? row;
  if (payload?.type !== "token_count") return null;
  const info = payload?.info ?? {};
  const u = info.total_token_usage ?? payload.last_token_usage ?? info.last_token_usage;
  if (!u) return null;
  const input = Number(u.input_tokens ?? 0) || 0;
  const output = (Number(u.output_tokens ?? 0) || 0) + (Number(u.reasoning_output_tokens ?? 0) || 0);
  const cacheRead = Number(u.cached_input_tokens ?? 0) || 0;
  return {
    model: String(info.model ?? row?.model ?? "codex"),
    usage: { input, output, cacheRead, total: input + output + cacheRead },
  };
}

export function parseWorkerOutput(to: HarnessId, log: string, lastMessage: string): { message: string; usage: Usage; model?: string } {
  if (to === "codex") {
    let latest: { model: string; usage: Usage } | null = null;
    let streamed: Usage | undefined;
    let message = lastMessage;
    for (const line of log.split("\n")) {
      const ev = jsonLine(line);
      if (ev?.type === "turn.completed" && ev.usage) {
        const input = Number(ev.usage.input_tokens) || 0;
        const cacheRead = Number(ev.usage.cached_input_tokens) || 0;
        const output = Number(ev.usage.output_tokens) || 0;
        streamed = addUsage(streamed ?? {}, { input: Math.max(0, input - cacheRead), cacheRead, output, total: input + output });
      }
      if (ev?.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string" && !lastMessage) message = ev.item.text;
    }
    if (streamed) return { message, usage: { ...streamed, costUsd: estimateUsageUsd({ ...streamed, provider: "codex" }) } };
    for (const line of log.split("\n")) {
      const parsed = parseCodexTokenCount(line);
      if (parsed) latest = parsed;
    }
    if (latest) return { message: lastMessage, usage: latest.usage, model: latest.model };
    const m = /tokens used\s*\n\s*([\d\s,.]+)/.exec(log);
    const total = m ? Number(m[1].replace(/[^\d]/g, "")) : undefined;
    return { message: lastMessage, usage: { total } };
  }
  const o = claudeResult(log) ?? {};
  const u = o.usage ?? {};
  const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheCreation = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const cached = cacheRead + cacheCreation;
  const cost = Number(o.total_cost_usd);
  return {
    message: String(o.result ?? o.text ?? lastMessage ?? ""),
    model: firstModelId(o),
    usage: {
      input: u.input_tokens,
      cached: cached || undefined,
      cacheRead: cacheRead || undefined,
      cacheCreation: cacheCreation || undefined,
      output: u.output_tokens,
      total: u.total_tokens ?? (u.input_tokens != null ? u.input_tokens + cached + (u.output_tokens ?? 0) : undefined),
      costUsd: Number.isFinite(cost) ? cost : undefined,
    },
  };
}

// The worker's own verdict: the last line of its final message, or null.
export function finishLine(message: string): string | null {
  const last = message.trimEnd().split("\n").pop() ?? "";
  // Markdown around the line (`LANE: done`, **LANE: done**) still counts.
  return /^LANE:\s*(done|blocked:\s*\S.*?)$/.exec(last.trim().replace(/^[`*_]+|[`*_]+$/g, "").trim())?.[1] ?? null;
}

export function sessionId(log: string): string | undefined {
  const id = claudeResult(log)?.session_id;
  return typeof id === "string" ? id : undefined;
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) => (x == null && y == null ? undefined : (x ?? 0) + (y ?? 0));
  return {
    input: sum(a.input, b.input),
    cached: sum(a.cached, b.cached),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheCreation: sum(a.cacheCreation, b.cacheCreation),
    output: sum(a.output, b.output),
    total: sum(a.total, b.total),
    costUsd: sum(a.costUsd, b.costUsd),
  };
}

// Claude `--resume` reports session-cumulative `total_cost_usd`. A follow
// records only the increment since the last cost stored on the lane.
export function sessionCostDelta(previous: Usage, parsed: Usage): Usage {
  if (parsed.costUsd == null) return { ...parsed };
  return { ...parsed, costUsd: Math.max(0, parsed.costUsd - (previous.costUsd ?? 0)) };
}

const BLOCKED = /permission denied|not permitted|operation not allowed|blocked by (policy|sandbox|classifier)|denied by/i;
export interface EngineUnavailable { kind: "auth" | "quota"; reason: string }

export function engineUnavailable(text: string): EngineUnavailable | null {
  // A successful final message may mention quota or auth as task data.
  const evidence = text.split("\n").filter((line) => {
    const o = jsonLine(line);
    return !(typeof o?.result === "string" && o.is_error !== true && (o.is_error === false || finishLine(o.result) === "done"));
  }).join("\n");
  if (/failed to authenticate|oauth session expired|login expired|please run \/login|not logged in|unauthori[sz]ed|\b401\b|authentication|login expiré/i.test(evidence)) return { kind: "auth", reason: "login expiré" };
  if (/rate.?limit|quota|usage.?limit|\b429\b/i.test(evidence)) return { kind: "quota", reason: "quota atteint" };
  return null;
}

const UNAVAILABLE = /model .* (not found|unavailable|not supported)|command not found|ENOENT/i;

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
  if (input.spawnError || (!input.changed && engineUnavailable(input.log)) || (!input.changed && input.code !== 0 && UNAVAILABLE.test(input.log))) return "unavailable";
  if (!input.changed && BLOCKED.test(input.log)) return "blocked";
  if (input.code !== 0) return "failed";
  if (!input.changed) return input.verifyOk ? "noop" : "refused";
  return input.verifyOk === false ? "failed" : "complete";
}

// Orch VERIFY is the status. A worker `LANE: blocked` line is a note once
// VERIFY passed on a change; a worker `LANE: done` cannot make a failed VERIFY complete.
export function resolveLaneStatus(input: {
  status: Status;
  verifyOk: boolean | null;
  changed: boolean;
  finish?: string | null;
  continued?: number;
}): { status: Status; reason?: string } {
  let { status } = input;
  if (status === "timeout" || status === "unavailable") return { status };
  if (input.verifyOk === false && (status === "complete" || status === "noop")) status = "failed";
  if (input.finish === undefined || input.finish === "done") return { status };

  const reason = input.finish
    ? `worker ${input.finish}`
    : `worker ended without a LANE line${input.continued ? ` after ${input.continued} continuation(s)` : ""}: check ACCEPT before integrating`;
  if (input.finish === null && status === "noop") status = "failed";
  else if (input.finish !== null && !(input.verifyOk === true && input.changed)) status = "blocked";
  return { status, reason };
}
