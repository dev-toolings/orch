#!/usr/bin/env bun
// Billable token benchmark: run it only on the operator's request.
// The same read-only code questions in Claude Code, Codex and Grok, in four
// arms: base (shell only), ctx (ctx CLI first), rtk (rtk filters the shell
// output: native hook for Claude and Codex, an instruction for Grok) and
// ctxrtk (both). Each answer is scored on facts checked against the repository.
//
// Setup (once): clone the repositories to BENCH_REPOS (orch, ctx) and run
// `ctx index .` in each; install rtk-oss and point BENCH_RTK_BIN at a directory
// holding an `rtk` wrapper; build two throwaway CODEX_HOME dirs (codex-base,
// codex-rtk with rtk's hooks.json) under BENCH_HOMES, plus
// claude-rtk-settings.json (rtk's PreToolUse hook). The ctxhook arm (Claude and
// Codex only) needs claude-ctxhook-settings.json and a codex-ctxhook CODEX_HOME
// whose hooks.json runs `ctx hook rewrite --harness <h>`. BENCH_CTX_BIN puts a
// ctx build first on PATH in every arm.
// Usage: bun scripts/token-bench.ts [outDir]
// Env: BENCH_H=claude,codex,grok BENCH_ARMS=base,ctx,rtk,ctxrtk,full BENCH_Q=o1,c1 (e2,e3: edit tasks)
//      BENCH_REPS=5 BENCH_PAR=6 BENCH_SEED=1 BENCH_SPECS=<dir with the edit specs>
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPOS = process.env.BENCH_REPOS ?? "/tmp/tokbench/repos";
const HOMES = process.env.BENCH_HOMES ?? "/tmp/tokbench/h";
const RTK_BIN = process.env.BENCH_RTK_BIN ?? "/tmp/tokbench/rtkbin";
const MODELS = { claude: "sonnet", codex: "gpt-6-luna", grok: "grok-4.7-build-fast" } as const;
type H = keyof typeof MODELS;
// full: the operator's real config (MCP servers, skills, CODEX_HOME), floor only.
const ARMS = ["base", "ctx", "rtk", "ctxrtk", "ctxhook", "full"] as const;
const CTX_BIN = process.env.BENCH_CTX_BIN;
type Arm = (typeof ARMS)[number];

type Q = { id: string; repo: string; text: string; facts: RegExp[]; edit?: { spec: string; base: string; verify: string; gold: [string, string] } };
export const QUESTIONS: Q[] = [
  { id: "floor", repo: "orch", text: "Reply with the single word OK. Do not read or run anything.", facts: [/\bOK\b/] },
  { id: "o1", repo: "orch", text: "When does `lane integrate` refuse to integrate a lane? List every condition it checks and name the function that implements the gate.",
    facts: [/verif/i, /inScope|\bFILES\b|scope/, /\bship\b/, /\bmain\b|master|default branch|protected branch/] },
  { id: "o2", repo: "orch", text: "Where is the lane integration lock implemented, which system call provides it, how is errno read on Linux and on macOS, and what is the default wait before giving up?",
    facts: [/lanes\/lock\.ts/, /\bflock\b/, /__errno_location[\s\S]*__error|__error[\s\S]*__errno_location/, /60[_ ,.]?000|60 ?s|60 seconds/] },
  { id: "o3", repo: "orch", text: "What are the default values of self_max_files, min_samples, cost_min_samples and cost_floor in lane routing? Answer as name=value.",
    facts: [/self_max_files\W{0,6}2\b/, /(?<!cost_)min_samples\W{0,6}5\b/, /cost_min_samples\W{0,6}10\b/, /cost_floor\W{0,6}0?\.7\b/] },
  { id: "o4", repo: "orch", text: "Which environment variables does a lane worker inherit from the lead, and which extra variables are allowed or forbidden? Name the function.",
    facts: [/PATH[\s\S]{0,200}HOME|HOME[\s\S]{0,200}PATH/, /XDG_/, /LANE_/, /workerEnv/] },
  { id: "c1", repo: "ctx", text: "Which SQLite FTS5 virtual tables does ctx create, and in which source file?",
    facts: [/files_fts/, /symbols_fts/, /content_fts/, /db\.rs/] },
  { id: "c2", repo: "ctx", text: "What file size limits does ctx apply when indexing (symbol parsing vs the text index)? Give the constant names, their values and where they are declared and used.",
    facts: [/1[_ ,.]?048[_ ,.]?576|1 ?MiB|1 ?MB/, /64 ?Mi?B|64 \* 1024 \* 1024/, /config\.rs/, /indexer\.rs/] },
  { id: "c3", repo: "ctx", text: "How does ctx avoid filling the disk while indexing? Name the threshold constant, its default value and the function that checks it.",
    facts: [/DEFAULT_INDEX_MIN_FREE_BYTES|min_free_bytes/, /512/, /check_disk_floor/, /indexer\.rs/] },
  { id: "e2", repo: "orch", text: "", facts: [], edit: { spec: "t2-docsize.md", base: "a28b472", verify: "bun test tests/docs.test.ts && bunx tsc --noEmit", gold: ["689332d", "tests/docs.test.ts"] } },
  { id: "e3", repo: "orch", text: "", facts: [], edit: { spec: "t3-next.md", base: "a28b472", verify: "bun test tests/route.test.ts && bunx tsc --noEmit", gold: ["9a061af", "tests/route.test.ts"] } },
  { id: "c4", repo: "ctx", text: "List every call site of the function `pack_query` (file and caller context).",
    facts: [/briefing\.rs/, /mcp\.rs/, /runner\.rs/, /main\.rs/] },
];

