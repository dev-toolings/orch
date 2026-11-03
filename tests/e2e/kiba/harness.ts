// Backend fixtures only: importing this module never installs a fake or runs a test.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../../..");

export interface TempEnv {
  root: string;
  bin: string;
  env: Record<string, string>;
  cleanup(): void;
}

/** A fresh allowlisted environment, without inherited credentials or orch state. */
export function tempEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), "orch-e2e-"));
  const bin = join(root, "bin");
  const env: Record<string, string> = {
    HOME: join(root, "home"), ORCH_HOME: join(root, "home"),
    ORCH_STATE: join(root, "state"), TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    CODEX_HOME: join(root, "home", ".codex"),
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    ORCH_ENV_FILE: join(root, ".env"), ORCH_MEMORY: "off",
    ORCH_MEM_SANDBOX: join(root, "memory"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    ORCH_E2E_LIVE: process.env.ORCH_E2E_LIVE === "1" ? "1" : "0",
  };
  for (const path of [bin, env.HOME, env.ORCH_STATE, env.TMPDIR, env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.ORCH_MEM_SANDBOX]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(env.ORCH_ENV_FILE, "");
  // A forgotten fake must fail closed, never fall through to a paid executable.
  for (const name of ["claude", "codex", "grok", "gh"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${name}: install a fixture first' >&2\nexit 127\n`, { mode: 0o755 });
  }
  return { root, bin, env, cleanup() {
    const unlock = (path: string) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const entry of readdirSync(path)) unlock(join(path, entry));
    };
    if (existsSync(root)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
  } };
}

function within(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`path outside fixture: ${path}`);
  return target;
}

/** Initialize main, optionally develop, and push both to an owned bare origin. */
export function tempRepo(fixture: TempEnv, opts: { name?: string; develop?: boolean; files?: Record<string, string> } = {}) {
  const repo = within(fixture.root, opts.name ?? "repo"), origin = `${repo}.git`;
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=agent-local", "-c", "user.email=agent-local@localhost",
      "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: fixture.env, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]}: ${result.error ?? result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    const path = within(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "initial fixture");
  git("init", "-q", "--bare", "-b", "main", origin);
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
  if (opts.develop) { git("checkout", "-q", "-b", "develop"); git("push", "-q", "-u", "origin", "develop"); }
  return { repo, origin, git };
}

export interface FakeScenario {
  files?: Record<string, string>;
  result?: string;
  sessionId?: string;
  model?: string;
  costUSD?: number;
  exitCode?: number;
}

// A string is an async JavaScript body with argv, flags, prompt and write(path,
// text) in scope. It returns a FakeScenario; object scenarios need no code.
export type FakeScript = FakeScenario | string;

