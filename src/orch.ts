#!/usr/bin/env -S bun --no-env-file
// orch install|diff|uninstall: write the lead files under HOME and track them
// in a manifest so uninstall removes exactly those and nothing else.
// orch mem: the lead's memory notes (see mem.ts).
// orch docs: the local documentation corpus (see docs.ts).
// orch doctor: whether each worker harness can run a lane here (see doctor.ts).
// orch llm: the embed and decide providers of the memory brain (see llm.ts).
// orch brain: the Postgres + pgvector memory brain (see brain/cli.ts).
// orch kiba: start Kiba, the native lead on Claude (the conductor is orch serve).
// orch presence|routine|ops: notification channels, routines and host controls.
// orch serve|task: the conductor v2 engine and its durable tasks (see serve/engine.ts).
// orch dir|migrate: the project folder ~/.orch/<project>/ (see project.ts).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { doctorChecks, missingSystemPackages } from "./install/doctor.ts";
import { DOCS_USAGE, loadSources, pruneSources, searchDocs, statusLines, updateSource } from "./docs/docs.ts";
import { apply, drift, plan, readManifest, uninstall } from "./install/manifest.ts";
import { disableCommands, enableable, enableCommands, optInNotes, reloadCommand, runAll, unitsOf } from "./install/systemd.ts";
import { fileBackend, type MemBackend } from "./mem/backend.ts";
import { callerFromEnv, formatLine, formatNote, MEM_USAGE, type Scope, SCOPES } from "./mem/mem.ts";
import { bound } from "./core/output.ts";
import { stateDir } from "./core/paths.ts";
import { DAILY_USD_DEPRECATED_HINT, loadPolicy, resolveLogsPolicy } from "./core/policy.ts";
import { legacyNotice, migrateProject, projectDir } from "./core/project.ts";
import { loadProfile } from "./core/profile.ts";
import { render } from "./install/render.ts";
import { ensureClaudeCleanupSettings } from "./logs/prune.ts";
import { detect, HARNESS_IDS, onPath, type HarnessId } from "./harness/registry.ts";

const home = () => process.env.ORCH_HOME ?? homedir();

async function files(cmd: string, rest: string[]) {
  const { values } = parseArgs({ args: rest, options: { profile: { type: "string" }, harness: { type: "string" }, "dry-run": { type: "boolean" }, "no-system-deps": { type: "boolean" }, enable: { type: "boolean" } } });
  const dry = values["dry-run"] ?? false;
  if (cmd === "install") {
    const harnesses = harnessSelection(values.harness);
    const profile = loadProfile(values.profile);
    const targets = render(profile, harnesses);
    const actions = plan(home(), targets, readManifest(stateDir()), harnesses);
    console.log(`harnesses: ${harnesses.join(", ") || "none"}`);
    for (const a of actions) console.log(a.op === "kept"
      ? `kept ~/${a.path} (${a.reason})`
      : `${a.op.padEnd(9)} ~/${a.path}${a.reason ? `  (${a.reason})` : ""}`);
    if (actions.some((a) => a.op === "conflict")) {
      console.error("orch: conflicts, nothing written");
      process.exit(1);
    }
    // A unit about to be removed is stopped and disabled first.
    const onDisk = (path: string) => { try { return readFileSync(join(home(), path), "utf8"); } catch { return null; } };
    const retired = unitsOf(actions.filter((a) => a.op === "remove").map((a) => ({ path: a.path, content: onDisk(a.path) })));
    if (retired.length) runAll(disableCommands(retired), dry, console.log);
    if (dry) console.log("dry run: nothing written");
    else {
      apply(home(), stateDir(), profile.name, targets, actions);
      console.log(`installed, manifest ${join(stateDir(), "manifest.json")}`);
    }
    if (harnesses.includes("claude")) {
      const keepDays = resolveLogsPolicy(loadPolicy()).retention_days;
      const ensured = ensureClaudeCleanupSettings({ home: home(), days: keepDays, dryRun: dry });
      if (ensured.changed) {
        if (dry) console.log(`would set ~/.claude/settings.json cleanupPeriodDays=${keepDays}`);
        else console.log(`set ~/.claude/settings.json cleanupPeriodDays=${keepDays}${ensured.backupPath ? ` (backup ${ensured.backupPath})` : ""}`);
      } else {
        console.log(`kept ~/.claude/settings.json cleanupPeriodDays=${keepDays}`);
      }
    }
    const units = unitsOf(targets);
    if (values.enable) {
      if (!runAll(enableCommands(units), dry, console.log)) process.exitCode = 1;
    } else if (!dry) {
      runAll([reloadCommand], dry, console.log);
      console.log(`units written, not enabled: orch install --enable (or systemctl --user enable --now ${enableable(units).join(" ")})`);
    }
    for (const line of optInNotes(units)) console.log(line);
    if (!dry) {
      // Running leads keep the code and argv they started with.
      const { restartNotes } = await import("./install/restart.ts");
      const notes = restartNotes();
      console.log(notes.length ? notes.join("\n") : "running leads: none to restart");
    }
    if (!values["no-system-deps"]) {
      systemDeps(dry);
      const { installShellcheck } = await import("./install/shellcheck.ts");
      console.log(await installShellcheck({ home: home(), dry, which: onPath }));
    }
  } else if (cmd === "diff") {
    const harnesses = harnessSelection(values.harness);
    console.log(`harnesses: ${harnesses.join(", ") || "none"}`);
    for (const l of drift(home(), stateDir(), harnesses)) console.log(l);
  } else {
    const units = unitsOf((readManifest(stateDir())?.entries ?? []).map((e) => { let content: string | null = null; try { content = readFileSync(join(home(), e.path), "utf8"); } catch {} return { path: e.path, content }; }));
    if (units.length) runAll(disableCommands(units), dry, console.log);
    for (const l of uninstall(home(), stateDir(), dry)) console.log(l);
    if (units.length) runAll([reloadCommand], dry, console.log);
  }
}

