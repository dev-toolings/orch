import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadMemoryDir, stateDir } from "../core/paths.ts";
import { type ModelChoice, ROOT } from "../core/profile.ts";
import { parseWorkerOutput, workerArgv } from "../harness/harness.ts";
import { runLogged, workerEnv } from "../harness/proc.ts";
import { collect } from "../improve/improve.ts";
import type { Notice } from "../presence/notify.ts";

export const MEMORY_CAP = 2200;
export const USER_CAP = 1375;

export const reflectDir = (state = stateDir()) => join(state, "reflect");
export { leadMemoryDir };

export interface Candidate {
  n: number;
  text: string;
  date: string;
  evidence: string;
  status: "pending" | "accepted" | "rejected";
  kind?: "add" | "remove";  // remove: the text is the start of the USER.md line to drop
}

const candidatesPath = (state = stateDir()) => join(reflectDir(state), "candidates.json");
const userPath = (state = stateDir()) => join(leadMemoryDir(state), "USER.md");
const memoryPath = (state = stateDir()) => join(leadMemoryDir(state), "MEMORY.md");

export function readCandidates(state = stateDir()): Candidate[] {
  const path = candidatesPath(state);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Candidate[] : [];
}

export function writeCandidates(list: Candidate[], state = stateDir()): void {
  mkdirSync(reflectDir(state), { recursive: true, mode: 0o700 });
  writePrivate(candidatesPath(state), `${JSON.stringify(list, null, 2)}\n`);
}

export interface Parsed {
  memory: string | null;
  user: { text: string; evidence: string; kind: "add" | "remove" }[];
  skills: { name: string; body: string }[];
  nothing: boolean;
}

function isNoopSentinel(value: string): boolean {
  return ["rien", "nothing", "none", "(rien)", "(nothing)", "(none)"]
    .includes(value.trim().toLowerCase());
}

export function parseReflection(message: string): Parsed {
  if (isNoopSentinel(message)) return { memory: null, user: [], skills: [], nothing: true };
  const sections = new Map<string, string[]>();
  let section: string | undefined;
  for (const line of message.trim().replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^## (MEMORY|USER|SKILLS)\s*$/.exec(line.trim());
    if (heading) {
      section = heading[1];
      sections.set(section, []);
    } else if (section) sections.get(section)!.push(line);
  }

  const memoryBody = sections.get("MEMORY")?.join("\n").trim() ?? "";
  const user = (sections.get("USER") ?? []).flatMap((line) => {
    const kind = line.startsWith("- ") ? "add" as const : line.startsWith("x ") ? "remove" as const : null;
    if (!kind) return [];
    const [text, ...evidence] = line.slice(2).split(" || ");
    const candidate = text.trim();
    return candidate ? [{ text: candidate, evidence: evidence.join(" || ").trim(), kind }] : [];
  });

  const skills: Parsed["skills"] = [];
  let skillName: string | undefined;
  let skillLines: string[] = [];
  const saveSkill = () => {
    const body = skillLines.join("\n").trim();
    if (skillName && body) skills.push({ name: skillName, body });
  };
  for (const line of sections.get("SKILLS") ?? []) {
    const heading = /^###\s+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      saveSkill();
      skillName = heading[1];
      skillLines = [];
    } else if (skillName) skillLines.push(line);
  }
  saveSkill();

  return { memory: memoryBody && !isNoopSentinel(memoryBody) ? memoryBody : null, user, skills, nothing: false };
}

export interface MemoryGuard { ok: boolean; reason?: string }

export function guardMemory(previous: string, next: string): MemoryGuard {
  if (!next.trim()) return { ok: false, reason: "new MEMORY.md is empty" };
  if (next.length > MEMORY_CAP) return { ok: false, reason: `new MEMORY.md is ${next.length} characters, above the ${MEMORY_CAP} character cap` };
  if (previous.length > 0 && next.length < previous.length / 2) {
    return { ok: false, reason: `new MEMORY.md is shorter than half of the previous ${previous.length} characters` };
  }
  const available = new Map<string, number>();
  for (const line of next.split("\n")) {
    if (line.startsWith("- ")) available.set(line, (available.get(line) ?? 0) + 1);
  }
  let dropped = 0;
  for (const line of previous.split("\n").filter((item) => item.startsWith("- "))) {
    const count = available.get(line) ?? 0;
    if (count === 0) dropped++;
    else available.set(line, count - 1);
  }
  if (dropped > 3) return { ok: false, reason: `new MEMORY.md drops ${dropped} previous lines, above the limit of 3` };
  return { ok: true };
}

