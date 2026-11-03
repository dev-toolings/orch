// Toy repository and features of bench/versus, kept from the retired
// architecture bench (archived on the `archive/benches` branch): reading,
// deterministic noise expansion (seed) and on-the-fly toy repository.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type Size = "mechanical" | "normal" | "risky";
export type FollowupKind = "comment" | "ci_fail" | "ci_pass" | "cancel";
export type Family = "opus" | "sonnet" | "haiku" | "other";

export interface TaskSpec {
  id: string; at: number; size: Size; mechanical: boolean;
  files: string[]; objective: string; accept: string;
}
export interface FollowupSpec { id: string; at: number; task: string; kind: FollowupKind; text: string }
export interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number }
export interface Cost extends Tokens { seconds: number }

export interface MockParams {
  laneSlots: number;
  leadTurn: Cost;
  leadContextGrowth: number;
  leadContextMax: number;
  laneStartup: Cost;
  exec: Record<Size, Cost>;
  effortFactor: Record<string, number>;
  modelSpeed: Record<string, number>;
  followup: Record<FollowupKind, Cost>;
  success: Record<string, Record<Size, number>>;
  laneModels: Record<string, Family>;
  maxAttempts: number;
  // Écart de probabilité de réussite par effort (medium = 0), ajouté à `success`.
  effortSuccess: Record<string, Record<Size, number>>;
  // Effort du lead quand il exécute lui-même (profil max20 : high).
  leadEffort: string;
  matrix: { trials: number; successThreshold: number };
  // Architecture D (routeur rapide) : lead compact, lanes chaudes, échelle.
  kiba: KibaMock;
}

export interface KibaMock {
  // Un tour de lead par modèle (contexte compact : une ligne par événement).
  leadTurn: Record<"sonnet" | "opus", Cost>;
  leadEffort: string;
  leadContextGrowth: number;
  leadContextWindow: number;
  // Taille de l'état compact d'une session lead fraîche.
  freshStateTokens: number;
  // Part des tours où le lead lit le fichier de détail de l'événement.
  detailReadRate: number;
  detailRead: Cost;
  // Part des sorties du lead hors liste fermée (refusées et comptées).
  invalidRate: number;
  laneStartupCold: Cost;
  laneStartupWarm: Cost;
  // Délai de remise à zéro du worktree et de relance d'un worker chaud.
  refillSeconds: number;
  // Instructions courtes du worker : part du contexte d'exécution gardée.
  workerContextFactor: number;
  // Part des tentatives qui se bloquent (le chien de garde les tue).
  hangRate: number;
  // Surcharge partielle de DEFAULT_KIBA (src/kiba/rules.ts).
  config: Record<string, unknown>;
}

export const SIZES: Size[] = ["mechanical", "normal", "risky"];

// Sous-charge restreinte à certains types de tâche (suivis et bruit suivent).
export function filterTaskTypes(w: Workload, sizes: Size[]): Workload {
  const tasks = w.tasks.filter((t) => sizes.includes(t.size));
  if (!tasks.length) throw new Error(`aucune tâche de type ${sizes.join(", ")} dans la charge`);
  const keep = new Set(tasks.map((t) => t.id));
  return { ...w, tasks, followups: w.followups.filter((f) => keep.has(f.task)) };
}

export interface Workload {
  version: number; name: string; seed: number;
  toyRepo: Record<string, string>;
  tasks: TaskSpec[];
  followups: FollowupSpec[];
  noise: { chatter: number; comments: number; ciPass: number; horizon: number; chatterTexts: string[]; commentTexts: string[] };
  mock: MockParams;
}

// Un événement de l'horaire : une vraie demande, du bavardage ou un suivi d'une tâche.
export type BenchEvent =
  | { id: string; at: number; kind: "task"; task: string; noise: false }
  | { id: string; at: number; kind: "chatter"; text: string; noise: true }
  | { id: string; at: number; kind: "followup"; task: string; followup: FollowupKind; text: string; noise: boolean };

export const WORKLOAD_PATH = join(import.meta.dir, "workload.json");

export function loadWorkload(path = WORKLOAD_PATH): Workload {
  const w = JSON.parse(readFileSync(path, "utf8")) as Workload;
  const ids = new Set(w.tasks.map((t) => t.id));
  if (ids.size !== w.tasks.length) throw new Error("workload: identifiants de tâche en double");
  for (const f of w.followups) if (!ids.has(f.task)) throw new Error(`workload: ${f.id} vise une tâche inconnue ${f.task}`);
  for (const t of w.tasks) if (!t.files.length) throw new Error(`workload: ${t.id} sans FILES`);
  return w;
}

