import { useState } from "react";
import { Link } from "react-router-dom";
import type { DashTask } from "../types";
import { money } from "../lib/format";
import { taskRunning } from "../lib/threads";

const TASK_STATE: Record<string, { label: string; tone: string }> = {
  working: { label: "Au travail", tone: "bg-success/15 text-success" },
  idle: { label: "En pause", tone: "bg-muted text-muted-foreground" },
  "person/answer": { label: "Question pour toi", tone: "bg-warning/15 text-warning" },
  "person/review": { label: "Revue à faire", tone: "bg-warning/15 text-warning" },
  blocked: { label: "Bloquée", tone: "bg-destructive/15 text-destructive" },
  ended: { label: "Terminée", tone: "bg-muted text-muted-foreground" },
};

const NEXT_LABEL: Record<string, string> = {
  execute: "worker", verify: "VERIFY", review: "revue", deliver: "livraison", wait: "attente", none: "rien",
};

/**
 * An orch serve task: what was asked, its state and next action, the worker
 * session and its step, the lane VERIFY ran in and the delivery.
 */
export function TaskCard({ task }: { task: DashTask }) {
  const [open, setOpen] = useState(false);
  const state = TASK_STATE[task.state] ?? { label: task.state, tone: "bg-muted text-muted-foreground" };
  const running = taskRunning(task);
  const p = task.progress;
  const doing = p?.lastFile ? `${p.lastTool ?? ""} ${p.lastFile.split("/").pop()}`.trim() : (p?.lastText ?? "").replace(/\s+/g, " ").slice(0, 80);
  const long = task.objective.length > 160;

  return (
    <section
      id={`task-${task.id}`}
      tabIndex={-1}
      aria-label={`Tâche ${task.id}`}
      className="mt-1 rounded-xl border border-border text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 pt-3">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-balance">Tâche <span className="font-mono">{task.id}</span></h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.tone}`}>{state.label}</span>
        <span className="tabular-nums text-sm font-medium">{task.costUsd != null ? money(task.costUsd) : running ? "en cours" : "coût non relevé"}</span>
      </header>
      <p className="flex flex-wrap gap-x-2 px-3.5 pt-0.5 text-xs text-muted-foreground">
        <span>révision {task.revision}{task.deliveredRevision ? ` (livrée ${task.deliveredRevision})` : ""}</span>
        <span>ensuite : {NEXT_LABEL[task.next] ?? task.next}</span>
        {task.failures ? <span>{task.failures} échec{task.failures > 1 ? "s" : ""}</span> : null}
        <span className="font-mono" title="session du worker">{task.session.slice(0, 8)}{task.sessionStarted ? "" : " (pas démarrée)"}</span>
      </p>

      <div className="px-3.5 pt-2">
        <p className={`text-muted-foreground ${long && !open ? "line-clamp-2" : ""}`}>
          <span className="font-medium text-foreground/80">Demande : </span>{task.objective}
        </p>
        {long ? (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs font-medium text-muted-foreground hover:text-foreground">
            {open ? "voir moins" : "voir plus"}
          </button>
        ) : null}
      </div>

      {running ? (
        <p className="mx-3.5 mt-2 flex items-center gap-2 text-xs text-success">
          <span aria-hidden className="relative inline-flex h-2 w-2">
            <span className="flux-ping absolute inline-flex h-full w-full rounded-full bg-success/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          {task.job ? `${task.job.kind} ${task.job.status}` : "en attente d'une étape"}
          {p ? ` · ${[p.phase, p.turns != null ? `${p.turns} tours` : null, doing || null].filter(Boolean).join(" · ")}` : ""}
        </p>
      ) : null}

      {task.failure ? <p className="px-3.5 pt-2 text-destructive">{task.failure}</p> : null}
      {task.lastEvidence ? <p className="px-3.5 pt-2 text-xs text-muted-foreground line-clamp-2">Dernière preuve : {task.lastEvidence}</p> : null}

      <footer className="flex flex-wrap gap-x-4 gap-y-1 px-3.5 pt-2 pb-3 text-xs">
        {task.lane ? <span>lane : <Link to={`/runs/${encodeURIComponent(task.lane)}`} className="font-mono underline decoration-border underline-offset-2 hover:decoration-foreground">{task.lane}</Link></span> : null}
        {task.branch ? <span>branche : <span className="font-mono">{task.branch}</span></span> : null}
        {task.pr ? <a href={task.pr} className="underline decoration-border underline-offset-2 hover:decoration-foreground">PR</a> : null}
      </footer>
    </section>
  );
}