// MEMORY accepts only explicit deltas. Targets name the full text of one
// existing bullet so a short or repeated prefix cannot select the wrong line.
export function applyMemory(previous: string, section: string): string {
  if (isNoopSentinel(section)) return previous.trimEnd();
  const lines = section.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) throw new Error("MEMORY delta is empty; use (nothing) for no change");

  type Operation =
    | { kind: "add"; value: string }
    | { kind: "remove"; target: string }
    | { kind: "replace"; target: string; value: string };
  const operations: Operation[] = lines.map((line, index) => {
    const number = index + 1;
    if (line.startsWith("+ ")) {
      const value = line.slice(2);
      if (!value.trim() || value !== value.trim()) throw new Error(`MEMORY delta line ${number} has an empty or padded addition`);
      return { kind: "add", value };
    }
    if (line.startsWith("x ")) {
      const target = line.slice(2);
      if (!target || target !== target.trim()) throw new Error(`MEMORY delta line ${number} has an empty or padded target`);
      return { kind: "remove", target };
    }
    if (line.startsWith("~ ")) {
      const change = line.slice(2);
      const delimiter = " => ";
      const at = change.indexOf(delimiter);
      const target = at < 0 ? "" : change.slice(0, at);
      const value = at < 0 ? "" : change.slice(at + delimiter.length);
      if (at < 0 || change.indexOf(delimiter, at + delimiter.length) >= 0 || !target || !value.trim()
        || target !== target.trim() || value !== value.trim()) {
        throw new Error(`MEMORY delta line ${number} must be '~ exact existing bullet => replacement text'`);
      }
      return { kind: "replace", target, value };
    }
    throw new Error(`MEMORY delta line ${number} is not an explicit +, ~, or x operation`);
  });

  const changes = operations.filter((operation) => operation.kind !== "add");
  if (changes.length > 3) throw new Error(`MEMORY delta changes ${changes.length} old lines, above the limit of 3`);

  const oldLines = previous.trimEnd() ? previous.trimEnd().split("\n") : [];
  const targets = new Set<number>();
  const indexed = operations.map((operation) => {
    if (operation.kind === "add") return { operation, index: -1 };
    const matches = oldLines.flatMap((line, index) => line === `- ${operation.target}` ? [index] : []);
    if (!matches.length) throw new Error(`MEMORY delta target not found: ${operation.target}`);
    if (matches.length > 1) throw new Error(`MEMORY delta target is ambiguous: ${operation.target}`);
    const index = matches[0];
    if (targets.has(index)) throw new Error(`MEMORY delta targets the same old line more than once: ${operation.target}`);
    targets.add(index);
    return { operation, index };
  });

  const replaced = new Map<number, string>();
  const removed = new Set<number>();
  const additions: string[] = [];
  for (const { operation, index } of indexed) {
    if (operation.kind === "add") additions.push(`- ${operation.value}`);
    else if (operation.kind === "remove") removed.add(index);
    else replaced.set(index, `- ${operation.value}`);
  }
  const kept = oldLines.flatMap((line, index) => {
    if (removed.has(index)) return [];
    return [replaced.get(index) ?? line];
  });
  return [...kept, ...additions].join("\n").trimEnd();
}

