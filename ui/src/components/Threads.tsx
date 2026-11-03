import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DashLead, Selection } from "../types";
import type { LineTone } from "../lib/room";
import { harnessLabel, money, when } from "../lib/format";
import {
  clock, dayLabel, taskRunning, matches, sameDay, threadName, unread,
  type ProjectThread, type ThreadFilter, type ThreadItem,
} from "../lib/threads";
import { AgentBloub } from "./Bloub";
import { TaskCard } from "./TaskCard";

const toneLabel: Partial<Record<LineTone, string>> = {
  decision: "Décision",
  next: "Ensuite",
  error: "Erreur",
};

const toneText: Record<LineTone, string> = {
  say: "text-foreground",
  decision: "text-foreground",
  next: "text-foreground",
  error: "text-destructive",
  done: "text-success",
  fail: "text-destructive",
};

const FILTERS: { key: ThreadFilter; label: string }[] = [
  { key: "all", label: "Tout" },
  { key: "decisions", label: "Décisions" },
  { key: "agents", label: "Sous-agents" },
  { key: "errors", label: "Erreurs" },
];

/** One row per project: its Kiba, unread count and last word. */
export function ThreadList({
  threads,
  open,
  onOpen,
  seen,
  leads,
}: {
  threads: ProjectThread[];
  open: string | null;
  onOpen: (project: string | null) => void;
  seen: Record<string, string>;
  leads: DashLead[];
}) {
  const leadOf = (project: string | null) => leads.find((row) => row.project === project);
  // "Fils" lists the projects a Kiba runs in; every other one, history included,
  // stays under "Au repos" and opens in place there.
  const isQuiet = (t: ProjectThread) => !leadOf(t.project);
  const lively = threads.filter((t) => !isQuiet(t));
  const quiet = threads.filter(isQuiet);

  // A render helper, not a component: a nested component would remount every row on each snapshot.
  const row = (thread: ProjectThread) => {
    const name = threadName(thread.project);
    const lead = leadOf(thread.project);
    const count = thread.project === open ? 0 : unread(thread, seen[name]);
    const last = thread.items.at(-1);
    const active = thread.project === open;
    const running = thread.items.filter((item) => item.task && taskRunning(item.task)).length;
    // Today's task work in one line: what a glance at the list should answer.
    const today = thread.items.filter((item) => item.task && sameDay(item.at, new Date().toISOString()));
    const failedToday = today.filter((item) => item.tone === "fail").length;
    const costToday = today.reduce((n, item) => n + (item.task?.costUsd ?? 0), 0);
    const summary = today.length
      ? [running ? `${running} au travail` : null, failedToday ? `${failedToday} échec${failedToday > 1 ? "s" : ""}` : null, costToday ? money(costToday) : null, !running && !failedToday ? `${today.length} tâche${today.length > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")
      : null;
    return (
      <button
        key={name}
        type="button"
        onClick={() => onOpen(thread.project)}
        aria-current={active ? "true" : undefined}
        className={`grid shrink-0 grid-cols-[1.75rem_1fr_auto] items-center gap-x-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring lg:w-full ${active ? "bg-muted" : ""}`}
      >
        <span aria-hidden className={`block h-7 w-7 ${lead ? "" : "opacity-40 grayscale"}`}>
          <AgentBloub harness={lead?.harness ?? null} activity={lead?.activity} role="lead" size={28} still={!lead} />
        </span>
        <span className="min-w-0">
          <span className={`block truncate text-[13px] ${count ? "font-semibold" : "font-medium"}`}>{name}</span>
          <span className="hidden truncate text-xs text-muted-foreground lg:block">
            {summary
              ? <span className={running ? "font-medium text-success" : failedToday ? "text-destructive" : undefined}>{summary}</span>
              : last ? last.text : lead ? "Kiba est là, rien dit encore" : "Au repos"}
          </span>
        </span>
        {running ? (
          <span aria-hidden className="relative inline-flex h-2.5 w-2.5">
            <span className="flux-ping absolute inline-flex h-full w-full rounded-full bg-success/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
          </span>
        ) : count ? (
          <span className="min-w-5 rounded-full bg-foreground px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums text-background" aria-label={`${count} non lus`}>
            {count}
          </span>
        ) : last ? (
          <time className="hidden text-[11px] tabular-nums text-muted-foreground lg:block" dateTime={last.until}>{clock(last.until)}</time>
        ) : <span />}
      </button>
    );
  };

  return (
    <nav aria-label="Fils par projet" className="atelier-thread flex min-h-0 gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto">
      <h2 className="hidden px-2 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground lg:block">Fils</h2>
      {lively.map(row)}
      {quiet.length ? (
        <details className="shrink-0 lg:mt-2" open={quiet.some((t) => t.project === open) ? true : undefined}>
          <summary className="cursor-pointer list-none rounded-lg px-2 py-2 text-xs text-muted-foreground hover:text-foreground">
            Au repos ({quiet.length})
          </summary>
          <div className="flex gap-1 lg:flex-col">
            {quiet.map(row)}
          </div>
        </details>
      ) : null}
    </nav>
  );
}

/** The open thread as a messenger: day separators, filters, folded long notes. */
export function ThreadView({
  thread,
  selection,
  onSelect,
}: {
  thread: ProjectThread | null;
  selection: Selection;
  onSelect: (next: Selection) => void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>("all");
  const items = useMemo(() => (thread?.items ?? []).filter((item) => matches(item, filter)), [thread, filter]);
  const counts = useMemo(() => {
    const all = thread?.items ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((item) => matches(item, f.key)).length])) as Record<ThreadFilter, number>;
  }, [thread]);
  const list = useRef<HTMLOListElement>(null);
  const last = items.at(-1);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.project, filter, last?.key, last?.until]);

  return (
    <section aria-label={`Fil ${threadName(thread?.project ?? null)}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">{thread ? threadName(thread.project) : "Conversation"}</h2>
        <div role="group" aria-label="Filtrer le fil" className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              disabled={f.key !== "all" && counts[f.key] === 0}
              className={`rounded-full px-2.5 py-0.5 text-xs transition-colors disabled:opacity-40 ${filter === f.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {f.label}{f.key !== "all" && counts[f.key] ? <span className="ml-1 tabular-nums">{counts[f.key]}</span> : null}
            </button>
          ))}
        </div>
      </header>
      <ol ref={list} className="atelier-thread relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <li className="px-2 py-6 text-sm text-muted-foreground">
            {thread?.items.length
              ? "Rien pour ce filtre dans ce fil."
              : "Personne n'a encore parlé ici. Les décisions, erreurs et lanes de Kiba apparaîtront dans ce fil."}
          </li>
        ) : null}
        {items.map((item, i) => {
          const prev = items[i - 1];
          const newDay = !prev || !sameDay(prev.until, item.until);
          const followUp = !newDay && !!prev && prev.speaker.name === item.speaker.name && item.steps == null && prev.steps == null
            && item.task == null && prev.task == null
            && Date.parse(item.at) - Date.parse(prev.until) < GROUP_GAP_MS;
          return (
            <li key={item.key}>
              {newDay ? <DaySeparator iso={item.until} /> : null}
              <Message item={item} followUp={followUp} selection={selection} onSelect={onSelect} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const GROUP_GAP_MS = 10 * 60 * 1000;

function DaySeparator({ iso }: { iso: string }) {
  const now = useNow(60 * 60 * 1000);
  return (
    <div role="separator" className="my-3 flex items-center gap-3 text-[11px] font-medium text-muted-foreground first:mt-0">
      <span className="h-px flex-1 bg-border" />
      {dayLabel(iso, now)}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Message({
  item,
  followUp,
  selection,
  onSelect,
}: {
  item: ThreadItem;
  followUp: boolean;
  selection: Selection;
  onSelect: (next: Selection) => void;
}) {
  const target: Selection = item.speaker.id ? { kind: item.speaker.kind, id: item.speaker.id } : null;
  const active = !!selection && selection.kind !== "project" && selection.id === item.speaker.id;
  const span = clock(item.until) !== clock(item.at) ? `${clock(item.at)} → ${clock(item.until)}` : clock(item.at);
  const lane = item.steps != null;
  const task = item.task;
  return (
    <article className={`grid grid-cols-[1.75rem_1fr] gap-x-3 rounded-lg px-2 ${followUp ? "pb-1" : "mt-2 pt-1.5 pb-1"} ${active ? "bg-muted/70" : ""}`}>
      <span className="pt-0.5">
        {followUp ? null : (
          <button
            type="button"
            disabled={!target}
            onClick={() => target && onSelect(target)}
            aria-label={`Voir ${item.speaker.name}`}
            className="block h-7 w-7 rounded-full focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <AgentBloub harness={item.speaker.harness} role={item.speaker.kind} size={28} still />
          </button>
        )}
      </span>
      <div className="min-w-0">
        {followUp ? null : (
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              disabled={!target}
              onClick={() => target && onSelect(target)}
              className="truncate text-[13px] font-semibold hover:underline disabled:cursor-default disabled:hover:no-underline"
            >
              {item.speaker.name}
            </button>
            {lane && item.speaker.harness ? <span className="sr-only">{harnessLabel(item.speaker.harness)}</span> : null}
            <time className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={item.until} title={item.until === item.at ? when(item.at) : `${when(item.at)} → ${when(item.until)}`}>
              {task && taskRunning(task) ? <Elapsed from={item.at} /> : span}
            </time>
          </div>
        )}
        {task ? <TaskCard task={task} /> : lane ? <LaneCard item={item} /> : <Folded item={item} />}
      </div>
    </article>
  );
}

function LaneCard({ item }: { item: ThreadItem }) {
  const steps = item.steps ?? [];
  return (
    <p className="mt-1 inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-md border border-border px-2.5 py-1 text-[13px] leading-5">
      {item.model ? <span className="text-muted-foreground">{item.model} ·</span> : null}
      {steps.map((step, i) => {
        const end = i === steps.length - 1;
        return (
          <span key={step} className="inline-flex items-center gap-1.5">
            {i ? <span aria-hidden className="text-muted-foreground">→</span> : null}
            <span className={end ? `font-medium ${toneText[item.tone]}` : "text-muted-foreground"}>{step}</span>
          </span>
        );
      })}
    </p>
  );
}

/** Live "depuis 1 min 05" for a running task. */
function Elapsed({ from }: { from: string }) {
  const now = useNow(1000);
  const sec = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  const text = sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, "0")}`;
  return <span className="text-success">{clock(from)} · depuis {text}</span>;
}

const FOLD_CHARS = 280;

function Folded({ item, label }: { item: Pick<ThreadItem, "text" | "tone">; label?: string }) {
  const [open, setOpen] = useState(false);
  const long = item.text.length > FOLD_CHARS || item.text.split("\n").length > 4;
  return (
    <div className={`mt-0.5 text-[13px] leading-5 break-words whitespace-pre-line ${toneText[item.tone]}`}>
      <p className={long && !open ? "line-clamp-3" : undefined}>
        {label ?? toneLabel[item.tone] ? <span className="font-medium text-muted-foreground">{label ?? toneLabel[item.tone]} : </span> : null}
        {item.text}
      </p>
      {long ? (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          {open ? "voir moins" : "voir plus"}
        </button>
      ) : null}
    </div>
  );
}

/** Last-read time per thread, kept in this browser. */
export function useSeen(threads: ProjectThread[], open: string | null): Record<string, string> {
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  useEffect(() => {
    setSeen((prev) => {
      let next = prev;
      for (const thread of threads) {
        const name = threadName(thread.project);
        // A thread met for the first time starts read; the open one stays read.
        if (prev[name] == null) next = { ...next, [name]: thread.until ?? BOOT };
        else if (thread.project === open && thread.until && Date.parse(prev[name]) < Date.parse(thread.until)) {
          next = { ...next, [name]: thread.until };
        }
      }
      if (next !== prev) writeSeen(next);
      return next;
    });
  }, [threads, open]);
  return seen;
}

const SEEN_KEY = "orch.atelier.seen";
const BOOT = new Date().toISOString();

function readSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // private mode or full storage: unread counts just reset next visit
  }
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
