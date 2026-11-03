import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { leadMemoryDir, stateDir } from "../core/paths.ts";
import { projectKey } from "../core/project.ts";
import type { LaneState } from "../lane.ts";
import type { Harness } from "../core/profile.ts";
import type { HindsightConfig, RecallHit, RetainItem } from "../memory/hindsight.ts";
import { embeddingText, inspectSecrets } from "../memory/privacy.ts";
import { askDecision, denyDecision, commandDenyGuards, pathDenyGuards, protectedPath, sensitiveCommandGuards } from "../core/sensitive.ts";
import { hookGuardDecision, loadHookPolicy, type HookGuard, type HookPolicy } from "../core/hook-policy.ts";

// The per-tool hooks (pre-bash, post-tool) start one process per tool call:
// the lanes, the policy (yaml, ffi lock), the usage ingestion, the
// pulse and the journal load only in the events that use them. Static, they
// cost 40 ms of imports on every call (measured 2026-11-03, Bun 1.4.4).
const journal = () => import("./journal.ts");
const policy = () => import("../core/policy.ts");

export type HookEvent = "pre-bash" | "post-edit" | "prompt-submit" | "stop" | "session-start" | "session-end" | "post-tool" | "subagent-start" | "subagent-stop";

export interface MemoryDeps {
  config: () => HindsightConfig;
  recall: typeof import("../memory/hindsight.ts").recall;
  retain: typeof import("../memory/hindsight.ts").retain;
  format: typeof import("../memory/hindsight.ts").formatRecall;
}

interface HookState {
  preBashNudged: boolean;
  editFiles: string[];
  editLines: number;
  editNudged: boolean;
  blockedLaneSets: string[][];
  recalled: string[];
  injected: boolean;
  reportedModel: string;
  turnPrompt: string;
  busSeen: string[];
  freshNudged: boolean;
  handoffWritten: boolean;
  turns: number;
}

interface Token {
  kind: "word" | "op" | "subshell";
  value: string;
}

const HOOK_CONTEXT_CAP = 10_000;