export const REFLECT_PROMPT = `Scope of this run: one read-only reflection delegated by an orchestrating session.
Work directly in this run. Do not start an orchestration or delegation workflow.
Do not modify files. Return only the requested content.
+
You are Kiba, reflecting on the day. The report covers the last 24 hours:
operator messages, tool errors, failed routines, and lanes. Read the supplied
USER.md and MEMORY.md as well.
+
Those files are injected into the lead prompt. Write MEMORY and USER rules in
short English lines. Keep evidence in the language in which it was written.
+
Rules: retain only facts proved by a line in the report. Do not praise yourself
or invent outcomes. An operator correction is the strongest signal, followed
by a repaired failure, then a question asked more than once.
+
MEMORY: retain verified failures and repairs, decisions, and durable lessons.
Do not copy the file. Return changes only, one operation per line. "+ YYYY-MM-DD:
..." adds a line. "~ <full exact text of one existing bullet> => YYYY-MM-DD:
..." replaces that line. "x <full exact text of one existing bullet>" removes
it because it is obsolete. Targets must match one complete existing bullet
exactly. Remove or replace at most 3 old lines. MEMORY is limited to 2200
characters, and the remaining space is shown. If space is short, remove or
merge lines first. An oversized delta is refused as a whole and never
truncated. Use (nothing) when MEMORY needs no change.
Do not include personal data about third parties.
+
USER: propose only durable rules about the operator, their preferences, or how
they work. Every rule must contain " || " followed by the words that prove it.
Do not infer a rule from one isolated fact. If the report contradicts a rule in
USER.md, propose removing it with "x <full exact USER.md bullet> || evidence".
The operator decides whether to accept it.
+
SKILLS: propose a skill only if the operator explicitly asked for one in the
report, by naming a skill or asking for a procedure to be written. Otherwise
return (none). Rephrasing a rule as a procedure does not make it a skill.
+
Exact format:
## MEMORY
+ / ~ / x operations, or (nothing)
## USER
- rule || evidence
x full exact USER.md bullet || evidence
or (none)
## SKILLS
### kebab-case-name
draft content
or (none)
+
If nothing deserves to be retained, return only NOTHING.`;

// Use one context builder so the CLI preview matches the model input.
export function reflectionMaterials(state: string | undefined, digest: string): string {
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim() || "(vide)" : "(vide)";
  const proposed = readCandidates(state).map((c) => `- ${c.kind === "remove" ? "retirer : " : ""}${c.text} (${c.status})`);
  const memoryLen = existsSync(memoryPath(state)) ? readFileSync(memoryPath(state), "utf8").trimEnd().length : 0;
  return [
    "## USER.md", read(userPath(state)),
    "", `## MEMORY.md (${memoryLen} / ${MEMORY_CAP} caractères, place restante : ${Math.max(0, MEMORY_CAP - memoryLen)})`, read(memoryPath(state)),
    "", "## Règles déjà proposées (ne les répète pas, même reformulées)", ...(proposed.length ? proposed : ["(aucune)"]),
    "", "## Relevé", digest || "(vide)",
  ].join("\n");
}

export interface ReflectDeps {
  projects: string;
  state?: string;
  now?: Date;
  choice: ModelChoice;
  timeoutMs: number;
  notify?: (notice: Notice) => Promise<void>;
  cwd?: string;
}

export interface ReflectResult {
  path: string | null;
  memoryUpdated: boolean;
  memoryRefused?: string;
  candidates: Candidate[];
  skills: string[];
  note: string;
}

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function memoryDiff(previous: string, next: string): string[] {
  const oldLines = previous.trimEnd().split("\n").filter(Boolean);
  const newLines = next.trimEnd().split("\n").filter(Boolean);
  const rows = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      rows[i][j] = oldLines[i] === newLines[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const diff: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) { i++; j++; }
    else if (j < newLines.length && (i === oldLines.length || rows[i][j + 1] >= rows[i + 1][j])) diff.push(`+ ${newLines[j++]}`);
    else diff.push(`- ${oldLines[i++]}`);
  }
  return diff;
}

function userHasRule(user: string, text: string): boolean {
  return user.split("\n").some((line) => {
    if (line.trim() === text) return true;
    return /^- \d{4}-\d{2}-\d{2} : (.*)$/.exec(line)?.[1]?.trim() === text;
  });
}