function harnessSelection(value?: string): HarnessId[] {
  if (value === undefined) return detect();
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(HARNESS_IDS as string[]).includes(name));
  if (!names.length || unknown.length) throw new Error(`orch: invalid --harness ${value}`);
  return [...new Set(names as HarnessId[])];
}

// The sandboxed Claude worker needs bubblewrap and socat (Linux). They are
// system packages: install them through sudo apt-get when a person is at the
// terminal to type the password, otherwise print the command. Never fatal:
// the lead files are installed either way, and `orch doctor` keeps flagging it.
function systemDeps(dry: boolean) {
  const pkgs = missingSystemPackages();
  if (!pkgs.length) return;
  const cmd = ["sudo", "apt-get", "install", "-y", ...pkgs];
  const line = cmd.join(" ");
  if (dry) return console.log(`would run  ${line}  (sandbox for the Claude worker)`);
  if (!process.stdin.isTTY || !onPath("apt-get")) {
    return console.log(`system packages missing for the Claude worker sandbox: ${pkgs.join(", ")}\nrun: ${line}`);
  }
  console.log(`installing ${pkgs.join(", ")} for the Claude worker sandbox: ${line}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  console.log(r.status === 0 ? "system packages installed" : `system packages not installed (exit ${r.status}); run: ${line}`);
}

// Markdown files unless catalog/brain.yaml says `mem: brain`; the brain
// client and model SDK load only then.
async function memBackend(): Promise<MemBackend> {
  if (process.env.ORCH_BRAIN_SNAPSHOT || process.env.ORCH_BENCH_RUN) {
    const { filesAt, sandboxMem } = await import("./mem/sandbox.ts");
    const sandbox = process.env.ORCH_MEM_SANDBOX;
    if (!sandbox) throw new Error("benchmark memory requires a run-owned sandbox");
    const store = process.env.ORCH_BRAIN_SNAPSHOT
      ? (await import("./memory/snapshot-mem.ts")).snapshotMem(process.env.ORCH_BRAIN_SNAPSHOT)
      : filesAt(join(sandbox, "empty-source"));
    return sandboxMem(store, sandbox);
  }
  const { loadBrainConfig } = await import("./brain/db.ts");
  const c = loadBrainConfig();
  const store = c.mem === "brain" ? await (await import("./brain/notes.ts")).openBrainMem(c) : fileBackend;
  // benches: real notes readable, writes kept in the bench's folder
  const sandbox = process.env.ORCH_MEM_SANDBOX;
  return sandbox ? (await import("./mem/sandbox.ts")).sandboxMem(store, sandbox) : store;
}

async function mem(args: string[]) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      scope: { type: "string" }, tags: { type: "string" }, limit: { type: "string" }, all: { type: "boolean" }, reason: { type: "string" },
    },
  });
  const caller = callerFromEnv();
  const max = loadProfile().limits.report_max_bytes;
  const legacy = legacyNotice();
  if (legacy) console.error(`note: ${legacy}`);
  if (values.scope && !(SCOPES as string[]).includes(values.scope)) throw new Error(`mem: unknown scope ${values.scope}`);
  const scope = values.scope as Scope | undefined;
  const limit = values.limit ? Number(values.limit) : undefined;
  const text = positionals.join(" ");
  if (!["add", "search", "recent", "review", "show", "supersede", "forget"].includes(sub ?? "")) {
    console.log(MEM_USAGE);
    process.exitCode = 2;
    return;
  }
  const store = await memBackend();
  try {
    if (sub === "add") {
      const body = text === "-" ? readFileSync(0, "utf8") : text;
      const tags = values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const n = await store.add({ body, scope: scope ?? "project", tags }, caller);
      if (n.warning) console.error(n.warning);
      console.log(`saved ${n.id} (${n.scope})`);
    } else if (sub === "search" || sub === "recent") {
      const notes = sub === "search" ? await store.search(text, caller, { scope, limit, all: values.all }) : await store.recent(caller, { scope, limit, all: values.all });
      console.log(bound(notes.length ? notes.map((n) => formatLine(n)).join("\n") : "no note", max));
    } else if (sub === "review") {
      const pairs = await store.review(caller, { scope, limit });
      console.log(bound(pairs.length
        ? `${pairs.map((p) => `${p.score.toFixed(2)}\n  newer ${formatLine(p.newer)}\n  older ${formatLine(p.older)}`).join("\n")}
  same fact or changed value: orch mem forget <outdated id> --reason "..."; different facts: leave both`
        : "no close pair", max));
    } else if (sub === "show") {
      const n = await store.show(text, caller);
      if (!n) throw new Error(`mem: no note ${text}`);
      console.log(bound(formatNote(n), max));
    } else if (sub === "supersede") {
      const id = positionals[0];
      const supersedeText = positionals.slice(1).join(" ");
      if (!id) throw new Error("mem supersede: missing note id");
      const body = supersedeText === "-" ? readFileSync(0, "utf8") : supersedeText;
      const tags = values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const n = await store.supersede(id, { body, tags }, caller);
      if (n.warning) console.error(n.warning);
      console.log(`saved ${n.id} (${n.scope}), supersedes ${id}`);
    } else if (sub === "forget") {
      const id = positionals[0];
      if (!id) throw new Error("mem forget: missing note id");
      const n = await store.forget(id, values.reason ?? "", caller);
      console.log(`forgot ${n.id}`);
    }
  } finally {
    await store.close();
  }
}

async function docs(args: string[]) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { stack: { type: "string" }, budget: { type: "string" } },
  });
  const sources = loadSources();
  const max = loadProfile().limits.report_max_bytes;
  if (sub === "update") {
    const picked = positionals.length ? sources.filter((s) => positionals.includes(s.id)) : sources;
    const unknown = positionals.filter((id) => !sources.some((s) => s.id === id));
    if (unknown.length) throw new Error(`docs: unknown source ${unknown.join(", ")}`);
    for (const s of picked) {
      try {
        const m = await updateSource(s);
        console.log(`${s.id.padEnd(20)} ${m.version.padEnd(9)} ${String(m.files).padStart(6)} files  ${m.indexed ? "indexed" : "NOT INDEXED"}${m.files === 0 ? "  (empty: check paths)" : ""}`);
      } catch (e) {
        console.log(`${s.id.padEnd(20)} FAILED  ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
    if (!positionals.length) {
      for (const id of pruneSources(sources)) console.log(`${id.padEnd(20)} pruned`);
    }
  } else if (sub === "status") {
    for (const l of statusLines(sources)) console.log(l);
  } else if (sub === "search") {
    const lines = searchDocs(positionals.join(" "), sources, { stack: values.stack, budgetTokens: values.budget ? Number(values.budget) : undefined });
    console.log(bound(lines.join("\n"), max));
  } else {
    console.log(DOCS_USAGE);
    process.exitCode = 2;
  }
}