const emptyState = (): HookState => ({
  preBashNudged: false,
  editFiles: [],
  editLines: 0,
  editNudged: false,
  blockedLaneSets: [],
  recalled: [],
  injected: false,
  reportedModel: "",
  turnPrompt: "",
  busSeen: [],
  freshNudged: false,
  handoffWritten: false,
  turns: 0,
});

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = string(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstValue(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (value[key] !== undefined) return value[key];
  return undefined;
}

function sessionKey(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string | null {
  const value = env.ORCH_SESSION || firstString(input, "session_id", "sessionId");
  if (!value) return null;
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

function statePath(session: string, env: NodeJS.ProcessEnv): string {
  return join(env.ORCH_STATE || stateDir(), "hooks", `${session}.json`);
}

function stateRoot(env: NodeJS.ProcessEnv): string {
  return env.ORCH_STATE || stateDir();
}

function turnPath(session: string, env: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), "hooks", `${session}.turn.jsonl`);
}

function projectName(input: Record<string, unknown>): string {
  // The repository's name, the same from a subfolder or a linked worktree:
  // the seed and orch mem key project memory the same way.
  const cwd = firstString(input, "cwd") || process.cwd();
  try { return projectKey(cwd) || basename(cwd) || "project"; } catch { return basename(cwd) || "project"; }
}

function readState(path: string): HookState {
  try {
    const saved = record(JSON.parse(readFileSync(path, "utf8")));
    return {
      preBashNudged: saved.preBashNudged === true,
      editFiles: Array.isArray(saved.editFiles) ? saved.editFiles.filter((x): x is string => typeof x === "string") : [],
      editLines: typeof saved.editLines === "number" && Number.isFinite(saved.editLines) ? saved.editLines : 0,
      editNudged: saved.editNudged === true,
      blockedLaneSets: Array.isArray(saved.blockedLaneSets)
        ? saved.blockedLaneSets.filter(Array.isArray).map((set) => set.filter((x): x is string => typeof x === "string"))
        : [],
      recalled: Array.isArray(saved.recalled)
        ? saved.recalled.filter((x): x is string => typeof x === "string").slice(-400)
        : [],
      injected: saved.injected === true,
      reportedModel: typeof saved.reportedModel === "string" ? saved.reportedModel : "",
      turnPrompt: typeof saved.turnPrompt === "string" ? saved.turnPrompt : "",
      busSeen: Array.isArray(saved.busSeen) ? saved.busSeen.filter((x): x is string => typeof x === "string").slice(-200) : [],
      freshNudged: saved.freshNudged === true,
      handoffWritten: saved.handoffWritten === true,
      turns: typeof saved.turns === "number" && Number.isFinite(saved.turns) ? saved.turns : 0,
    };
  } catch {
    return emptyState();
  }
}

function writeState(path: string, state: HookState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function words(input: Record<string, unknown>): Record<string, unknown> {
  return record(firstValue(input, "tool_input", "toolInput"));
}

function toolName(input: Record<string, unknown>): string {
  return firstString(input, "tool_name", "toolName") ?? "";
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines.length;
}

function shellTokens(command: string, substitutions = false): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let quote: "'" | '"' | "`" | null = null;
  const flush = () => {
    if (value) tokens.push({ kind: "word", value });
    value = "";
  };
  const ops = ["<<<", "<<-", "&&", "||", "|&", ">>", "<&", ">&", "<>", "<<", "|", "&", ";", "(", ")", "<", ">"];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (substitutions && quote === '"' && c === "`") {
        flush();
        let inner = "";
        let j = i + 1;
        for (; j < command.length; j++) {
          if (command[j] === "\\" && j + 1 < command.length) inner += command[j + 1] === "`" ? command[++j] : command[j] + command[++j]; // keep escapes, except the one before a backtick
          else if (command[j] === "`") break;
          else inner += command[j];
        }
        tokens.push({ kind: "subshell", value: inner });
        i = j;
        continue;
      }
      if (substitutions && quote === '"' && c === "$" && command[i + 1] === "(") {
        let depth = 1;
        let inner = "";
        let nestedQuote: "'" | '"' | null = null;
        let j = i + 2;
        for (; j < command.length && depth; j++) {
          const next = command[j];
          if (nestedQuote) {
            if (next === nestedQuote) { nestedQuote = null; inner += next; }
            else if (next === "\\" && nestedQuote === '"' && j + 1 < command.length) inner += next + command[++j];
            else inner += next;
          } else if (next === "'" || next === '"') { nestedQuote = next; inner += next; }
          else if (next === "\\" && j + 1 < command.length) inner += next + command[++j];
          else if (next === "(") { depth++; inner += next; }
          else if (next === ")") { depth--; if (depth) inner += next; }
          else inner += next;
        }
        tokens.push({ kind: "subshell", value: inner });
        i = j - 1;
        continue;
      }
      if (c === quote) quote = null;
      else if (c === "\\" && quote !== "'" && i + 1 < command.length) value += command[++i];
      else value += c;
      continue;
    }
    if (substitutions && c === "`") {
      flush();
      let inner = "";
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === "\\" && j + 1 < command.length) inner += command[j + 1] === "`" ? command[++j] : command[j] + command[++j]; // keep escapes, except the one before a backtick
        else if (command[j] === "`") break;
        else inner += command[j];
      }
      tokens.push({ kind: "subshell", value: inner });
      i = j;
      continue;
    }
    if (substitutions && c === "$" && command[i + 1] === "(") {
      flush();
      let depth = 1;
      let inner = "";
      let nestedQuote: "'" | '"' | null = null;
      let j = i + 2;
      for (; j < command.length && depth; j++) {
        const next = command[j];
        if (nestedQuote) {
          if (next === nestedQuote) { nestedQuote = null; inner += next; }
          else if (next === "\\" && nestedQuote === '"' && j + 1 < command.length) inner += next + command[++j];
          else inner += next;
        } else if (next === "'" || next === '"') { nestedQuote = next; inner += next; }
        else if (next === "\\" && j + 1 < command.length) inner += next + command[++j];
        else if (next === "(") { depth++; inner += next; }
        else if (next === ")") { depth--; if (depth) inner += next; }
        else inner += next;
      }
      tokens.push({ kind: "subshell", value: inner });
      i = j - 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      value += command[++i];
      continue;
    }
    if (c === "#" && value === "") {
      while (i < command.length && command[i] !== "\n") i++;
      if (i < command.length) tokens.push({ kind: "op", value: ";" });
      continue;
    }
    if (c === "\n" || /\s/.test(c)) {
      flush();
      if (c === "\n") tokens.push({ kind: "op", value: ";" });
      continue;
    }
    const op = ops.find((candidate) => command.startsWith(candidate, i));
    if (op) {
      flush();
      tokens.push({ kind: "op", value: op });
      i += op.length - 1;
      continue;
    }
    value += c;
  }
  flush();
  return tokens;
}

