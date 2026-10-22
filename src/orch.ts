#!/usr/bin/env bun
// orch install|diff|uninstall: write the lead files under HOME and track them
// in a manifest so uninstall removes exactly those and nothing else.
// orch mem: the lead's memory notes (see mem.ts).
// orch docs: the local documentation corpus (see docs.ts).
// orch doctor: whether each worker harness can run a lane here (see doctor.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { doctorChecks, missingSystemPackages } from "./install/doctor.ts";
import { DOCS_USAGE, loadSources, pruneSources, searchDocs, statusLines, updateSource } from "./docs/docs.ts";
import { apply, drift, plan, readManifest, uninstall } from "./install/manifest.ts";
import { addNote, callerFromEnv, closePairs, forgetNote, formatLine, formatNote, MEM_USAGE, recentNotes, type Scope, SCOPES, searchNotes, showNote, supersedeNote } from "./mem/mem.ts";
import { badges, recordOutcome, reflect } from "./mem/outcome.ts";
import { bound } from "./core/output.ts";
import { stateDir } from "./core/paths.ts";
import { loadProfile } from "./core/profile.ts";
import { render } from "./install/render.ts";
import type { HookEvent } from "./hooks/hook.ts";
import { detect, HARNESS_IDS, onPath, type HarnessId } from "./harness/registry.ts";

const home = () => process.env.ORCH_HOME ?? homedir();