// Loaded on demand: the Anthropic SDK stays out of every other orch command.
async function llm(args: string[]) {
  const { decide, embed, LLM_USAGE, ROLES, statusLines, use } = await import("./llm/llm.ts");
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { force: { type: "boolean" }, as: { type: "string" } },
  });
  const role = positionals[0];
  if (sub === "status") {
    for (const l of statusLines()) console.log(l);
  } else if (sub === "use" && (ROLES as string[]).includes(role) && positionals[1]) {
    const r = use(role as "embed" | "decide", positionals[1], { force: values.force });
    console.log(`${role}: ${r.previous} -> ${positionals[1]}${r.spaceChanged ? "  (new embedding space: re-embed the memory)" : ""}`);
  } else if (sub === "test" && role === "embed" && positionals.length > 1) {
    const kind = values.as ?? "query";
    if (kind !== "query" && kind !== "document") throw new Error("llm test: --as must be query or document");
    const started = performance.now();
    const r = await embed([positionals.slice(1).join(" ")], kind);
    const v = r.vectors[0];
    console.log(`${r.provider}  space ${r.space}  ${v.length} dims  norm ${Math.hypot(...v).toFixed(3)}  ${Math.round(performance.now() - started)} ms`);
  } else if (sub === "test" && role === "decide" && positionals.length > 1) {
    const started = performance.now();
    const r = await decide(positionals.slice(1).join(" "));
    console.log(`${r.provider}  ${Math.round(performance.now() - started)} ms\n${bound(r.text, loadProfile().limits.report_max_bytes)}`);
  } else {
    console.log(LLM_USAGE);
    process.exitCode = 2;
  }
}