function executableIndex(stage: Token[]): number {
  let i = 0;
  while (i < stage.length) {
    const token = stage[i];
    if (token.kind === "op" && /^[<>]/.test(token.value)) {
      i += stage[i + 1]?.kind === "word" ? 2 : 1;
      continue;
    }
    if (token.kind !== "word") {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      i++;
      continue;
    }
    if (["env", "command", "exec", "time"].includes(token.value)) {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

// Any of the three harness binaries counts, whatever harness runs the session:
// the call that hung was a Claude lead running `codex exec`.
function modelCall(stage: Token[]): boolean {
  if (stage.some((t) => t.kind === "op" && t.value.startsWith("<<"))) return false;
  const executable = executableIndex(stage);
  if (executable < 0) return false;
  const name = stage[executable].value.split("/").pop()?.toLowerCase();
  const args = stage.slice(executable + 1).filter((t) => t.kind === "word").map((t) => t.value);
  const has = (...flags: string[]) => args.some((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
  if (has("--version", "-V", "--help", "-h")) return false;
  if (name === "claude") return has("-p", "--print");
  if (name === "codex") return args.includes("exec") || args.includes("e"); // after global options: codex -m x exec
  if (name === "grok") return !args.includes("--trust") && has("-p", "--prompt", "--prompt-file");
  return false;
}

function shouldRewrite(command: string): boolean {
  const tokens = shellTokens(command);
  let group: Token[] = [];
  let found = false;
  const inspect = (items: Token[]) => {
    let stage: Token[] = [];
    let stageIndex = 0;
    const check = () => {
      const provided = stageIndex > 0 || stage.some((t) => t.kind === "op" && t.value.startsWith("<"));
      if (!provided && modelCall(stage)) found = true;
      stage = [];
      stageIndex++;
    };
    for (const token of items) {
      if (token.kind === "op" && (token.value === "|" || token.value === "|&")) check();
      else stage.push(token);
    }
    if (stage.length) {
      const heredoc = stage.some((t) => t.kind === "op" && t.value.startsWith("<<"));
      const provided = stageIndex > 0 || stage.some((t) => t.kind === "op" && t.value.startsWith("<"));
      if (!heredoc && !provided && modelCall(stage)) found = true;
    }
  };
  for (const token of tokens) {
    if (token.kind === "op" && [";", "&&", "||", "&", "(", ")"].includes(token.value)) {
      inspect(group);
      group = [];
    } else group.push(token);
  }
  inspect(group);
  return found;
}

const PRE_BASH_CONTEXT = "Use `lane ask` to get another harness's view on a focused question.";
const POST_EDIT_CONTEXT = (files: number, lines: number) =>
  `Lead edits this request: ${files} files, ${lines} lines (threshold 2 files / 60 lines). Delegate the rest with lane run, or say in your report why you kept it.`;

function shellCommand(input: Record<string, unknown>): string | undefined {
  const value = firstValue(input, "command", "cmd");
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) return undefined;
  return value.map((part) => /^[A-Za-z0-9_./:=+-]+$/.test(part as string)
    ? part as string
    : `'${(part as string).replace(/'/g, "'\\''")}'`).join(" ");
}

function claudeBypass(input: Record<string, unknown>): boolean {
  return firstString(input, "permission_mode", "permissionMode") === "bypassPermissions";
}

function guardOutput(guards: HookGuard[], input: Record<string, unknown>, env: NodeJS.ProcessEnv, hooks: HookPolicy): string {
  // No one answers an ask in a headless run (ORCH_HEADLESS=1): it becomes a deny.
  const headless = env.ORCH_HEADLESS === "1";
  const result = hookGuardDecision(hooks, guards, claudeBypass(input) ? "bypass" : "default", headless);
  return result ? (result.decision === "deny" ? denyDecision(result.reason) : askDecision(result.reason)) : "";
}

function preBash(harness: Harness, input: Record<string, unknown>, state: HookState, env: NodeJS.ProcessEnv, hooks: HookPolicy): string {
  const name = toolName(input);
  const toolInput = words(input);
  const cwd = firstString(input, "cwd") || firstString(toolInput, "cwd") || process.cwd();
  const editName = name.toLowerCase().replace(/[^a-z]/g, "");
  if ((editName === "edit" || editName === "multiedit" || editName === "write" || editName === "read")) {
    const path = pathValue(toolInput);
    if (path) {
      const guards = pathDenyGuards(path, cwd, editName === "read" ? "read" : "edit");
      if (editName !== "read" && protectedPath(path, cwd)) guards.push({ id: "protected.paths", reason: `editing ${path} needs approval` });
      const output = guardOutput(guards, input, env, hooks);
      if (output) return output;
    }
    if (editName !== "read") return "";
    // Read of a non-secret file falls through only so Bash-shaped payloads
    // still get a command check; a plain Read is done.
    if (name !== "Bash") return "";
  }
  if (name !== "Bash") return "";
  const command = shellCommand(toolInput);
  if (command) {
    const output = guardOutput([...commandDenyGuards(command, cwd), ...sensitiveCommandGuards(command)], input, env, hooks);
    if (output) return output;
  }
  if (command === undefined || !shouldRewrite(command)) return "";
  const updatedInput = { ...toolInput, command: `{\n${command}\n} < /dev/null` };
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    updatedInput,
  };
  if (!state.preBashNudged) {
    hookSpecificOutput.additionalContext = PRE_BASH_CONTEXT;
    state.preBashNudged = true;
  }
  return JSON.stringify({ hookSpecificOutput });
}

function pathValue(input: Record<string, unknown>): string | undefined {
  return firstString(input, "file_path", "filePath", "path", "filename", "target_notebook");
}

function editCounts(harness: Harness, name: string, toolInput: Record<string, unknown>): { files: string[]; lines: number } {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  const files = new Set<string>();
  const ownPath = pathValue(toolInput);
  if (ownPath) files.add(ownPath);
  const write = normalized.includes("write");
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits.map(record) : [];
  let lines = 0;
  if (write) {
    const content = firstString(toolInput, "content", "contents", "text");
    if (content !== undefined) lines = lineCount(content);
  } else if (normalized.includes("edit") || normalized.includes("searchreplace") || normalized.includes("hashline") || normalized.includes("strreplace")) {
    const replacements = edits.length ? edits : [toolInput];
    for (const edit of replacements) {
      const path = pathValue(edit) ?? ownPath;
      if (path) files.add(path);
      const oldText = firstString(edit, "old_string", "oldString", "old_text", "oldText", "search", "old");
      const newText = firstString(edit, "new_string", "newString", "new_text", "newText", "replace", "replacement", "new");
      lines += Math.max(oldText === undefined ? 0 : lineCount(oldText), newText === undefined ? 0 : lineCount(newText));
    }
  }
  return { files: [...files], lines };
}

function postEdit(harness: Harness, input: Record<string, unknown>, state: HookState, hooks: HookPolicy): string {
  if (hooks.behaviors["nudge.post-edit"] === "off") return "";
  const name = toolName(input);
  const delta = editCounts(harness, name, words(input));
  if (!delta.files.length && delta.lines === 0) return "";
  const files = new Set(state.editFiles);
  for (const path of delta.files) files.add(path);
  state.editFiles = [...files];
  state.editLines += delta.lines;
  if (state.editNudged || (files.size <= 2 && state.editLines <= 60)) return "";
  state.editNudged = true;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: POST_EDIT_CONTEXT(files.size, state.editLines),
    },
  });
}