function files(cmd: string, rest: string[]) {
  const { values } = parseArgs({ args: rest, options: { profile: { type: "string" }, harness: { type: "string" }, "dry-run": { type: "boolean" }, "no-system-deps": { type: "boolean" } } });
  const dry = values["dry-run"] ?? false;
  if (cmd === "install") {
    const harnesses = harnessSelection(values.harness);
    const profile = loadProfile(values.profile);
    const targets = render(profile, harnesses);
    const actions = plan(home(), targets, readManifest(stateDir()));
    console.log(`harnesses: ${harnesses.join(", ") || "none"}`);
    for (const a of actions) console.log(a.op === "kept"
      ? `kept ~/${a.path} (${a.reason})`
      : `${a.op.padEnd(9)} ~/${a.path}${a.reason ? `  (${a.reason})` : ""}`);
    if (actions.some((a) => a.op === "conflict")) {
      console.error("orch: conflicts, nothing written");
      process.exit(1);
    }
    if (dry) console.log("dry run: nothing written");
    else {
      apply(home(), stateDir(), profile.name, targets, actions);
      console.log(`installed, manifest ${join(stateDir(), "manifest.json")}`);
    }
    if (!values["no-system-deps"]) systemDeps(dry);
  } else if (cmd === "diff") {
    const harnesses = harnessSelection(values.harness);
    console.log(`harnesses: ${harnesses.join(", ") || "none"}`);
    for (const l of drift(home(), stateDir(), harnesses)) console.log(l);
  } else {
    for (const l of uninstall(home(), stateDir(), dry)) console.log(l);
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

function mem(args: string[]) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      scope: { type: "string" }, tags: { type: "string" }, limit: { type: "string" }, all: { type: "boolean" }, reason: { type: "string" },
      why: { type: "string" }, "half-life-days": { type: "string" },
    },
  });
  const caller = callerFromEnv();
  const max = loadProfile().limits.report_max_bytes;
  if (values.scope && !(SCOPES as string[]).includes(values.scope)) throw new Error(`mem: unknown scope ${values.scope}`);
  const scope = values.scope as Scope | undefined;
  const limit = values.limit ? Number(values.limit) : undefined;
  const text = positionals.join(" ");
  if (sub === "add") {
    const body = text === "-" ? readFileSync(0, "utf8") : text;
    const tags = values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const n = addNote({ body, scope: scope ?? "project", tags }, caller);
    if (n.warning) console.error(n.warning);
    console.log(`saved ${n.id} (${n.scope})`);
  } else if (sub === "search" || sub === "recent") {
    const notes = sub === "search" ? searchNotes(text, caller, { scope, limit, all: values.all }) : recentNotes(caller, { scope, limit, all: values.all });
    const marks = badges(caller);
    console.log(bound(notes.length ? notes.map((n) => formatLine(n, marks.get(n.id))).join("\n") : "no note", max));
  } else if (sub === "review") {
    const pairs = closePairs(caller, { scope, limit });
    console.log(bound(pairs.length
      ? `${pairs.map((p) => `${p.score.toFixed(2)}\n  newer ${formatLine(p.newer)}\n  older ${formatLine(p.older)}`).join("\n")}
same fact or changed value: orch mem forget <outdated id> --reason "..."; different facts: leave both`
      : "no close pair", max));
  } else if (sub === "show") {
    const n = showNote(text, caller);
    if (!n) throw new Error(`mem: no note ${text}`);
    console.log(bound(formatNote(n), max));
  } else if (sub === "supersede") {
    const id = positionals[0];
    const supersedeText = positionals.slice(1).join(" ");
    if (!id) throw new Error("mem supersede: missing note id");
    const body = supersedeText === "-" ? readFileSync(0, "utf8") : supersedeText;
    const tags = values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const n = supersedeNote(id, { body, tags }, caller);
    if (n.warning) console.error(n.warning);
    console.log(`saved ${n.id} (${n.scope}), supersedes ${id}`);
  } else if (sub === "forget") {
    const id = positionals[0];
    if (!id) throw new Error("mem forget: missing note id");
    const n = forgetNote(id, values.reason ?? "", caller);
    console.log(`forgot ${n.id}`);
  } else if (sub === "outcome") {
    const [id, outcome] = positionals;
    if (!id) throw new Error("mem outcome: missing note id");
    const s = recordOutcome(id, outcome ?? "", values.why, caller);
    console.log(`noted ${s.outcome} for ${s.note}`);
  } else if (sub === "reflect") {
    const halfLifeDays = values["half-life-days"] ? Number(values["half-life-days"]) : undefined;
    if (halfLifeDays !== undefined && !(halfLifeDays > 0)) throw new Error("mem reflect: --half-life-days must be a positive number");
    console.log(bound(reflect(caller, { scope, limit, halfLifeDays }), max));
  } else {
    console.log(MEM_USAGE);
    process.exitCode = 2;
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

async function hook(args: string[]) {
  try {
    const [event, ...rest] = args;
    const { values } = parseArgs({ args: rest, options: { harness: { type: "string" } } });
    if (!("pre-bash prompt-submit post-edit stop".split(" ") as string[]).includes(event) ||
      !("claude codex grok".split(" ") as string[]).includes(values.harness ?? "")) return;
    let input: unknown;
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
    const { runHook } = await import("./hooks/hook.ts");
    const output = await runHook(event as HookEvent, values.harness as "claude" | "codex" | "grok", input, process.env);
    if (output) process.stdout.write(`${output}\n`);
  } catch {
    // Hook commands fail open. A malformed event or unavailable state must
    // never prevent the harness from continuing its normal work.
  }
}

try {
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "hook") await hook(rest);
else if (cmd === "mem") mem(rest);
else if (cmd === "docs") await docs(rest);
else if (cmd === "install" || cmd === "diff" || cmd === "uninstall") files(cmd, rest);
else if (cmd === "doctor") {
  const { ok, lines } = doctorChecks(home());
  for (const l of lines) console.log(l);
  if (!ok) process.exitCode = 1;
}
else {
  console.log("usage: orch install [--profile p] [--harness claude,codex] [--dry-run] [--no-system-deps] | diff [--harness claude,codex] | uninstall [--dry-run] | mem add|search|recent|show|supersede|forget|outcome|reflect | docs update|status|search | doctor | hook pre-bash|post-edit|prompt-submit|stop --harness claude|codex|grok");
  process.exitCode = 2;
}
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`orch: ${message.replace(/[\r\n]+/g, " ")}`);
  process.exitCode = 1;
}
