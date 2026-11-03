// improve: daily improvement proposals (Emilien's daily self-improvement
// mission, validated by his operator). `collect` gathers the last day's
// evidence without a model: failed routines, lane failures and gate refusals,
// and in each interactive Claude Code session the operator's own messages and
// the tool errors. `run` hands it to a read-only Claude in this checkout, which
// answers with at most three proposals, each tied to a line of the evidence.
// Nothing is applied: the operator validates a proposal ("valide 2") and the
// lead implements it like any change.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { type ModelChoice, ROOT } from "../core/profile.ts";
import { parseWorkerOutput, workerArgv } from "../harness/harness.ts";
import { runLogged, workerEnv } from "../harness/proc.ts";
import { readLedger } from "../lanes/ledger.ts";
import { type Entry, readJournal } from "../routines/routines.ts";
import type { Notice } from "../presence/notify.ts";

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

export interface Session { file: string; cwd: string; operator: string[]; errors: Map<string, string[]> }

// One transcript, interactive only: a headless run (`entrypoint: sdk-cli`: lane
// workers, routines, this very command) has no operator in it.
export function readSession(file: string, since: Date): Session | null {
  const s: Session = { file, cwd: "", operator: [], errors: new Map() };
  const toolNames = new Map<string, string>();
  let interactive = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.entrypoint === "cli") interactive = true;
    if (o.cwd) s.cwd = o.cwd;
    if (o.timestamp && Date.parse(o.timestamp) < since.getTime()) continue;
    const content = o.message?.content;
    if (o.type === "assistant" && Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_use" && b.id) toolNames.set(b.id, String(b.name ?? "tool"));
      continue;
    }
    if (typeof content === "string") {
      // the operator's words, not hook output, task notifications or other agents
      if (!o.isMeta && !content.trimStart().startsWith("<")) s.operator.push(clip(content, 300));
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && !o.isMeta && typeof b.text === "string" && !b.text.trimStart().startsWith("<")) s.operator.push(clip(b.text, 300));
        if (b?.type === "tool_result" && b.is_error) {
          const name = toolNames.get(b.tool_use_id) ?? "tool";
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join(" ") : "";
          const list = s.errors.get(name) ?? [];
          list.push(clip(text, 160));
          s.errors.set(name, list);
        }
      }
    }
  }
  return interactive && (s.operator.length || s.errors.size) ? s : null;
}

function* transcripts(projects: string, since: Date): Generator<string> {
  if (!existsSync(projects)) return;
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const d = join(projects, dir.name);
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(d, f);
      if (statSync(p).mtimeMs >= since.getTime()) yield p;
    }
  }
}

export interface DigestOpts { since: Date; projects: string; state?: string; maxBytes?: number; maxSessions?: number }

// The evidence as Markdown, bounded; empty when nothing happened worth a look.
export function collect(o: DigestOpts): { text: string; signals: number } {
  const state = o.state ?? stateDir();
  const after = (at?: string) => !!at && Date.parse(at) >= o.since.getTime();
  const parts: string[] = [];
  let signals = 0;

  // one line per routine: how often it failed, and its latest failure
  const failed = new Map<string, Entry[]>();
  for (const e of readJournal(state)) if (!e.ok && after(e.end)) failed.set(e.id, [...(failed.get(e.id) ?? []), e]);
  if (failed.size) {
    parts.push("## Routines en échec", ...[...failed].map(([id, runs]) => {
      signals += runs.length;
      const e = runs.at(-1)!;
      const step = e.steps.find((st) => st.exit !== 0 || st.timed_out);
      const why = e.skipped ?? (step ? `${step.command} → ${step.timed_out ? "timeout" : `exit ${step.exit}`}: ${clip(step.tail, 300)}` : "failed");
      return `- ${id} : ${runs.length} échec(s), le dernier à ${e.end.slice(0, 16)} : ${why}`;
    }), "");
  }

  const ledger = readLedger(state).filter((r) => after(r.at));
  const lanes = ledger.flatMap((r) =>
    r.kind === "run" && r.status !== "complete" && r.status !== "noop" ? [`- lane ${r.id} (${r.to} · ${r.model}): ${r.status}`]
    : r.kind === "gate" ? [`- gate refusé pour ${r.id}: ${r.reasons.join("; ")}`]
    : []);
  if (lanes.length) {
    signals += lanes.length;
    parts.push("## Lanes", ...lanes, "");
  }

  const sessions = [...transcripts(o.projects, o.since)]
    .map((f) => readSession(f, o.since))
    .filter((s): s is Session => s !== null)
    .sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs)
    .slice(0, o.maxSessions ?? 12);
  for (const s of sessions) {
    signals += s.operator.length + [...s.errors.values()].reduce((n, l) => n + l.length, 0);
    parts.push(`## Session ${s.cwd || s.file}`);
    if (s.operator.length) parts.push("Messages de l'opérateur :", ...s.operator.slice(-30).map((m) => `- « ${m} »`));
    for (const [tool, errs] of s.errors) parts.push(`Erreurs ${tool} (${errs.length}) :`, ...errs.slice(0, 3).map((e) => `- ${e}`));
    parts.push("");
  }

  const max = o.maxBytes ?? 24_000;
  let text = parts.join("\n");
  if (Buffer.byteLength(text) > max) text = `${Buffer.from(text).subarray(0, max).toString("utf8").replace(/�*$/, "")}\n… (relevé tronqué à ${max} octets)\n`;
  return { text, signals };
}