// One day's reflection. Writes go only to the state directory after model output passes guards.
export async function runReflect(d: ReflectDeps): Promise<ReflectResult> {
  const now = d.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const digest = collect({ since: new Date(now.getTime() - 86_400_000), projects: d.projects, state: d.state });
  if (!digest.signals) return { path: null, memoryUpdated: false, candidates: [], skills: [], note: "reflect: nothing in the last 24 h, no model call" };

  const dir = reflectDir(d.state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptPath = join(dir, `${day}-prompt.md`);
  writePrivate(promptPath, `${REFLECT_PROMPT}\n\n${reflectionMaterials(d.state, digest.text)}\n`);
  const lastPath = join(dir, `${day}-last.txt`);
  const logPath = join(dir, `${day}-worker.log`);
  writePrivate(logPath, "");
  const cwd = d.cwd ?? ROOT;
  const call = workerArgv("claude", d.choice, { cwd, promptPath, readOnly: true, lastMessagePath: lastPath });
  const run = await runLogged(call.argv, { cwd, logPath, stdinPath: call.stdin ? promptPath : undefined, timeoutMs: d.timeoutMs, env: workerEnv() });
  const { message } = parseWorkerOutput("claude", readFileSync(logPath, "utf8"), existsSync(lastPath) ? readFileSync(lastPath, "utf8") : "");
  if (run.timedOut || run.code !== 0 || !message.trim()) {
    throw new Error(`reflect: model run ${run.timedOut ? "timed out" : run.code !== 0 ? `exited ${run.code}` : "gave no answer"} (log ${logPath})`);
  }

  const parsed = parseReflection(message);
  const previous = existsSync(memoryPath(d.state)) ? readFileSync(memoryPath(d.state), "utf8") : "";
  let memoryUpdated = false;
  let memoryRefused: string | undefined;
  let memoryStatus = "inchangé";
  let diff: string[] = [];
  if (parsed.memory !== null) {
    try {
      const body = applyMemory(previous, parsed.memory);
      const guard = guardMemory(previous, body);
      if (!guard.ok) {
        memoryRefused = guard.reason ?? "memory guard refused the delta";
        memoryStatus = `refusé : ${memoryRefused}`;
      } else if (previous.trimEnd() !== body) {
        mkdirSync(leadMemoryDir(d.state), { recursive: true, mode: 0o700 });
        writePrivate(memoryPath(d.state), `${body}\n`);
        diff = memoryDiff(previous, body);
        memoryUpdated = true;
        memoryStatus = "mis à jour";
      }
    } catch (error) {
      memoryRefused = error instanceof Error ? error.message : String(error);
      memoryStatus = `refusé : ${memoryRefused}`;
    }
  }

  const existing = readCandidates(d.state);
  const candidateKey = (kind: Candidate["kind"], text: string) => `${kind ?? "add"}:${text.trim()}`;
  const known = new Set(existing.map((candidate) => candidateKey(candidate.kind, candidate.text)));
  const currentUser = existsSync(userPath(d.state)) ? readFileSync(userPath(d.state), "utf8") : "";
  let n = existing.reduce((max, candidate) => Math.max(max, candidate.n), 0);
  const candidates: Candidate[] = [];
  for (const proposed of parsed.user) {
    const text = proposed.text.trim();
    const key = candidateKey(proposed.kind, text);
    if (!text || known.has(key)) continue;
    if (proposed.kind === "add" && userHasRule(currentUser, text)) continue;
    if (proposed.kind === "remove" && userLineStarting(currentUser, text) === null) continue;
    const candidate: Candidate = { n: ++n, text, date: day, evidence: proposed.evidence.trim(), status: "pending", kind: proposed.kind };
    existing.push(candidate);
    candidates.push(candidate);
    known.add(key);
  }
  if (candidates.length) writeCandidates(existing, d.state);

  const skillNames: string[] = [];
  for (const skill of parsed.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) continue;
    const path = join(dir, "skills", `${skill.name}.md`);
    mkdirSync(join(dir, "skills"), { recursive: true, mode: 0o700 });
    writePrivate(path, `# ${skill.name} (brouillon du ${day}, à valider)\n\n${skill.body.trim()}\n`);
    skillNames.push(skill.name);
  }

  const path = join(dir, `${day}.md`);
  const report = [
    `# Réflexion du ${day}`, "", "## MEMORY.md", memoryStatus,
    ...(memoryUpdated ? diff : []), "", "## Règles à valider",
    ...(candidates.length ? candidates.map((candidate) => `${candidate.n}. ${candidate.kind === "remove" ? "retirer : " : ""}${candidate.text} (preuve : ${candidate.evidence})`) : ["(aucune)"]),
    "", "## Skills proposés",
    ...(skillNames.length ? skillNames.map((name) => `- ${name} : ${join(dir, "skills", `${name}.md`)}`) : ["(aucun)"]),
    "",
  ].join("\n");
  writePrivate(path, report);

  const happened = memoryUpdated || !!memoryRefused || candidates.length > 0 || skillNames.length > 0;
  if (happened && d.notify) {
    const notificationMemoryStatus = memoryUpdated ? "mis à jour" : memoryRefused ? "refusé" : "inchangé";
    const text = [
      `MEMORY.md : ${notificationMemoryStatus}`,
      `${candidates.length} règle(s) à valider : ${candidates.length ? candidates.map((candidate) => clip(candidate.text, 80)).join(", ") : "aucune"}`,
      `${skillNames.length} skill(s) proposé(s) : ${skillNames.length ? skillNames.join(", ") : "aucun"}`,
    ].join("\n");
    await d.notify({
      title: `Réflexion du ${day}`,
      text,
      note: "Réponds « accepte N » ou « rejette N » à Kiba ; le détail : `orch reflect show`.",
    });
  }

  const note = happened
    ? `reflect: ${memoryStatus}, ${candidates.length} candidate(s), ${skillNames.length} skill(s) in ${path}`
    : `reflect: nothing to record (${path})`;
  return { path, memoryUpdated, memoryRefused, candidates, skills: skillNames, note };
}