const CTX_HINT = `\n\nA ctx index of this repository is ready. Locate code with the ctx CLI first: \`ctx search '<text>' --mode literal|symbol|regex\`, \`ctx graph --op callers|definitions --symbol <name>\`, \`ctx pack '<question>'\`, \`ctx read <file> --lines A:B|--symbol <name>|--outline\`; then read only the lines you need.`;
const RTK_HINT = "\n\nPrefix shell commands with `rtk` (for example `rtk grep`, `rtk read`, `rtk git log`): it condenses their output.";
const SPECS = process.env.BENCH_SPECS ?? "/tmp/orch-bench/specs";
const EDIT_FRAME = "Implement this spec in the repository in the current directory. Touch only the files it lists. Run its VERIFY command before you finish and fix what fails. Do not commit.\n\n";
const FRAME = "Answer this question about the repository in the current directory. Read-only: do not modify files. Cite file paths. Be concise.\n\nQuestion: ";

type Row = { h: H; arm: Arm; q: string; rep: number; warm: boolean; ok: boolean; verify: boolean | null; gold: string | null; outScope: string[]; session: string | null; score: number; max: number; uncached: number; cacheWrite: number; cacheRead: number;
  output: number; reasoning: number; total: number; turns: number | null; usd: number | null; secs: number; rtkCmds: number | null; answer: string };

const env0 = (() => { const e = { ...(process.env as Record<string, string>) }; delete e.ORCH_LEAD; delete e.ORCH_LANE; delete e.ORCH_HARNESS; return e; })();

async function sh(cmd: string[], cwd: string, env: Record<string, string>, timeoutMs = 900_000) {
  const t = Date.now();
  const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { out, err, code, secs: (Date.now() - t) / 1000 };
}

// A writable copy at the spec's base commit, provisioned like a lane worktree.
async function editCopy(q: Q, tag: string, dir: string, useCtx: boolean): Promise<string> {
  const wt = join(dir, "wt", tag);
  await sh(["git", "-C", join(REPOS, q.repo), "worktree", "add", "-q", "--detach", wt, q.edit!.base], "/tmp", env0);
  await sh(["bun", "install", "--frozen-lockfile"], wt, env0);
  if (useCtx) { await sh(["ctx", "init"], wt, env0); await sh(["ctx", "index", "."], wt, env0); }
  return wt;
}

