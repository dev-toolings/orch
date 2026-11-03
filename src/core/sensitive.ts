// Classify lead actions for hook-policy. Worker and gate path protections
// remain independent of that cooperative operator configuration.
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.ts";
import type { HookGuard } from "./hook-policy.ts";

export const PROTECTED_PATHS = [
  ".github/",
  ".claude/",
  ".grok/",
  ".git/hooks/",
  ".git/config",
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
  "orch.yaml",
  "catalog/policy.yaml",
  "catalog/lead.md",
] as const;

// Orch permission machinery, configurable for leads through hook-policy.
export const ORCH_GUARD_PATHS = [
  "src/hooks/hook.ts",
  "src/core/sensitive.ts",
  "src/core/hook-policy.ts",
  "src/install/render.ts",
  "catalog/policy.yaml",
  ".claude/orch/lead-settings.json",
  ".claude/settings.json",
  ".grok/hooks/orch.json",
] as const;

const ENV_TEMPLATES = new Set([
  ".env.example", ".env.dist", ".env.sample", ".env.template", ".env.dev", ".env.test",
]);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|md|json|ya?ml|toml)$/i;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|md)$/i;
const PRIVATE_KEY = /^(?:.+\.pem|.+\.key|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*)$/i;
const SECRET_DIR = /(^|\/)(?:\.ssh|\.aws|bus-keys)(?:\/|$)/;
const CREDENTIAL_BASENAME = /^(?:credentials(?:\..+)?|(?:.+\.)?tokens?(?:\..+)?|\.netrc|\.npmrc)$/i;
const SECRET_VAR = /(?:^|_)(?:KEY|TOKEN)S?$|SECRET/i;
const ORCH_GUARD_IN_CMD = /(?:lead-settings\.json|catalog\/policy\.yaml|src\/hooks\/hook\.ts|src\/core\/(?:sensitive|hook-policy)\.ts|src\/install\/render\.ts|\.claude\/orch\/|\.grok\/hooks\/orch\.json)/;
const WRITE_TOOLS = /\b(sed|awk|perl|python|node|tee|cp|mv|install|chmod|rm)\b/;
const GREP_LIKE = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const GREP_ARG_FLAGS = new Set([
  "-e", "-f", "-m", "-A", "-B", "-C", "-D", "-d",
  "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context",
]);
const WRAPPERS = new Set(["command", "exec", "time", "nice", "nohup"]);

// The checkout Claude is editing (worktree), not the main-repo folder name.
const rootCache = new Map<string, string>();
export function checkoutRoot(cwd = process.cwd()): string {
  const key = resolve(cwd);
  const hit = rootCache.get(key);
  if (hit) return hit;
  const top = git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel");
  const root = top.ok && top.out ? top.out : key;
  rootCache.set(key, root);
  return root;
}

function realOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function homeDir(): string {
  return (process.env.HOME ?? homedir()).replace(/\\/g, "/");
}