// Index of the first "- " line of USER.md whose text starts with `start`, null when none.
export function userLineStarting(user: string, start: string): number | null {
  const index = user.split("\n").findIndex((l) => l.startsWith("- ") && l.slice(2).trim().startsWith(start.trim()));
  return index >= 0 ? index : null;
}

export function acceptCandidate(n: number, state = stateDir()): { line: string; user: string } {
  const list = readCandidates(state);
  const candidate = list.find((entry) => entry.n === n);
  if (!candidate) throw new Error(`reflect accept: unknown candidate ${n}`);
  if (candidate.status !== "pending") throw new Error(`reflect accept: candidate ${n} is ${candidate.status}`);
  const path = userPath(state);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (candidate.kind === "remove") {
    // the line leaves the injected file but stays in a dated history (OpenClaw-style superseded directives)
    const index = userLineStarting(previous, candidate.text);
    if (index === null) throw new Error(`reflect accept: no USER.md line starts with "${candidate.text}"`);
    const lines = previous.split("\n");
    const [removed] = lines.splice(index, 1);
    writePrivate(path, lines.join("\n"));
    mkdirSync(reflectDir(state), { recursive: true, mode: 0o700 });
    appendFileSync(join(reflectDir(state), "USER.history.md"), `${new Date().toISOString().slice(0, 10)} superseded: ${removed}\n`, { mode: 0o600 });
    candidate.status = "accepted";
    writeCandidates(list, state);
    return { line: removed, user: lines.join("\n") };
  }
  const line = `- ${candidate.date} : ${candidate.text}`;
  const user = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${line}\n`;
  if (user.length > USER_CAP) throw new Error(`reflect accept: USER.md would exceed ${USER_CAP} characters (${user.length}): shorten a rule first`);
  mkdirSync(leadMemoryDir(state), { recursive: true, mode: 0o700 });
  writePrivate(path, user);
  candidate.status = "accepted";
  writeCandidates(list, state);
  return { line, user };
}

export function rejectCandidate(n: number, state = stateDir()): Candidate {
  const list = readCandidates(state);
  const candidate = list.find((entry) => entry.n === n);
  if (!candidate) throw new Error(`reflect reject: unknown candidate ${n}`);
  if (candidate.status !== "pending") throw new Error(`reflect reject: candidate ${n} is ${candidate.status}`);
  candidate.status = "rejected";
  writeCandidates(list, state);
  return candidate;
}

export function latest(state = stateDir()): string | null {
  const dir = reflectDir(state);
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort();
  return days.length ? join(dir, days.at(-1)!) : null;
}
