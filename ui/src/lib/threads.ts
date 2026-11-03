// The atelier conversation as one thread per project: Kiba's words, the
// orch serve tasks and the lanes, a lane's start and end merged into one card. Pure, no React.
import type { DashTask } from "../types";
import type { LineTone, RoomLine, Speaker } from "./room";

export type ThreadFilter = "all" | "decisions" | "agents" | "errors";

export interface ThreadItem {
  key: string;
  /** First line of the item. */
  at: string;
  /** Latest line of the item; equals `at` for a single line. */
  until: string;
  project: string | null;
  speaker: Speaker;
  tone: LineTone;
  text: string;
  /** Lane card only: its steps in order, start to end. */
  steps: string[] | null;
  model: string | null;
  /** orch serve task card, with its lane folded in. */
  task: DashTask | null;
}

const OPEN = new Set(["working", "idle"]);
const FOR_PERSON = new Set(["blocked", "person/answer", "person/review"]);

export function taskRunning(task: DashTask): boolean {
  return OPEN.has(task.state);
}

export interface ProjectThread {
  /** Null gathers lines with no project. */
  project: string | null;
  items: ThreadItem[];
  /** Time of the latest item, null for a project nobody spoke in. */
  until: string | null;
}

/** One thread per project, most recent first; quiet known projects follow by name. */
export function buildThreads(lines: RoomLine[], projects: string[], tasks: DashTask[] = [], now = Date.now()): ProjectThread[] {
  const byProject = new Map<string | null, ThreadItem[]>();
  const cards = new Map<string, ThreadItem>();
  // A lane run for a task shows inside the task's card, not as a card of its own.
  const owned = new Set<string>();
  for (const task of tasks) {
    if (task.progress) owned.add(task.progress.id);
    if (task.lane) owned.add(task.lane);
    const item = taskItem(task, now);
    if (!item) continue;
    const items = byProject.get(item.project) ?? [];
    byProject.set(item.project, items);
    items.push(item);
  }
  for (const line of lines) {
    if (line.speaker.kind === "lane" && line.speaker.id && owned.has(line.speaker.id)) continue;
    const items = byProject.get(line.project) ?? [];
    byProject.set(line.project, items);
    if (line.speaker.kind === "lane" && line.speaker.id && line.step) {
      const card = cards.get(line.speaker.id);
      if (card) {
        mergeStep(card, line);
        continue;
      }
      const fresh: ThreadItem = { ...itemOf(line), steps: [line.step], model: line.model ?? null, task: null };
      cards.set(line.speaker.id, fresh);
      items.push(fresh);
      continue;
    }
    items.push(itemOf(line));
  }
  const threads: ProjectThread[] = [...byProject].map(([project, items]) => {
    // A lane that just ended belongs at the bottom, where the news is.
    items.sort((a, b) => a.until.localeCompare(b.until));
    return { project, items, until: items.at(-1)?.until ?? null };
  });
  const spoken = new Set(threads.map((t) => t.project));
  for (const name of projects) if (!spoken.has(name)) threads.push({ project: name, items: [], until: null });
  return threads.sort((a, b) => {
    if (a.until && b.until) return b.until.localeCompare(a.until);
    if (a.until || b.until) return a.until ? -1 : 1;
    return (a.project ?? "").localeCompare(b.project ?? "");
  });
}

const speakerServe: Speaker = { kind: "lead", id: null, harness: null, name: "orch serve" };

function taskItem(task: DashTask, now: number): ThreadItem | null {
  const at = task.createdAt;
  // A running task stays at the bottom of its thread, where the live work is.
  const until = taskRunning(task) ? new Date(Math.max(now, Date.parse(at))).toISOString() : task.updatedAt;
  const tone: LineTone = task.state === "ended" ? (task.deliveredRevision ? "done" : "say") : FOR_PERSON.has(task.state) ? "fail" : "say";
  return {
    key: `task:${task.id}`, at, until, project: task.project, speaker: speakerServe,
    tone, text: task.objective, steps: null, model: null, task,
  };
}

function itemOf(line: RoomLine): ThreadItem {
  return {
    key: line.key,
    at: line.at,
    until: line.at,
    project: line.project,
    speaker: line.speaker,
    tone: line.tone,
    text: line.text,
    steps: null,
    model: null,
    task: null,
  };
}

function mergeStep(card: ThreadItem, line: RoomLine): void {
  if (line.at > card.until) card.until = line.at;
  if (line.at < card.at) card.at = line.at;
  if (line.model && !card.model) card.model = line.model;
  if (line.step && !card.steps?.includes(line.step)) card.steps = [...(card.steps ?? []), line.step];
  // "prise" says nothing once the lane is known to be running.
  if (card.steps && card.steps.length > 1) card.steps = card.steps.filter((s) => s !== "prise");
  if (line.tone === "done" || line.tone === "fail") card.tone = line.tone;
  card.text = card.steps?.join(" → ") ?? card.text;
}

export function matches(item: ThreadItem, filter: ThreadFilter): boolean {
  if (filter === "all") return true;
  if (filter === "agents") return item.speaker.kind === "lane" || item.task != null;
  if (filter === "errors") return item.tone === "error" || item.tone === "fail";
  return item.tone === "decision" || item.tone === "next";
}

/** Items newer than the last time this thread was read. */
export function unread(thread: ProjectThread, seen: string | undefined): number {
  if (!seen) return 0;
  const since = Date.parse(seen);
  // A running task's `until` follows the clock: its last real change counts.
  return thread.items.filter((item) => Date.parse(item.task?.updatedAt ?? item.until) > since).length;
}

export function threadName(project: string | null): string {
  return project ?? "Général";
}

/** "Aujourd'hui", "Hier", else "lundi 2 nov.". */
export function dayLabel(iso: string, now = Date.now()): string {
  const day = startOfDay(Date.parse(iso));
  const today = startOfDay(now);
  if (day === today) return "Aujourd'hui";
  if (Math.round((today - day) / DAY_MS) === 1) return "Hier";
  return new Date(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(Date.parse(a)) === startOfDay(Date.parse(b));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
