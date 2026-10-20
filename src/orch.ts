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
import { doctorChecks, missingSystemPackages, onPath } from "./doctor.ts";
import { DOCS_USAGE, loadSources, searchDocs, statusLines, updateSource } from "./docs.ts";
import { bound } from "./lane.ts";
import { apply, drift, plan, readManifest, uninstall } from "./manifest.ts";
import { addNote, callerFromEnv, formatLine, formatNote, MEM_USAGE, recentNotes, type Scope, SCOPES, searchNotes, showNote } from "./mem.ts";
import { loadProfile } from "./profile.ts";
import { render } from "./render.ts";

const home = () => process.env.ORCH_HOME ?? homedir();
const state = () => process.env.ORCH_STATE ?? join(homedir(), ".local", "state", "orch");

function files(cmd: string, rest: string[]) {
  const { values } = parseArgs({ args: rest, options: { profile: { type: "string" }, "dry-run": { type: "boolean" }, "no-system-deps": { type: "boolean" } } });
  const dry = values["dry-run"] ?? false;
  if (cmd === "install") {
    const profile = loadProfile(values.profile);
    const targets = render(profile);
    const actions = plan(home(), targets, readManifest(state()));
    for (const a of actions) console.log(`${a.op.padEnd(9)} ~/${a.path}${a.reason ? `  (${a.reason})` : ""}`);
    if (actions.some((a) => a.op === "conflict")) {
      console.error("orch: conflicts, nothing written");
      process.exit(1);
    }
    if (dry) console.log("dry run: nothing written");
    else {
      apply(home(), state(), profile.name, targets, actions);
      console.log(`installed, manifest ${join(state(), "manifest.json")}`);
    }
    if (!values["no-system-deps"]) systemDeps(dry);
  } else if (cmd === "diff") {
    for (const l of drift(home(), state())) console.log(l);
  } else {
    for (const l of uninstall(home(), state(), dry)) console.log(l);
  }
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
    options: { scope: { type: "string" }, tags: { type: "string" }, limit: { type: "string" } },
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
    console.log(`saved ${n.id} (${n.scope})`);
  } else if (sub === "search" || sub === "recent") {
    const notes = sub === "search" ? searchNotes(text, caller, { scope, limit }) : recentNotes(caller, { scope, limit });
    console.log(bound(notes.length ? notes.map(formatLine).join("\n") : "no note", max));
  } else if (sub === "show") {
    const n = showNote(text, caller);
    if (!n) throw new Error(`mem: no note ${text}`);
    console.log(bound(formatNote(n), max));
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

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "mem") mem(rest);
else if (cmd === "docs") await docs(rest);
else if (cmd === "install" || cmd === "diff" || cmd === "uninstall") files(cmd, rest);
else if (cmd === "doctor") {
  const { ok, lines } = doctorChecks(home());
  for (const l of lines) console.log(l);
  if (!ok) process.exitCode = 1;
}
else {
  console.log("usage: orch install [--profile p] [--dry-run] [--no-system-deps] | diff | uninstall [--dry-run] | mem add|search|recent|show | docs update|status|search | doctor");
  process.exitCode = 2;
}