function branchExists(lane: LaneState): boolean {
  if (!lane.repo || !lane.branch) return false;
  const result = spawnSync("git", ["-C", lane.repo, "show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`], {
    stdio: "ignore",
    timeout: 1000,
  });
  return result.status === 0;
}

function integrated(lane: LaneState): boolean | null {
  const ref = `refs/heads/${lane.branch}`;
  const ancestor = spawnSync("git", ["-C", lane.repo, "merge-base", "--is-ancestor", ref, "HEAD"], { stdio: "ignore", timeout: 1000 });
  if (ancestor.status === 0) return true;
  if (ancestor.status !== 1) return null;
  const sameTree = spawnSync("git", ["-C", lane.repo, "diff", "--quiet", "HEAD", ref, "--"], { stdio: "ignore", timeout: 1000 });
  if (sameTree.status === 0) return true;
  if (sameTree.status === 1) return false;
  return null;
}

async function lanesForSession(session: string, env: NodeJS.ProcessEnv): Promise<LaneState[]> {
  const { listLanes } = await import("../lane.ts");
  const old = process.env.ORCH_STATE;
  if (env.ORCH_STATE !== undefined) process.env.ORCH_STATE = env.ORCH_STATE;
  try {
    return listLanes().filter((lane) => lane.session === session && (lane.status === "complete" || lane.status === "noop"))
      .filter((lane) => branchExists(lane))
      .filter((lane) => lane.status === "noop" || integrated(lane) === false);
  } finally {
    if (env.ORCH_STATE !== undefined) {
      if (old === undefined) delete process.env.ORCH_STATE;
      else process.env.ORCH_STATE = old;
    }
  }
}

async function stop(input: Record<string, unknown>, session: string | null, env: NodeJS.ProcessEnv, state: HookState, hooks: HookPolicy): Promise<string> {
  if (hooks.behaviors["stop.lane-pending"] === "off") return "";
  if (firstValue(input, "stop_hook_active", "stopHookActive") === true || !session) return "";
  const lanes = await lanesForSession(session, env);
  if (!lanes.length) return "";
  // Block once per lane: integrating one of two pending lanes must not block again
  // for the other, already reported.
  const reported = new Set(state.blockedLaneSets.flat());
  const fresh = lanes.filter((lane) => !reported.has(lane.id));
  if (!fresh.length) return "";
  state.blockedLaneSets.push(fresh.map((lane) => lane.id));
  const lane = fresh[0];
  const reason = `Lane ${lane.id} is ${lane.status} and not integrated: run lane integrate ${lane.id} (or apply its INTEGRATE line), or drop it with lane gc --drop ${lane.id}.`;
  return JSON.stringify({ decision: "block", reason });
}

async function memoryDeps(deps?: MemoryDeps, env: NodeJS.ProcessEnv = process.env): Promise<MemoryDeps> {
  if (deps) return deps;
  const provider = env.ORCH_MEMORY_PROVIDER
    ?? (await import("../brain/db.ts")).loadBrainConfig(env.ORCH_BRAIN_CONFIG).memory_provider;
  if (provider === "brain") return (await import("../memory/brain-recall.ts")).brainMemoryDeps(env);
  if (provider !== "hindsight") throw new Error(`unknown memory provider: ${provider}`);
  const hindsight = await import("../memory/hindsight.ts");
  return {
    config: hindsight.loadHindsightConfig,
    recall: hindsight.recall,
    retain: hindsight.retain,
    format: hindsight.formatRecall,
  };
}