export const IMPROVE_PROMPT = `Scope of this run: one read-only review, delegated by an orchestrating session.
Do it directly in this run. I explicitly opt out of starting an orchestration or
delegation workflow. Do not modify any file.

Tu fais l'amélioration continue d'orch et de Kiba, son agent lead. Tu es dans
le dépôt orch, en lecture seule. Voici le relevé des dernières 24 heures :
routines en échec, lanes, et pour chaque session interactive les messages de
l'opérateur et les erreurs d'outils.

Repère ce qui revient ou ce qui a coûté : une correction de l'opérateur, une
consigne qu'il a dû répéter, une erreur d'outil répétée, une routine qui casse.
Lis le dépôt pour proposer un changement précis. Le changement porte sur orch
(code, catalogue, consignes du chef dans catalog/lead.md, hooks, routines)
ou sur une note de mémoire ; jamais sur le code d'un autre projet.

Au plus trois propositions, la plus utile d'abord, en français, chacune ainsi :
### 1. <titre court>
CONSTAT : ce qui s'est passé, avec la ligne du relevé qui le prouve.
CHANGEMENT : quoi modifier et dans quels fichiers.
VÉRIFICATION : comment on saura que c'est réglé.

Rien sans preuve dans le relevé. Si rien ne mérite un changement, réponds
seulement : RIEN.

RELEVÉ
`;

export interface ImproveDeps {
  projects: string;
  state?: string;
  now?: Date;
  choice: ModelChoice;
  timeoutMs: number;
  notify?: (notice: Notice) => Promise<void>;
  cwd?: string;
}

export const improveDir = (state = stateDir()) => join(state, "improve");

export function titles(proposals: string): string[] {
  return [...proposals.matchAll(/^###\s*(\d+)\.\s*(.+)$/gm)].map((m) => `${m[1]}. ${m[2].trim()}`);
}

// One day's proposals. Returns the proposals file, or null when the day left
// no evidence (no model call). A failed or empty model run throws: the routine
// journals it and alerts like any other failure.
export async function runImprove(d: ImproveDeps): Promise<{ path: string | null; titles: string[]; note: string }> {
  const now = d.now ?? new Date();
  const since = new Date(now.getTime() - 86_400_000);
  const digest = collect({ since, projects: d.projects, state: d.state });
  const dir = improveDir(d.state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = now.toISOString().slice(0, 10);
  if (!digest.signals) return { path: null, titles: [], note: "improve: nothing in the last 24 h worth a look, no model call" };
  const promptPath = join(dir, `${day}-prompt.md`);
  writeFileSync(promptPath, IMPROVE_PROMPT + digest.text, { mode: 0o600 });
  const lastPath = join(dir, `${day}-last.txt`);
  const logPath = join(dir, `${day}-worker.log`);
  writeFileSync(logPath, "");
  const call = workerArgv("claude", d.choice, { cwd: d.cwd ?? ROOT, promptPath, readOnly: true, lastMessagePath: lastPath });
  const run = await runLogged(call.argv, { cwd: d.cwd ?? ROOT, logPath, stdinPath: call.stdin ? promptPath : undefined, timeoutMs: d.timeoutMs, env: workerEnv() });
  const { message } = parseWorkerOutput("claude", readFileSync(logPath, "utf8"), existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "");
  if (run.timedOut || run.code !== 0 || !message.trim()) {
    throw new Error(`improve: model run ${run.timedOut ? "timed out" : run.code !== 0 ? `exited ${run.code}` : "gave no answer"} (log ${logPath})`);
  }
  const path = join(dir, `${day}.md`);
  writeFileSync(path, `# Propositions du ${day}\n\n${message.trim()}\n`, { mode: 0o600 });
  const found = titles(message);
  if (found.length && d.notify) {
    await d.notify({
      title: found.length === 1 ? "Une idée pour améliorer orch" : `${found.length} idées pour améliorer orch`, text: found.join("\n"),
      note: `Réponds « valide N » à Kiba pour en appliquer une. Le détail : \`orch improve show\` (${day}).`,
    });
  }
  return { path, titles: found, note: found.length ? `improve: ${found.length} proposal(s) in ${path}` : `improve: nothing proposed (${path})` };
}

export function latest(state = stateDir()): string | null {
  const dir = improveDir(state);
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  return days.length ? join(dir, days.at(-1)!) : null;
}