function executable(fixture: Pick<TempEnv, "bin">, name: string, body: string): string {
  const path = join(fixture.bin, name);
  writeFileSync(path, `#!${process.execPath} --no-env-file\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeWorker(fixture: Pick<TempEnv, "bin">, engine: "claude" | "codex", script: FakeScript) {
  return executable(fixture, engine, `
import {mkdirSync, writeFileSync, lstatSync, existsSync} from "node:fs";
import {dirname, resolve, relative, isAbsolute} from "node:path";
const engine = ${JSON.stringify(engine)}, argv = process.argv.slice(2), flags = {};
const valued = new Set(["--output-format", "--input-format", "--resume", "--session-id", "--agent", "--agents", "--settings", "--model", "--effort", "--permission-mode", "--setting-sources", "--append-system-prompt", "--mcp-config", "--max-budget-usd", "-c", "-s", "-C", "-o"]);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (valued.has(arg)) { if (argv[i + 1] === undefined) throw new Error("missing value: " + arg); flags[arg] = argv[++i]; }
  else if (arg === "-p" || arg === "--print") flags["-p"] = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
  else if (arg.startsWith("--") && arg.includes("=")) { const at = arg.indexOf("="); flags[arg.slice(0, at)] = arg.slice(at + 1); }
}
if (engine === "claude") {
  // The real CLI refuses these: the fake must not accept them either.
  if (flags["--session-id"] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(flags["--session-id"])) { console.error("Error: Invalid session ID. Must be a valid UUID."); process.exit(1); }
  if (flags["-p"] && flags["--output-format"] === "stream-json" && !argv.includes("--verbose")) { console.error("Error: When using --print, --output-format=stream-json requires --verbose"); process.exit(1); }
}
if (flags["-C"]) process.chdir(flags["-C"]);
const input = typeof flags["-p"] === "string" ? flags["-p"] : await Bun.stdin.text();
const prompt = flags["--input-format"] === "stream-json" ? input.trim().split("\\n").filter(Boolean).map(line => {
  const content = JSON.parse(line).message?.content ?? "";
  return typeof content === "string" ? content : content.map(block => block.text ?? "").join("\\n");
}).join("\\n") : input;
const write = (file, text) => {
  const path = resolve(file), rel = relative(process.cwd(), path);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("fake write outside cwd: " + file);
  for (let current = path; current !== process.cwd(); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("fake write through symlink: " + file);
  }
  mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text);
};
const scenario = ${typeof script === "string" ? `await (async () => {\n${script}\n})() ?? {}` : JSON.stringify(script)};
for (const [file, text] of Object.entries(scenario.files ?? {})) write(file, text);
const session = scenario.sessionId ?? flags["--resume"] ?? flags["--session-id"] ?? "s-e2e";
const model = scenario.model ?? flags["--model"] ?? "fake-opus";
const result = scenario.result ?? "Done.\\nLANE: done", code = scenario.exitCode ?? 0;
const emit = event => console.log(JSON.stringify(event));
if (engine === "codex") {
  if (flags["-o"]) writeFileSync(flags["-o"], result);
  emit({type:"thread.started",thread_id:session});
  emit({type:"item.completed",item:{id:"message-1",type:"agent_message",text:result}});
  emit({type:"turn.completed",usage:{input_tokens:10,cached_input_tokens:0,output_tokens:5}});
} else {
  if (flags["--output-format"] === "stream-json") {
    emit({type:"system",subtype:"init",model,session_id:session});
    emit({type:"assistant",session_id:session,message:{id:"message-1",model,role:"assistant",content:[{type:"text",text:result}],usage:{input_tokens:10,output_tokens:5}}});
  }
  emit({type:"result",subtype:code ? "error_during_execution" : "success",session_id:session,result,is_error:code !== 0,num_turns:1,
    model_usage_since_last_result:{[model]:{costUSD:scenario.costUSD ?? 0.1,inputTokens:10,outputTokens:5,cacheReadInputTokens:0,cacheCreationInputTokens:0}},
    total_cost_usd:scenario.costUSD ?? 0.1,usage:{input_tokens:10,output_tokens:5}});
}
process.exitCode = code;
`);
}

/** Live mode removes the blocker and leaves the real Claude on PATH untouched. */
export function fakeClaude(fixture: TempEnv, script: FakeScript = {}) {
  const live = fixture.env.ORCH_E2E_LIVE === "1";
  if (live) rmSync(join(fixture.bin, "claude"), { force: true });
  else fakeWorker(fixture, "claude", script);
  return { live };
}

/** Codex uses its native thread/item/turn events and honors the last-message file. */
export function fakeCodex(fixture: Pick<TempEnv, "bin">, script: FakeScript = {}) {
  return fakeWorker(fixture, "codex", script);
}

/** Persist calls and PRs across processes, including delivery reconciliation.
 * `runs` holds the failed CI runs `gh run list` returns; creating `dropCreate`
 * makes the next `pr create` record its PR but lose the response once. */
export function fakeGh(fixture: TempEnv) {
  const calls = join(fixture.root, "gh-calls.jsonl"), prs = join(fixture.root, "gh-prs.jsonl");
  const runs = join(fixture.root, "gh-runs.json"), dropCreate = join(fixture.root, "gh-drop-create-once");
  writeFileSync(calls, ""); writeFileSync(prs, ""); writeFileSync(runs, "[]");
  executable(fixture, "gh", `