function logMemoryFailure(event: HookEvent, error: unknown, env: NodeJS.ProcessEnv, sensitive: string[] = []): void {
  try {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of sensitive) if (value) message = message.split(value).join("[redacted]");
    message = message.replace(/[\r\n\t]+/g, " ").slice(0, 500) || "unknown memory error";
    const path = join(stateRoot(env), "hooks", "hindsight.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${event} ${message}\n`);
  } catch {}
}

function resultValue<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function recallMemory(
  event: HookEvent,
  query: string,
  maxTokens: number | null,
  project: string,
  env: NodeJS.ProcessEnv,
  deps: MemoryDeps | undefined,
  state: HookState,
  sensitive: string[] = [],
): Promise<string> {
  const originalQuery = query;
  try {
    const { recallLine } = await import("../memory/hindsight.ts");
    query = embeddingText(query);
    const client = await memoryDeps(deps, env);
    const config = client.config();
    const tokenCap = maxTokens ?? config.recall_max_tokens;
    const projectBank = `${config.bank}-${project}`;
    const [operatorResult, projectResult] = await Promise.all([
      client.recall(config, query, { bank: config.bank, max_tokens: tokenCap }),
      client.recall(config, query, { bank: projectBank, max_tokens: tokenCap }),
    ]);
    // One bank failing (a project bank before its first write answers 404)
    // must not hide the other's hits; only unexpected failures are logged.
    if (!operatorResult.ok && !/HTTP 404/.test(operatorResult.error)) {
      logMemoryFailure(event, new Error(operatorResult.error), env, [originalQuery, query, ...sensitive]);
    }
    if (!projectResult.ok && !/HTTP 404/.test(projectResult.error)) {
      logMemoryFailure(event, new Error(projectResult.error), env, [originalQuery, query, ...sensitive]);
    }
    const recalled = new Set(state.recalled);
    const minSemantic = event === "prompt-submit" ? config.recall_min_semantic ?? 0 : 0;
    const relevant = (hit: RecallHit) => minSemantic <= 0 || (typeof hit.scores?.semantic === "number" && hit.scores.semantic >= minSemantic);
    const sortHits = (hits: RecallHit[]): RecallHit[] => {
      const sorted = [...hits].sort((left, right) => {
        const a = left.scores?.final;
        const b = right.scores?.final;
        if (typeof a !== "number") return typeof b !== "number" ? 0 : 1;
        if (typeof b !== "number") return -1;
        return b - a;
      });
      const seen = new Set(recalled);
      return sorted.filter((hit) => {
        if (seen.has(hit.id) || !relevant(hit)) return false;
        seen.add(hit.id);
        return true;
      });
    };
    const projectHits = projectResult.ok ? sortHits(projectResult.value) : [];
    const operatorHits = operatorResult.ok ? sortHits(operatorResult.value) : [];
    const totalChars = Math.max(0, Math.floor(tokenCap * 4));
    const projectChars = Math.floor(totalChars * 2 / 3);
    const selectHits = (hits: RecallHit[], budget: number, priorHit = false): { hits: RecallHit[]; chars: number } => {
      const selected: RecallHit[] = [];
      let chars = 0;
      for (const hit of hits) {
        const line = recallLine(hit);
        const nextChars = chars + (selected.length || priorHit ? 1 : 0) + line.length;
        if (nextChars > budget) continue;
        selected.push(hit);
        chars = nextChars;
      }
      return { hits: selected, chars };
    };
    const projectSelection = selectHits(projectHits, projectChars);
    const operatorSelection = selectHits(
      operatorHits.filter((hit) => !projectSelection.hits.some((projectHit) => projectHit.id === hit.id)),
      totalChars - projectSelection.chars,
      projectSelection.hits.length > 0,
    );
    const hits = [...projectSelection.hits, ...operatorSelection.hits];
    if (!hits.length) return "";
    const formatted = client.format(hits, tokenCap);
    if (formatted) state.recalled = [...state.recalled, ...hits.map((hit) => hit.id)].slice(-400);
    return formatted;
  } catch (error) {
    logMemoryFailure(event, error, env, [originalQuery, query, ...sensitive]);
    return "";
  }
}

function cappedFile(path: string, limit: number): string {
  try {
    const content = readFileSync(path, "utf8");
    if (content.length <= limit) return content;
    return `${content.slice(0, limit)}\n[tronqué: ${content.length - limit} caractères de trop]`;
  } catch {
    return "";
  }
}