async function runOne(h: H, arm: Arm, q: Q, rep: number, dir: string, warm = false): Promise<Row> {
  let cwd = join(REPOS, q.repo);
  const tag = `${h}-${arm}-${q.id}-${rep}`;
  const rtk = arm === "rtk" || arm === "ctxrtk";
  const useCtx = arm === "ctx" || arm === "ctxrtk";
  const rtkData = join(dir, "rtk", tag);
  const hook = arm === "ctxhook";
  const path0 = CTX_BIN ? `${CTX_BIN}:${env0.PATH}` : env0.PATH!;
  const env = { ...env0, RTK_BENCH_DATA: rtkData, PATH: rtk ? `${RTK_BIN}:${path0}` : path0 };
  if (q.edit) cwd = await editCopy(q, tag, dir, useCtx || arm === "ctxhook");
  const body = q.edit ? EDIT_FRAME + readFileSync(join(SPECS, q.edit.spec), "utf8") : FRAME + q.text;
  const full = arm === "full";
  const prompt = body + (useCtx && q.id !== "floor" ? CTX_HINT : "") + (rtk && h === "grok" && q.id !== "floor" ? RTK_HINT : "");
  let r: Awaited<ReturnType<typeof sh>>;
  const row = { h, arm, q: q.id, rep, warm, ok: false, verify: null as boolean | null, gold: null as string | null, outScope: [] as string[], session: null as string | null, score: 0, max: q.facts.length, uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0,
    turns: null as number | null, usd: null as number | null, secs: 0, rtkCmds: null as number | null, answer: "" };
  if (h === "claude") {
    r = await sh(["claude", "-p", prompt, "--model", MODELS.claude, ...(full ? [] : ["--strict-mcp-config", "--disable-slash-commands"]), "--allowedTools", q.edit ? "Bash,Read,Grep,Glob,Edit,Write" : "Bash,Read,Grep,Glob",
      "--output-format", "json", ...(rtk || hook ? ["--settings", join(HOMES, hook ? "claude-ctxhook-settings.json" : "claude-rtk-settings.json")] : [])], cwd, env);
    try {
      const j = JSON.parse(r.out); const u = j.usage ?? {};
      Object.assign(row, { answer: j.result ?? "", uncached: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0, turns: j.num_turns ?? null, usd: j.total_cost_usd ?? null, ok: r.code === 0 && !j.is_error });
    } catch {}
  } else if (h === "codex") {
    const last = join(dir, "last", `${tag}.txt`);
    r = await sh(["codex", "exec", "--json", "-C", cwd, "-s", q.edit ? "workspace-write" : "read-only", "--skip-git-repo-check", "-m", MODELS.codex, "-c", 'model_reasoning_effort="medium"',
      ...(rtk || hook ? ["--dangerously-bypass-hook-trust"] : []), "-o", last, prompt], cwd, full ? env : { ...env, CODEX_HOME: join(HOMES, hook ? "codex-ctxhook" : rtk ? "codex-rtk" : "codex-base") });
    let input = 0, cached = 0, turns = 0;
    for (const line of r.out.split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.type === "turn.completed" && e.usage) { input += e.usage.input_tokens ?? 0; cached += e.usage.cached_input_tokens ?? 0; row.output += e.usage.output_tokens ?? 0; row.reasoning += e.usage.reasoning_output_tokens ?? 0; }
        if (e.type === "item.completed" && e.item?.type === "command_execution") turns++;
      } catch {}
    }
    let answer = ""; try { answer = readFileSync(last, "utf8"); } catch {}
    Object.assign(row, { answer, uncached: input - cached, cacheRead: cached, turns, ok: r.code === 0 });
  } else {
    const f = join(dir, "prompts", `${tag}.txt`);
    writeFileSync(f, prompt);
    r = await sh(["grok", "--cwd", cwd, "--prompt-file", f, "--output-format", "json", "--always-approve", "-m", MODELS.grok, "--reasoning-effort", "high"], "/tmp", env);
    try {
      const j = JSON.parse(r.out); const u = j.usage ?? {};
      Object.assign(row, { answer: j.text ?? "", uncached: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0, reasoning: u.reasoning_tokens ?? 0, turns: j.num_turns ?? null, usd: j.total_cost_usd ?? null, session: j.sessionId ?? null, ok: r.code === 0 });
    } catch {}
  }
  writeFileSync(join(dir, "raw", `${tag}.out`), `${r.out}\n--- stderr\n${r.err.slice(-4000)}`);
  row.secs = r.secs;
  row.total = row.uncached + row.cacheWrite + row.cacheRead + row.output;
  row.score = q.facts.filter((re) => re.test(row.answer)).length;
  if (q.edit) {
    const v = await sh(["sh", "-c", q.edit.verify], cwd, env0, 300_000);
    row.verify = v.code === 0;
    const declared = readFileSync(join(SPECS, q.edit.spec), "utf8").match(/^FILES: (.*)$/m)?.[1]?.split(/,\s*/) ?? [];
    const touched = (await sh(["sh", "-c", "git add -A -N . && git diff --name-only"], cwd, env0)).out.split("\n").filter(Boolean);
    row.outScope = touched.filter((f) => !declared.includes(f) && !f.startsWith(".ctx"));
    const [commit, file] = q.edit.gold;
    await sh(["sh", "-c", `git show ${commit}:${file} > ${file}`], cwd, env0);
    const g = await sh(["bun", "test", file], cwd, env0, 300_000);
    const m = (g.out + g.err).match(/(\d+) pass[\s\S]*?(\d+) fail/);
    row.gold = m ? `${m[1]}/${Number(m[1]) + Number(m[2])}` : "error";
    row.score = (row.verify ? 1 : 0) + (m && m[2] === "0" ? 1 : 0); row.max = 2;
    await sh(["git", "-C", join(REPOS, q.repo), "worktree", "remove", "--force", cwd], "/tmp", env0);
  }
  if (rtk) {
    const g = await sh([join(RTK_BIN, "rtk"), "gain"], "/tmp", env, 30_000);
    const m = g.out.match(/Total commands:\s+(\d+)/);
    row.rtkCmds = m ? Number(m[1]) : 0;
  }
  return row;
}