// Same code as the installed hook commands, which run src/hooks/hook.ts
// directly (src/install/render.ts): this path serves a manual `orch hook`.
async function hook(args: string[]) {
  // Before parseArgs: a status line must render whatever flags it gets.
  if (args[0] === "statusline") {
    await statusline();
    return;
  }
  const { hookMain } = await import("./hooks/hook.ts");
  await hookMain(args);
}

// Claude Code statusLine: saves rate_limits for the dash, prints a short line.
async function statusline() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch {}
  let text = "orch";
  try {
    const { runStatusline } = await import("./hooks/statusline.ts");
    text = runStatusline(raw, process.env);
  } catch {}
  process.stdout.write(`${text}\n`);
}

try {
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "hook") await hook(rest);
else if (cmd === "statusline") await statusline();
else if (cmd === "policy") await (await import("./core/hook-policy.ts")).hookPolicyCli(rest);
else if (cmd === "logs") await (await import("./logs/cli.ts")).logs(rest);
else if (cmd === "mem") await mem(rest);
else if (cmd === "docs") await docs(rest);
else if (cmd === "llm") await llm(rest);
else if (cmd === "brain") await (await import("./brain/cli.ts")).brain(rest);
else if (cmd === "bench") await (await import("./bench/cli.ts")).bench(rest);
else if (cmd === "kiba") await (await import("./kiba/cli.ts")).kiba(rest);
else if (cmd === "task") await (await import("./serve/cli.ts")).taskCli(rest);
else if (cmd === "serve") await (await import("./serve/cli.ts")).serveCli(rest);
else if (cmd === "presence") await (await import("./presence/cli.ts")).presence(rest);
else if (cmd === "routine") await (await import("./routines/cli.ts")).routine(rest);
else if (cmd === "ops") await (await import("./ops/cli.ts")).ops(rest);
else if (cmd === "top") await (await import("./top/cli.ts")).top(rest);
else if (cmd === "kill") process.stdout.write(await (await import("./core/kill.ts")).killCli(rest));
else if (cmd === "resume") process.stdout.write((await import("./core/kill.ts")).resumeSwitch());
else if (cmd === "dash") await (await import("./dash/cli.ts")).dash(rest);
else if (cmd === "improve") await (await import("./improve/cli.ts")).improve(rest);
else if (cmd === "reflect") await (await import("./reflect/cli.ts")).reflect(rest);
else if (cmd === "bus") await (await import("./bus/cli.ts")).bus(rest);
else if (cmd === "log") process.stdout.write((await import("./hooks/log-cli.ts")).logCli(rest));
else if (cmd === "rule") {
  const out = (await import("./rules/cli.ts")).ruleCli(rest);
  process.stdout.write(out);
  if (/^STATUS: refused$/m.test(out)) process.exitCode = 2;
}
else if (cmd === "lane") {
  const r = spawnSync(process.execPath, ["--no-env-file", join(import.meta.dir, "lane.ts"), ...rest], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
}
else if (cmd === "install" || cmd === "diff" || cmd === "uninstall") await files(cmd, rest);
else if (cmd === "dir") console.log(projectDir());
else if (cmd === "migrate") {
  const { lines, conflicts } = migrateProject(process.cwd(), { dry: rest.includes("--dry-run") });
  for (const l of lines) console.log(l);
  if (conflicts) process.exitCode = 1;
}
else if (cmd === "doctor") {
  try { if (loadPolicy().spend.daily_usd != null) console.error(DAILY_USD_DEPRECATED_HINT); } catch {}
  const { loadBrainConfig } = await import("./brain/db.ts");
  const provider = process.env.ORCH_MEMORY_PROVIDER ?? loadBrainConfig().memory_provider;
  let reachable: boolean | undefined;
  if (provider === "hindsight" || provider === "brain") {
    try {
      if (provider === "hindsight") {
        const { health, loadHindsightConfig } = await import("./memory/hindsight.ts");
        reachable = (await health(loadHindsightConfig())).ok;
      } else {
        const { statusLines } = await import("./brain/admin.ts");
        reachable = !(await statusLines(loadBrainConfig())).unavailable;
      }
    } catch { reachable = false; }
  }
  const { ok, lines } = doctorChecks(home(), undefined, undefined, { provider, reachable });
  const legacy = legacyNotice();
  if (legacy) lines.push(`FAIL ${legacy}`);
  // Informative, never a failure: restarting a lead is the operator's call.
  try {
    const { restartNotes } = await import("./install/restart.ts");
    const notes = restartNotes();
    lines.push(...(notes.length ? notes.map((n) => `WARN ${n}`) : ["ok   running leads on the current code and profile"]));
    const { optInNotes, unitEnabled } = await import("./install/systemd.ts");
    lines.push(...optInNotes([{ name: "orch-kiba.service", installable: true }, { name: "orch-serve.service", installable: true }], unitEnabled).map((n) => n.startsWith("WARN") ? n : `ok   ${n}`));
  } catch (e) { lines.push(`WARN running leads not checked: ${(e as Error).message}`); }
  for (const l of lines) console.log(l);
  if (!ok || legacy) process.exitCode = 1;
}
else {
  console.log("usage: orch install [--profile p] [--harness claude,codex] [--dry-run] [--no-system-deps] [--enable] | diff [--harness claude,codex] | uninstall [--dry-run] | dir | migrate [--dry-run] | policy show|edit|reset | logs prune [--days N] [--dry-run] | mem add|search|recent|show|supersede|forget|review | docs update|status|search | llm status|use|test | brain init|up|provision|status|import-notes|embed|search|eval|hindsight-seed|snapshot|ingest-transcripts|backup|restore-check | kiba [claude args] | presence status|notify | routine list|run|status|journal | ops check|usage | top [--once] | dash [--port 7894] [--host 127.0.0.1] | kill [--all|<lane>] | resume | improve digest|run|show | reflect digest|run|show|accept|reject|candidates | bench run|baseline|compare|history | doctor | task new|list|show|follow|stop | task adopt --worktree <path>|--branch <name> --files <globs> --verify <cmd> | serve [--once] | serve migrate | lane batch --mission <file> | bus list|status|send|ack|draft|notice|test|key|watch | log [show|path|snapshot|append] | rule harvest|add|list|bench | hook pre-bash|post-edit|prompt-submit|stop|session-start|session-end|post-tool|subagent-start|subagent-stop|statusline --harness claude | statusline");
  process.exitCode = 2;
}
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  const safeMessage = message.replace(/[\r\n]+/g, " ");
  const { EXIT_UNAVAILABLE, isBrainUnavailable } = await import("./brain/db.ts");
  if (isBrainUnavailable(e)) {
    console.error(`orch: brain unreachable: ${safeMessage}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else {
    console.error(`orch: ${safeMessage}`);
    process.exitCode = 1;
  }
}