import {appendFileSync, existsSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {Database} from "bun:sqlite";
const argv = process.argv.slice(2), calls = ${JSON.stringify(calls)}, records = ${JSON.stringify(prs)};
const flag = name => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
// Serialize read/append so concurrent PR creates cannot reuse a number.
const lock = new Database(${JSON.stringify(join(fixture.root, "gh-lock.sqlite"))});
lock.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
try {
  appendFileSync(calls, JSON.stringify({argv,cwd:process.cwd()}) + "\\n");
  const prs = readFileSync(records,"utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
  // --repo names the fixture's single remote: it matches every recorded project.
  const project = process.cwd(), mine = pr => flag("--repo") !== undefined || pr.project === project;
  const save = () => writeFileSync(records, prs.map(pr => JSON.stringify(pr) + "\\n").join(""));
  if (argv[0] === "repo" && argv[1] === "view") { console.log("agent-local/repo"); process.exit(0); }
  if (argv[0] === "run" && argv[1] === "list") { console.log(readFileSync(${JSON.stringify(runs)},"utf8")); process.exit(0); }
  if (argv[0] !== "pr") throw new Error("unsupported fake gh command");
  const output = pr => {
    const fields = flag("--json");
    return fields ? Object.fromEntries(fields.split(",").map(key => [key,pr[key]])) : pr;
  };
  if (argv[1] === "create") {
    const number = prs.length + 1;
    const pr = {number,url:"https://github.example/agent-local/repo/pull/" + number,state:"OPEN",project,
      headRefName:flag("--head"),baseRefName:flag("--base"),title:flag("--title"),
      body:flag("--body-file") ? readFileSync(flag("--body-file"),"utf8") : flag("--body") ?? ""};
    appendFileSync(records,JSON.stringify(pr) + "\\n");
    // The PR exists, its acknowledgement is lost once.
    if (existsSync(${JSON.stringify(dropCreate)})) { rmSync(${JSON.stringify(dropCreate)}); process.exitCode = 1; }
    else console.log(pr.url);
  } else if (argv[1] === "list") {
    const state = flag("--state") ?? "open";
    const found = prs.filter(pr => mine(pr) && (!flag("--head") || pr.headRefName === flag("--head")) &&
      (!flag("--base") || pr.baseRefName === flag("--base")) && (state === "all" || pr.state.toLowerCase() === state));
    console.log(JSON.stringify(found.slice(0, Number(flag("--limit") ?? 30)).map(output)));
  } else if (argv[1] === "view") {
    const id = argv[2] && !argv[2].startsWith("-") ? argv[2] : spawnSync("git", ["branch", "--show-current"], {encoding:"utf8"}).stdout.trim();
    const pr = prs.find(pr => mine(pr) && [String(pr.number),pr.url,pr.headRefName].includes(id));
    if (!pr) throw new Error("PR not found");
    console.log(JSON.stringify(output({comments:[],...pr})));
  } else if (argv[1] === "comment") {
    const pr = prs.find(pr => mine(pr) && [String(pr.number),pr.url,pr.headRefName].includes(argv[2]));
    if (!pr) throw new Error("PR not found");
    const url = pr.url + "#issuecomment-" + ((pr.comments ?? []).length + 1);
    pr.comments = [...(pr.comments ?? []), {body:flag("--body") ?? "",url}]; save(); console.log(url);
  } else throw new Error("unsupported fake gh pr command");
} finally { lock.exec("COMMIT"); lock.close(); }
`);
  return { calls, prs, runs, dropCreate };
}

/** Recorded PRs of a fake gh. */
export const readPrs = (path: string): any[] => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Local memory endpoint; every retain is rejected unless explicitly enabled. */
export function fakeHindsight(opts: { allowRetain?: boolean } = {}) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const banks = new Set<string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, text = await req.text();
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: req.method, path, body });
    if (req.method === "GET" && path === "/health") return Response.json({ status: "ok" });
    if (req.method === "GET" && path === "/v1/default/banks") return Response.json({ banks: [...banks].map(bank_id => ({ bank_id })) });
    const match = /^\/v1\/default\/banks\/([^/]+)(.*)$/.exec(path);
    if (!match) return new Response("unknown endpoint", { status: 404 });
    const [, bank, endpoint] = match;
    if (!endpoint && req.method === "PUT") { banks.add(bank); return Response.json({ bank_id: bank }); }
    if (!endpoint && req.method === "DELETE") { banks.delete(bank); return Response.json({ success: true }); }
    if (endpoint === "/memories/recall" && req.method === "POST") return Response.json({ results: [] });
    if (endpoint === "/memories" && req.method === "POST") {
      return opts.allowRetain ? Response.json({ items_count: body?.items?.length ?? 0 }) : new Response("retain disabled by fixture", { status: 403 });
    }
    if (endpoint === "/stats" && req.method === "GET") return Response.json({ total_nodes: 0, total_documents: 0, pending_operations: 0 });
    if (endpoint === "/llm-requests/stats" && req.method === "GET") return Response.json({ buckets: [] });
    return new Response("unknown endpoint", { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, requests, cleanup: () => server.stop(true) };
}

export interface RunOptions { cwd?: string; stdin?: string; timeoutMs?: number }

/** Drain both pipes while waiting; kill the owned process group on timeout. */
export async function runCommand(fixture: TempEnv, argv: string[], opts: RunOptions = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd ?? fixture.root, env: fixture.env, detached: true, stdio: "pipe" });
    let timedOut = false, stdout = "", stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, opts.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", status => {
      clearTimeout(timer); resolve({ status: timedOut ? 124 : status ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") { child.kill("SIGKILL"); reject(error); } });
    child.stdin.end(opts.stdin ?? "");
  });
}

export const runOrch = (fixture: TempEnv, args: string[], opts?: RunOptions) =>
  runCommand(fixture, [process.execPath, "--no-env-file", join(sourceRoot, "src/orch.ts"), ...args], opts);
export const runLane = (fixture: TempEnv, args: string[], opts?: RunOptions) =>
  runCommand(fixture, [process.execPath, "--no-env-file", join(sourceRoot, "src/lane.ts"), ...args], opts);