async function main() {
  const dir = process.argv[2] ?? join("/tmp/tokbench/b3", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const d of ["raw", "last", "prompts", "rtk"]) mkdirSync(join(dir, d), { recursive: true });
  const hs = (process.env.BENCH_H ?? "claude,codex,grok").split(",") as H[];
  const arms = (process.env.BENCH_ARMS ?? ARMS.join(",")).split(",") as Arm[];
  const qs = process.env.BENCH_Q ? QUESTIONS.filter((q) => process.env.BENCH_Q!.split(",").includes(q.id)) : QUESTIONS.filter((q) => !q.edit);
  const reps = Number(process.env.BENCH_REPS ?? 5), par = Number(process.env.BENCH_PAR ?? 6);
  // Warm the prompt cache once per harness and arm (discarded), so the first
  // measured run does not pay the cache write the others then read.
  const results = join(dir, "results.jsonl");
  const floor = QUESTIONS[0]!;
  await Promise.all(hs.flatMap((h) => arms.filter((arm) => arm !== "ctxhook" || h !== "grok").map(async (arm) => appendFileSync(results, `${JSON.stringify(await runOne(h, arm, floor, 0, dir, true))}\n`))));
  // Paired and shuffled: every cell of a repetition runs in a random order,
  // repetitions in sequence, so drift and rate limits hit every arm alike.
  let seed = Number(process.env.BENCH_SEED ?? 1);
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const jobs: [H, Arm, Q, number][] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const cell: [H, Arm, Q, number][] = [];
    for (const q of qs) for (const arm of arms) for (const h of hs) if ((arm !== "full" || q.id === "floor") && (arm !== "ctxhook" || h !== "grok")) cell.push([h, arm, q, rep]);
    for (let i = cell.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cell[i], cell[j]] = [cell[j]!, cell[i]!]; }
    jobs.push(...cell);
  }
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: par }, async () => {
    while (next < jobs.length) {
      const [h, arm, q, rep] = jobs[next++]!;
      const row = await runOne(h, arm, q, rep, dir).catch((e: Error) => ({ h, arm, q: q.id, rep, warm: false, ok: false, error: String(e).slice(0, 300) }) as unknown as Row);
      appendFileSync(results, `${JSON.stringify(row)}\n`);
      console.log(`${++done}/${jobs.length} ${h} ${arm} ${q.id}#${rep} ok=${row.ok} score=${row.score}/${row.max} total=${row.total} turns=${row.turns} ${row.secs.toFixed(0)}s`);
    }
  }));
  console.log(`results: ${results}`);
}

if (import.meta.main) await main();