function resetTurnQueue(session: string | null, env: NodeJS.ProcessEnv): void {
  if (!session) return;
  try {
    const path = turnPath(session, env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch {}
}

async function sessionStart(
  input: Record<string, unknown>, session: string | null, env: NodeJS.ProcessEnv,
  state: HookState, deps?: MemoryDeps,
): Promise<string> {
  state.turnPrompt = "";
  resetTurnQueue(session, env);
  const source = firstString(input, "source");
  const cwd = firstString(input, "cwd") || process.cwd();
  const project = projectName(input);
  // A resumed conversation already holds USER.md / MEMORY.md. Re-inject
  // only a live recheck: the tree, lanes, spend and the mission log.
  if (source === "resume" && state.injected) {
    const context = cappedContext((await journal()).recheckBlock({ cwd, project, env, source: "resume" }));
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    } });
  }
  // After a compaction or a clear the earlier injections are gone from the
  // context: memories may be recalled again. The log, not the compact
  // summary, is the source of truth.
  if (source === "compact" || source === "clear") state.recalled = [];
  const root = leadMemoryDir(stateRoot(env));
  const sections: string[] = [];
  const user = cappedFile(join(root, "USER.md"), 1375);
  const memory = cappedFile(join(root, "MEMORY.md"), 2200);
  if (user) sections.push(`USER.md:\n${user}`);
  if (memory) sections.push(`MEMORY.md:\n${memory}`);
  let sessionTokens = 800;
  try { sessionTokens = (await memoryDeps(deps, env)).config().session_recall_tokens ?? 800; } catch {}
  const recall = env.ORCH_MEMORY === "off" ? "" : sessionTokens > 0 && !(await policy()).pauseReason(env) ? await recallMemory(
    "session-start",
    `projet ${project} : décisions récentes, travail en cours, préférences de l'opérateur`,
    sessionTokens,
    project,
    env,
    deps,
    state,
  ) : "";
  if (recall) sections.push(recall);
  try {
    const bus = await freshBusDigest(input, env, state);
    if (bus) sections.push(bus);
  } catch {}
  if (source === "compact" || source === "clear") {
    sections.push((await journal()).recheckBlock({ cwd, project, env, source }));
  } else {
    const { formatLog, readLog } = await journal();
    const existing = formatLog(readLog(project, env));
    if (existing) sections.push(existing);
  }
  if (!sections.length) return "";
  state.injected = true;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: cappedContext(sections.join("\n\n")) } });
}

