import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { listLanes, type LaneState } from "../lane.ts";
import type { Harness } from "../core/profile.ts";

export type HookEvent = "pre-bash" | "post-edit" | "prompt-submit" | "stop";

interface HookState {
  preBashNudged: boolean;
  editFiles: string[];
  editLines: number;
  editNudged: boolean;
  blockedLaneSets: string[][];
}

interface Token {
  kind: "word" | "op";
  value: string;
}

const emptyState = (): HookState => ({
  preBashNudged: false,
  editFiles: [],
  editLines: 0,
  editNudged: false,
  blockedLaneSets: [],
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

function shellTokens(command: string): Token[] {
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
      if (c === quote) quote = null;
      else if (c === "\\" && quote !== "'" && i + 1 < command.length) value += command[++i];
      else value += c;
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
  return name === "grok" && !args.includes("--trust") && has("-p", "--prompt", "--prompt-file");
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

function preBash(harness: Harness, input: Record<string, unknown>, state: HookState): string {
  const name = toolName(input);
  if (name !== "Bash" && !(harness === "grok" && name === "run_terminal_command")) return "";
  const toolInput = words(input);
  const command = string(toolInput.command);
  if (command === undefined || !shouldRewrite(command)) return "";
  const updatedInput = { ...toolInput, command: `{\n${command}\n} < /dev/null` };
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    updatedInput,
  };
  // Codex applies updatedInput only with an explicit allow (its hooks doc); Claude
  // and Grok apply it alone, and an allow there would skip their permission flow.
  if (harness === "codex") hookSpecificOutput.permissionDecision = "allow";
  if (!state.preBashNudged) {
    hookSpecificOutput.additionalContext = PRE_BASH_CONTEXT;
    state.preBashNudged = true;
  }
  return JSON.stringify({ hookSpecificOutput });
}

function pathValue(input: Record<string, unknown>): string | undefined {
  return firstString(input, "file_path", "filePath", "path", "filename", "target_notebook");
}

function patchCounts(toolInput: Record<string, unknown>): { files: string[]; lines: number } {
  const patch = typeof toolInput === "string" ? toolInput : firstString(toolInput, "patch", "input", "diff", "command") ?? "";
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)].map((m) => m[1]);
  const changed = patch.split(/\r\n|\r|\n/).filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- "))).length;
  const fallbackPath = pathValue(record(toolInput));
  return { files: files.length ? [...new Set(files)] : fallbackPath ? [fallbackPath] : [], lines: changed };
}

function editCounts(harness: Harness, name: string, toolInput: Record<string, unknown>): { files: string[]; lines: number } {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  if (harness === "codex" && (normalized === "applypatch" || normalized === "patch")) return patchCounts(toolInput);

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

function postEdit(harness: Harness, input: Record<string, unknown>, state: HookState): string {
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

function lanesForSession(session: string, env: NodeJS.ProcessEnv): LaneState[] {
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

function stop(input: Record<string, unknown>, session: string | null, env: NodeJS.ProcessEnv, state: HookState): string {
  if (firstValue(input, "stop_hook_active", "stopHookActive") === true || !session) return "";
  const lanes = lanesForSession(session, env);
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

function handle(event: HookEvent, harness: Harness, input: Record<string, unknown>, env: NodeJS.ProcessEnv, state: HookState, session: string | null): string {
  if (event === "pre-bash") return preBash(harness, input, state);
  if (event === "post-edit") return postEdit(harness, input, state);
  if (event === "prompt-submit") {
    state.editFiles = [];
    state.editLines = 0;
    state.editNudged = false;
    return "";
  }
  return stop(input, session, env, state);
}

export async function runHook(event: HookEvent, harness: Harness, input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    if (env.ORCH_LEAD !== "1") return "";
    if (!["pre-bash", "post-edit", "prompt-submit", "stop"].includes(event)) return "";
    if (!["claude", "codex", "grok"].includes(harness)) return "";
    const normalized = record(input);
    const session = sessionKey(normalized, env);
    const path = session ? statePath(session, env) : null;
    const state = path ? readState(path) : emptyState();
    const output = handle(event, harness, normalized, env, state, session);
    if (path) writeState(path, state);
    return output;
  } catch {
    return "";
  }
}