export function workloadHash(w: Workload): string {
  return createHash("sha256").update(JSON.stringify(w)).digest("hex").slice(0, 16);
}

// PRNG déterministe (mulberry32) : même seed, même horaire.
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tirage stable par clé : la même tentative d'une même tâche tire la même
// valeur dans les trois architectures (nombres aléatoires communs).
export function draw(seed: number, key: string): number {
  return createHash("sha256").update(`${seed}:${key}`).digest().readUInt32BE(0) / 4294967296;
}

// Horaire complet trié : tâches, suivis scriptés, puis le bruit généré par la seed.
// Un suivi bruité vise une tâche déjà arrivée au moment où il tombe.
export function expandEvents(w: Workload): BenchEvent[] {
  const rnd = prng(w.seed);
  const out: BenchEvent[] = [];
  for (const t of w.tasks) out.push({ id: `ev-${t.id}`, at: t.at, kind: "task", task: t.id, noise: false });
  for (const f of w.followups) out.push({ id: f.id, at: f.at, kind: "followup", task: f.task, followup: f.kind, text: f.text, noise: f.kind === "ci_pass" });
  const at = () => Math.floor(rnd() * w.noise.horizon);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < w.noise.chatter; i++) out.push({ id: `N-chat-${i}`, at: at(), kind: "chatter", text: pick(w.noise.chatterTexts), noise: true });
  const gen = (n: number, kind: "comment" | "ci_pass", prefix: string, text: () => string) => {
    for (let i = 0; i < n; i++) {
      const t = at();
      const arrived = w.tasks.filter((x) => x.at <= t);
      if (!arrived.length) continue;
      const task = pick(arrived);
      out.push({ id: `${prefix}-${i}`, at: t, kind: "followup", task: task.id, followup: kind, text: text(), noise: true });
    }
  };
  gen(w.noise.comments, "comment", "N-com", () => pick(w.noise.commentTexts));
  gen(w.noise.ciPass, "ci_pass", "N-ci", () => "CI verte");
  // Ordre total stable : heure, puis vraie demande avant bruit, puis id.
  return out.sort((a, b) => a.at - b.at || Number(a.noise) - Number(b.noise) || a.id.localeCompare(b.id));
}

// Sous-charge bornée pour le mode real : les N premières tâches et seulement
// les événements qui les visent, plus le bavardage jusqu'à la dernière arrivée.
export function limitWorkload(w: Workload, maxTasks: number): Workload {
  const tasks = [...w.tasks].sort((a, b) => a.at - b.at).slice(0, Math.max(1, maxTasks));
  const keep = new Set(tasks.map((t) => t.id));
  const last = Math.max(...tasks.map((t) => t.at));
  const ratio = w.noise.horizon ? Math.min(1, (last + 600) / w.noise.horizon) : 1;
  return {
    ...w, tasks, followups: w.followups.filter((f) => keep.has(f.task)),
    noise: { ...w.noise, horizon: Math.min(w.noise.horizon, last + 600), chatter: Math.round(w.noise.chatter * ratio), comments: Math.round(w.noise.comments * ratio), ciPass: Math.round(w.noise.ciPass * ratio) },
  };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
}

// Vrai si `path` est sous le dossier temporaire du système (jamais un vrai projet).
export function underTmp(path: string): boolean {
  return underDir(path, tmpdir());
}

// Vrai si `path` (existant) est `root` ou dessous, liens symboliques résolus.
export function underDir(path: string, root: string): boolean {
  const r = realpathSync(resolve(root));
  const p = realpathSync(resolve(path));
  return p === r || p.startsWith(r + sep);
}

// Dépôt jouet neuf : mkdtemp + git init + un commit initial, sous `parent`.
// Refuse tout emplacement hors de `parent` ou hors du dossier temporaire (ou /tmp).
export function createToyRepo(w: Workload, prefix = "orch-arch-toy-", parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, prefix));
  if (!underDir(dir, parent) || !(underTmp(dir) || underDir(dir, "/tmp"))) throw new Error(`dépôt jouet hors de ${parent} : ${dir}`);
  for (const [rel, content] of Object.entries(w.toyRepo)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=orch-bench", "-c", "user.email=bench@localhost", "commit", "-q", "-m", "toy: initial");
  return dir;
}