export function normalizeRepoPath(file: string, cwd = process.cwd()): string {
  const raw = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const root = realOrResolve(checkoutRoot(cwd));
  const abs = isAbsolute(raw) ? raw : join(resolve(cwd), raw);
  const rel = relative(root, realOrResolve(abs)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return raw;
  return rel;
}

export function protectedPath(file: string, cwd = process.cwd()): boolean {
  const n = normalizeRepoPath(file, cwd);
  return PROTECTED_PATHS.some((p) => p.endsWith("/") ? n === p.slice(0, -1) || n.startsWith(p) : n === p);
}

export function orchGuardPath(file: string, cwd = process.cwd()): boolean {
  const n = normalizeRepoPath(file, cwd).replace(/\\/g, "/");
  const abs = (isAbsolute(file) ? file : join(resolve(cwd), file)).replace(/\\/g, "/");
  return ORCH_GUARD_PATHS.some((p) => n === p || n.endsWith(`/${p}`) || abs.endsWith(`/${p}`));
}

function expandHome(path: string, home = homeDir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  if (path.startsWith("$HOME/")) return `${home}/${path.slice(6)}`;
  if (path.startsWith("${HOME}/")) return `${home}/${path.slice(8)}`;
  return path;
}

function envName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

function gitTracked(file: string, cwd: string, cache: Map<string, boolean>): boolean {
  const root = checkoutRoot(cwd);
  const rel = normalizeRepoPath(file, cwd);
  const key = `${root}\0${rel}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ok = git(root, "ls-files", "--error-unmatch", "--", rel).ok;
  cache.set(key, ok);
  return ok;
}

function credentialStore(abs: string, name: string): string | null {
  const n = abs.replace(/\\/g, "/");
  const home = homeDir();
  if (n === `${home}/.ssh` || n.startsWith(`${home}/.ssh/`)) return "ssh path";
  if (n === `${home}/.aws` || n.startsWith(`${home}/.aws/`)) return "credential store";
  if (n.startsWith(`${home}/.claude/.credentials`)) return "credential store";
  if (n === `${home}/.codex/auth.json` || n === `${home}/.codex/oauth.json` || n === `${home}/.codex/session.json`) {
    return "credential store";
  }
  if (n === `${home}/.grok/auth` || n === `${home}/.grok/auth.json` || n.startsWith(`${home}/.grok/auth.`)) {
    return "credential store";
  }
  if (/(?:^|\/)\.netrc$/.test(n) || /(?:^|\/)\.npmrc$/.test(n)) return "credential store";
  if (SECRET_DIR.test(n)) return n.includes(".ssh") ? "ssh path" : "credential store";
  // Only code and docs named credentials.* are exempt: credentials.json,
  // .yaml and .toml are real stores (the former static deny covered them).
  if (/^credentials(?:\..+)?$/i.test(name) && !CODE_EXT.test(name)) return "credential store";
  if (CREDENTIAL_BASENAME.test(name) && !SOURCE_EXT.test(name) && name !== ".netrc" && name !== ".npmrc") {
    return "token file";
  }
  return null;
}

function classifyPath(file: string, cwd: string, cache: Map<string, boolean>, display = file): string | null {
  const expanded = expandHome(file);
  const abs = (isAbsolute(expanded) ? expanded : resolve(cwd, expanded)).replace(/\\/g, "/");
  const name = basename(expanded.replace(/\\/g, "/"));
  if (PRIVATE_KEY.test(name)) return `orch: denied ${display} (private key)`;
  const store = credentialStore(abs, name);
  if (store) return `orch: denied ${display} (${store})`;
  if (envName(name)) {
    if (ENV_TEMPLATES.has(name) || gitTracked(expanded, cwd, cache)) return null;
    return `orch: denied ${display} (untracked env file, may hold secrets)`;
  }
  return null;
}

export function secretPath(file: string, cwd = process.cwd()): boolean {
  return classifyPath(file, cwd, new Map()) !== null;
}

export function isTestPath(file: string): boolean {
  const n = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return /(^|\/)(tests|test|__tests__|checks)\//.test(n) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(n);
}

type Tok = { kind: "word" | "op"; value: string };

function tokenize(command: string): Tok[] {
  const tokens: Tok[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (value) tokens.push({ kind: "word", value });
    value = "";
  };
  const ops = ["&&", "||", "|&", ">>", "<<", "|", "&", ";", "(", ")", "<", ">"];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) value += command[++i];
      else value += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\" && i + 1 < command.length) { value += command[++i]; continue; }
    if (c === "#" && value === "") {
      while (i < command.length && command[i] !== "\n") i++;
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

function commandName(word: string): string {
  return (word.split("/").pop() ?? word).toLowerCase();
}

function stripWrappers(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; continue; }
    const name = commandName(words[i]);
    if (WRAPPERS.has(name)) { i++; continue; }
    if (name === "env") {
      const rest = words.slice(i + 1);
      if (!rest.some((w) => !w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) return words.slice(i);
      i++;
      while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
      continue;
    }
    return words.slice(i);
  }
  return [];
}

function flagTakesArg(flag: string): boolean {
  if (GREP_ARG_FLAGS.has(flag)) return true;
  if (flag.startsWith("--") && flag.includes("=")) return false;
  return /^-[^-].*[efmABC]$/.test(flag);
}

function fileArgs(words: string[]): string[] {
  const stripped = stripWrappers(words);
  if (!stripped.length) return [];
  const cmd = commandName(stripped[0]);
  const args = stripped.slice(1);
  if (cmd === "cd" || cmd === "printenv" || cmd === "env") return [];
  const files: string[] = [];
  let i = 0;
  let seenPattern = !GREP_LIKE.has(cmd);
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      i++;
      if (!seenPattern && i < args.length) { seenPattern = true; i++; }
      files.push(...args.slice(i));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (eq === -1 && flagTakesArg(flag)) {
        if (GREP_LIKE.has(cmd) && (flag === "-e" || flag === "-f" || flag === "--regexp" || flag === "--file")) seenPattern = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (!seenPattern) { seenPattern = true; i++; continue; }
    files.push(a);
    i++;
  }
  return files;
}

function expandGlob(cwd: string, pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return [pattern];
  try {
    const expanded = expandHome(pattern);
    const hits = [...new Bun.Glob(expanded).scanSync({ cwd, dot: true, onlyFiles: false })];
    return hits.length ? hits : [pattern];
  } catch {
    return [pattern];
  }
}

function envDumpReason(words: string[]): string | null {
  const stripped = stripWrappers(words);
  const cmd = commandName(stripped[0] ?? "");
  if (cmd === "printenv") {
    const vars = stripped.slice(1).filter((w) => !w.startsWith("-"));
    if (!vars.length) return "orch: denied printenv (env dump of secret variables)";
    const secret = vars.find((name) => SECRET_VAR.test(name));
    return secret ? `orch: denied printenv ${secret} (env dump of secret variable)` : null;
  }
  if (cmd === "env") {
    const rest = stripped.slice(1);
    if (!rest.some((w) => !w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
      return "orch: denied env (env dump of secret variables)";
    }
  }
  return null;
}

function stageWords(stage: Tok[]): { words: string[]; redirected: Array<{ path: string; edit: boolean }> } {
  const words: string[] = [];
  const redirected: Array<{ path: string; edit: boolean }> = [];
  for (let i = 0; i < stage.length; i++) {
    const tok = stage[i];
    if (tok.kind === "op" && /^[<>]/.test(tok.value)) {
      const next = stage[i + 1];
      if (next?.kind === "word") { redirected.push({ path: next.value, edit: tok.value.startsWith(">") }); i++; }
      continue;
    }
    if (tok.kind === "word") words.push(tok.value);
  }
  return { words, redirected };
}

export function commandDenyGuards(command: string, cwd = process.cwd()): HookGuard[] {
  const guards: HookGuard[] = [];
  const c = command.trim();
  if (!c) return guards;
  const cache = new Map<string, boolean>();
  const tokens = tokenize(c);
  let dir = resolve(cwd);
  let stage: Tok[] = [];
  const flush = (): void => {
    if (!stage.length) return;
    const { words, redirected } = stageWords(stage);
    stage = [];
    if (!words.length && !redirected.length) return;
    const stripped = stripWrappers(words);
    const cmd = commandName(stripped[0] ?? "");
    if (cmd === "cd") {
      const dest = stripped[1];
      dir = dest ? resolve(dir, expandHome(dest)) : homeDir();
      return;
    }
    const dump = envDumpReason(words);
    if (dump) guards.push({ id: "secrets.read", reason: dump });
    const files = fileArgs(words);
    // awk, perl and sed only edit in place with -i; a plain run reads.
    const inPlace = stripped.some((word) => word === "-i" || word.startsWith("-i") || word.startsWith("--in-place") || word === "inplace");
    const editing = WRITE_TOOLS.test(cmd) && !(["sed", "awk", "gawk", "perl"].includes(cmd) && !inPlace);
    // An in-place editor (sed/awk/perl -i) reads the file it rewrites; a pure
    // write (redirect, cp target, tee) does not.
    const paths = files.map((path, index) => ({ path, edit: editing && (cmd !== "cp" || index === files.length - 1), reads: !editing || (inPlace && ["sed", "awk", "gawk", "perl"].includes(cmd)) }));
    for (const { path: raw, edit, reads = !edit } of [...paths, ...redirected] as { path: string; edit: boolean; reads?: boolean }[]) {
      for (const path of expandGlob(dir, raw)) {
        const denied = classifyPath(path, dir, cache, path === raw ? raw : path);
        // Each operation brings its own guard; when both apply, the stricter wins.
        if (denied) {
          if (reads) guards.push({ id: "secrets.read", reason: denied });
          if (edit) guards.push({ id: "secrets.edit", reason: denied });
        }
      }
    }
  };
  for (const token of tokens) {
    if (token.kind === "op" && [";", "&&", "||", "&", "|", "|&", "(", ")"].includes(token.value)) {
      flush();
    } else stage.push(token);
  }
  flush();
  if (ORCH_GUARD_IN_CMD.test(c) && WRITE_TOOLS.test(c)) guards.push({ id: "orch.guard-files", reason: "editing an orch guard file is denied" });
  return guards;
}

// Compatibility classifiers keep their historical result for non-policy callers.
export function denyCommandReason(command: string, cwd = process.cwd()): string | null {
  return commandDenyGuards(command, cwd)[0]?.reason ?? null;
}

export function pathDenyGuards(file: string, cwd = process.cwd(), kind: "read" | "edit" = "edit"): HookGuard[] {
  const guards: HookGuard[] = [];
  const denied = classifyPath(file, cwd, new Map());
  if (denied) guards.push({ id: kind === "read" ? "secrets.read" : "secrets.edit", reason: denied });
  if (kind === "edit" && orchGuardPath(file, cwd)) guards.push({ id: "orch.guard-files", reason: `editing ${file} is denied (orch guard)` });
  return guards;
}

export function denyPathReason(file: string, cwd = process.cwd(), kind: "read" | "edit" = "edit"): string | null {
  return pathDenyGuards(file, cwd, kind)[0]?.reason ?? null;
}

export function sensitiveCommandGuards(command: string): HookGuard[] {
  const guards: HookGuard[] = [];
  const c = command.trim();
  if (!c) return guards;
  if (/\bgit\s+push\b/.test(c)) guards.push({ id: "git.push", reason: "git push needs approval" });
  if (/\b(curl|wget|nc|ncat|ssh|scp|sftp)\b/.test(c)) guards.push({ id: "net.calls", reason: "network call needs approval" });
  if (/\brm\b/.test(c) && /(^|[\s=])(\/|\.\.\/|~\/)/.test(c)) guards.push({ id: "rm.outside", reason: "rm outside the worktree needs approval" });
  if (/\brm\b/.test(c) && /(^|\s)(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/.test(c)) guards.push({ id: "rm.recursive", reason: "recursive rm needs approval" });
  if (/\bgit\s+config\b/.test(c) && /\bhooksPath\b/.test(c)) guards.push({ id: "git.hooks-path", reason: "changing git hooks needs approval" });
  if (/\b(package\.json|orch\.yaml|CLAUDE\.md|AGENTS\.md|\.github\/|\.claude\/)\b/.test(c)
    && WRITE_TOOLS.test(c)) {
    guards.push({ id: "guardrail.files", reason: "editing a guardrail file needs approval" });
  }
  return guards;
}

export function sensitiveCommandReason(command: string): string | null {
  return sensitiveCommandGuards(command)[0]?.reason ?? null;
}

export function askDecision(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  });
}

export function denyDecision(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}