async function freshBusDigest(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  state: HookState,
): Promise<string> {
  const { inboxFresh, loadBusConfig } = await import("../bus/bus.ts");
  const bus = loadBusConfig(firstString(input, "cwd") || process.cwd(), env);
  if (!bus) return "";
  const { digest, ids } = inboxFresh(bus, new Set(state.busSeen));
  if (ids.length) state.busSeen = [...new Set([...state.busSeen, ...ids])].slice(-200);
  return digest;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function cappedContext(text: string): string {
  if (text.length <= HOOK_CONTEXT_CAP) return text;
  return `${text.slice(0, HOOK_CONTEXT_CAP)}\n[truncated: ${text.length - HOOK_CONTEXT_CAP} chars]`;
}

async function postTool(input: Record<string, unknown>, session: string | null, env: NodeJS.ProcessEnv, turn: number): Promise<string> {
  if (!session) return "";
  const toolInput = words(input);
  const tool = toolName(input);
  const summary = firstString(toolInput, "command", "file_path", "pattern", "query", "url") ?? tool;
  const response = record(firstValue(input, "tool_response", "toolResponse"));
  // The turn number marks a background summary that lands after Stop reset
  // the queue: the next Stop drops it instead of retaining it with its turn.
  const line = {
    t: new Date().toISOString(),
    tool,
    summary: oneLine(summary),
    failed: response.is_error === true || Object.prototype.hasOwnProperty.call(response, "error"),
    turn,
  };
  const path = turnPath(session, env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  const { recordTool } = await import("./log.ts");
  recordTool({
    project: projectName(input),
    session,
    tool,
    summary: line.summary,
    file: firstString(toolInput, "file_path"),
    failed: line.failed,
    env,
  });
  return "";
}

interface TurnTool {
  t: string;
  tool: string;
  summary: string;
  failed: boolean;
  turn?: number;
}

function readTurnQueue(session: string, env: NodeJS.ProcessEnv): TurnTool[] {
  try {
    return readFileSync(turnPath(session, env), "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const item = record(JSON.parse(line));
        if (typeof item.tool !== "string" || typeof item.summary !== "string") return [];
        return [{
          t: typeof item.t === "string" ? item.t : "",
          tool: item.tool,
          summary: item.summary,
          failed: item.failed === true,
          ...(typeof item.turn === "number" ? { turn: item.turn } : {}),
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function retainTurn(
  input: Record<string, unknown>, session: string, env: NodeJS.ProcessEnv, state: HookState,
  deps?: MemoryDeps,
): Promise<void> {
  const answer = firstString(input, "last_assistant_message", "lastAssistantMessage");
  const tools = readTurnQueue(session, env).filter((item) => item.turn === undefined || item.turn === state.turns);
  const prompt = state.turnPrompt || "(prompt inconnu)";
  state.turnPrompt = "";
  if (answer === undefined || answer.length < 40) {
    resetTurnQueue(session, env);
    return;
  }
  const project = projectName(input);
  const failures = tools.filter((item) => item.failed);
  const ordered = [...failures, ...tools.filter((item) => !item.failed)].slice(0, 20);
  const content = [
    `OPÉRATEUR : ${prompt}`,
    `OUTILS : ${tools.length} appels, ${failures.length} échecs`,
    ...ordered.map((item) => `- ${item.tool} ${item.summary}`),
    `KIBA : ${answer.slice(0, 4000)}`,
  ].join("\n");
  const cwd = firstString(input, "cwd") || process.cwd();
  const scan = inspectSecrets(content);
  if (!scan.ok) {
    logMemoryFailure("stop", new Error(`secret: rejected chunk (${scan.kinds.join(",")})`), env);
    resetTurnQueue(session, env);
    return;
  }
  const item: RetainItem = {
    content: scan.text,
    context: "claude-code turn",
    timestamp: new Date().toISOString(),
    document_id: `session:${session}`,
    update_mode: "append",
    tags: [`project:${project}`, "harness:claude"],
    metadata: { cwd, session },
  };
  try {
    const client = await memoryDeps(deps, env);
    const config = client.config();
    if (config.retain === false) return;
    const result = await client.retain(config, [item], { bank: `${config.bank}-${project}`, async: true });
    resultValue(result);
  } catch (error) {
    logMemoryFailure("stop", error, env, [prompt, answer]);
  } finally {
    resetTurnQueue(session, env);
  }
}

async function handle(event: HookEvent, harness: Harness, input: Record<string, unknown>, env: NodeJS.ProcessEnv, state: HookState, session: string | null, hooks: HookPolicy): Promise<string> {
  if (event === "pre-bash") return preBash(harness, input, state, env, hooks);
  if (event === "post-edit") return postEdit(harness, input, state, hooks);
  if (event === "prompt-submit") {
    state.editFiles = [];
    state.editLines = 0;
    state.editNudged = false;
    return "";
  }
  return stop(input, session, env, state, hooks);
}

function transcriptPath(input: Record<string, unknown>): string | null {
  const path = firstString(input, "transcript_path", "transcriptPath");
  return path && path.trim() ? path : null;
}

export async function runHook(
  event: HookEvent,
  harness: Harness,
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps?: MemoryDeps,
): Promise<string> {
  try {
    // Kiba runs on Claude only: a leftover Codex or Grok lead hook does nothing.
    if (env.ORCH_LEAD !== "1" || harness !== "claude") return "";
    const normalized = record(input);
    // Async subagent hooks only append evidence. No memory, lane import,
    // wake or session-state rewrite belongs on this lightweight path.
    if (event === "subagent-start" || event === "subagent-stop") {
      const session = sessionKey(normalized, { ...env, ORCH_SESSION: firstString(normalized, "session_id", "sessionId") || env.ORCH_SESSION });
      const agent = firstString(normalized, "agent_id");
      if (!session || !agent) return "";
      const dir = join(stateRoot(env), "subagents");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${session}.jsonl`), JSON.stringify({
        event, session, agent_id: agent, agent_type: firstString(normalized, "agent_type") ?? "",
        transcript_path: firstString(normalized, "agent_transcript_path", "transcript_path") ?? "",
        last_assistant_message: (firstString(normalized, "last_assistant_message") ?? "").slice(0, 300),
        at: new Date().toISOString(), cwd: firstString(normalized, "cwd") || process.cwd(),
        lead_pid: Number(env.ORCH_LEAD_PID) || null,
      }) + "\n");
      return "";
    }
    const hooks = loadHookPolicy(env);
    const session = sessionKey(normalized, env);
    const path = session ? statePath(session, env) : null;
    const state = path ? readState(path) : emptyState();
    // ORCH_MEMORY=off: the lead hooks without the living memory (the memory
    // bench runs the lead as before Hindsight this way); every other hook stays.
    const memoryOff = env.ORCH_MEMORY === "off";
    let output: string;
    if (event === "session-start") {
      output = await sessionStart(normalized, session, env, state, deps);
    } else if (event === "post-tool") {
      // One PostToolUse process per call (src/install/render.ts): the turn log
      // for every tool; Edit|Write, the synchronous entry, also counts the edits
      // and nudges. The background entry (every other tool) never writes the
      // state file: its stale copy, saved after a synchronous Edit, would lose
      // that count.
      // The turn log is best effort: a failed append never costs the edit
      // count and its nudge (Codex review, 2026-11-03).
      try { await postTool(normalized, session, env, state.turns); } catch { /* fail-open */ }
      if (!["Edit", "Write"].includes(toolName(normalized))) return "";
      output = postEdit(harness, normalized, state, hooks);
    } else if (event === "prompt-submit") {
      state.editFiles = [];
      state.editLines = 0;
      state.editNudged = false;
      const prompt = string(normalized.prompt);
      state.turnPrompt = prompt?.slice(0, 2000) ?? "";
      state.turns += 1;
      const extras: string[] = [];
      const { contextTooLarge, freshSessionNudge, requestFreshSession, writeResumeNote } = await journal();
      const size = contextTooLarge(normalized, env);
      if (size.large && hooks.behaviors["nudge.fresh-session"] === "on") {
        if (!state.handoffWritten) {
          try {
            writeResumeNote({
              cwd: firstString(normalized, "cwd") || process.cwd(),
              project: projectName(normalized),
              env,
              session,
              input: normalized,
            });
            requestFreshSession(env.ORCH_STATE || stateDir(), size);
            state.handoffWritten = true;
          } catch { /* fail-open */ }
        }
        if (!state.freshNudged) {
          state.freshNudged = true;
          extras.push(freshSessionNudge(size));
        }
      }
      if (!memoryOff && !(await policy()).pauseReason(env) && prompt !== undefined && prompt.length >= 12 && !prompt.startsWith("/")) {
        const project = projectName(normalized);
        const recall = await recallMemory("prompt-submit", prompt, null, project, env, deps, state, [prompt]);
        if (recall) extras.push(`Souvenirs :\n${recall}`);
      }
      try {
        const bus = await freshBusDigest(normalized, env, state);
        if (bus) extras.push(bus);
      } catch {}
      output = extras.length
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extras.join("\n\n") } })
        : "";
    } else if (event === "stop" || event === "session-end") {
      try { output = event === "stop" ? await stop(normalized, session, env, state, hooks) : ""; } catch { output = ""; }
      let blocked = false;
      try { blocked = record(JSON.parse(output)).decision === "block"; } catch {}
      const spendState = env.ORCH_STATE || stateDir();
      const transcript = transcriptPath(normalized);
      const usage = transcript ? await import("../core/spend-usage.ts") : null;
      if (transcript && usage) {
        try {
          usage.ingestClaudeTranscriptUsage({
            transcriptPath: transcript,
            session: session ?? undefined,
            project: projectName(normalized),
            state: spendState,
            source: `lead:claude:${event}`,
          });
        } catch { /* fail-open */ }
      }
      if (event === "stop" && !blocked && session && !memoryOff && !(await policy()).pauseReason(env)) {
        await retainTurn(normalized, session, env, state, deps);
      }
      try {
        const project = projectName(normalized);
        const cwd = firstString(normalized, "cwd") || process.cwd();
        const { contextTooLarge, readLog, requestFreshSession, snapshotState, writeResumeNote } = await journal();
        const size = contextTooLarge(normalized, env);
        if (size.large && (event === "session-end" || !state.handoffWritten)) {
          writeResumeNote({ cwd, project, env, session, input: normalized });
          if (hooks.behaviors["nudge.fresh-session"] === "on") requestFreshSession(env.ORCH_STATE || stateDir(), size);
          state.handoffWritten = true;
        } else if (readLog(project, env).length) {
          snapshotState({ cwd, project, env, session });
        }
      } catch { /* fail-open */ }
    } else {
      output = await handle(event, harness, normalized, env, state, session, hooks);
    }
    if (path) writeState(path, state);
    if (event === "stop" || event === "prompt-submit") {
      // The atelier's busy/idle signal for this lead (src/core/lead-pulse.ts).
      try { (await import("../core/lead-pulse.ts")).writePulse(Number(env.ORCH_LEAD_PID), event === "stop" ? "idle" : "busy", env.ORCH_STATE || stateDir(), new Date(), firstString(normalized, "permission_mode", "permissionMode")); } catch {}
    }
    if (env.ORCH_BENCH_RUN && env.ORCH_MEM_SANDBOX && ["session-start", "prompt-submit"].includes(event)) {
      const directory = join(env.ORCH_STATE || stateDir(), "hooks");
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, "bench-receipts.jsonl"), JSON.stringify({ run: env.ORCH_BENCH_RUN, session, event, provider: env.ORCH_MEMORY_PROVIDER, contextBytes: Buffer.byteLength(output) }) + "\n", { mode: 0o600 });
    }
    return output;
  } catch {
    return "";
  }
}

// Entry point of every lead hook command (src/install/render.ts):
// `bun --no-env-file src/hooks/hook.ts <event> --harness <h>` reads the event
// on stdin and prints the decision. The command runs this file directly, not
// `orch hook`: the CLI's static imports cost 65 ms on every tool call, this
// graph loads in 15 ms (2026-11-03, Bun 1.4.4). `orch hook` delegates here.
export async function hookMain(args: string[]): Promise<void> {
  try {
    const [event, ...rest] = args;
    const { values } = parseArgs({ args: rest, options: { harness: { type: "string" } } });
    if (!("pre-bash prompt-submit post-edit stop session-start session-end post-tool subagent-start subagent-stop".split(" ") as string[]).includes(event) ||
      values.harness !== "claude") return; // Kiba runs on Claude only: an old Codex or Grok lead hook does nothing
    let input: unknown;
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
    const output = await runHook(event as HookEvent, values.harness as Harness, input, process.env);
    if (output) process.stdout.write(`${output}\n`);
  } catch {
    // Hook commands fail open. A malformed event or unavailable state must
    // never prevent Claude from continuing its normal work.
  }
}

if (import.meta.main) await hookMain(process.argv.slice(2));
