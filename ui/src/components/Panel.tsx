import { Link } from "react-router-dom";
import type { DashLane, DashLead, DashSnapshot, Selection } from "../types";
import { harnessLabel, money, uptime, when } from "../lib/format";
import { ActivityPill, StatusPill } from "./Status";

export function Panel({
  snap,
  selection,
  onClose,
}: {
  snap: DashSnapshot;
  selection: Selection;
  onClose: () => void;
}) {
  if (!selection) return null;
  const lead = selection.kind === "lead" ? snap.leads.find((row) => row.id === selection.id) : undefined;
  const lane = selection.kind === "lane" ? snap.lanes.find((row) => row.id === selection.id) : undefined;
  const project = selection.kind === "project"
    ? snap.projects.find((row) => row.name === selection.name)
    : undefined;

  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-border bg-card text-card-foreground"
      aria-label="Détail"
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          {lead ? lead.project : lane ? "Lane" : project?.name}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          Fermer
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
        {lead ? <LeadDetail lead={lead} snap={snap} /> : null}
        {lane ? <LaneDetail lane={lane} /> : null}
        {project ? <ProjectSummary name={project.name} snap={snap} /> : null}
      </div>
    </aside>
  );
}

function LeadDetail({ lead, snap }: { lead: DashLead; snap: DashSnapshot }) {
  const workers = snap.lanes.filter((lane) => lane.project === lead.project && (lane.status === "running" || lane.status === "blocked"));
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-[0.95rem]">
      <dt className="text-muted-foreground">État</dt><dd><ActivityPill activity={lead.activity} /></dd>
      <dt className="text-muted-foreground">Harness</dt><dd>{harnessLabel(lead.harness)}</dd>
      <dt className="text-muted-foreground">Modèle</dt><dd>{lead.model}</dd>
      <dt className="text-muted-foreground">Effort</dt><dd>{lead.effort}</dd>
      <dt className="text-muted-foreground">Approbation</dt><dd>{lead.permissionMode ?? "—"}</dd>
      <dt className="text-muted-foreground">Pid</dt><dd className="tabular-nums">{lead.pid ?? "—"}</dd>
      <dt className="text-muted-foreground">Depuis</dt><dd>{when(lead.started)} · {uptime(lead.uptimeSec)}</dd>
      <dt className="text-muted-foreground">Pilotage</dt><dd>{lead.remoteControl ? "à distance" : "local"}</dd>
      <dt className="text-muted-foreground">Session</dt><dd>{lead.supervised ? "supervisée" : "manuelle"}</dd>
      <dt className="text-muted-foreground">Dossier</dt><dd className="break-all">{lead.cwd}</dd>
      <dt className="text-muted-foreground">Lanes</dt>
      <dd>
        {workers.length ? workers.map((w) => (
          <div key={w.id} className="mb-1 flex items-center justify-between gap-2">
            <span>{harnessLabel(w.harness)}</span>
            <StatusPill status={w.status} />
          </div>
        )) : "aucune lane active"}
      </dd>
      <dt className="col-span-2 pt-3">
        <Link className="underline-offset-4 hover:underline" to="/runs">
          Ouvrir le projet
        </Link>
      </dt>
    </dl>
  );
}

function LaneDetail({ lane }: { lane: DashLane }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-[0.95rem]">
      <dt className="text-muted-foreground">Identifiant</dt><dd className="break-all">{lane.id}</dd>
      <dt className="text-muted-foreground">Projet</dt>
      <dd>
        <Link className="underline-offset-4 hover:underline" to={`/runs/${encodeURIComponent(lane.id)}`}>
          {lane.project}
        </Link>
      </dd>
      <dt className="text-muted-foreground">État</dt><dd><StatusPill status={lane.status} /></dd>
      <dt className="text-muted-foreground">Harness</dt><dd>{harnessLabel(lane.harness)}</dd>
      <dt className="text-muted-foreground">Modèle</dt><dd>{lane.model}</dd>
      <dt className="text-muted-foreground">Effort</dt><dd>{lane.effort ?? "—"}</dd>
      <dt className="text-muted-foreground">Coût</dt><dd>{money(lane.costUsd)}</dd>
      <dt className="text-muted-foreground">Début</dt><dd>{when(lane.started)}</dd>
    </dl>
  );
}

function ProjectSummary({ name, snap }: { name: string; snap: DashSnapshot }) {
  const project = snap.projects.find((row) => row.name === name);
  const bus = snap.bus.mailboxes.find((row) => row.project === name);
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-[0.95rem]">
      <dt className="text-muted-foreground">Kiba</dt><dd>{project?.leads ?? 0}</dd>
      <dt className="text-muted-foreground">Lanes</dt><dd>{project?.lanes ?? 0}</dd>
      <dt className="text-muted-foreground">Dépense</dt><dd>{money(project?.spendUsd ?? 0)}</dd>
      <dt className="text-muted-foreground">Bus</dt>
      <dd>
        {!snap.bus.active
          ? "bus inactif"
          : bus
            ? `${bus.inboxValid} valides · ${bus.escalated} escalade${bus.escalated > 1 ? "s" : ""}`
            : "aucune boîte"}
      </dd>
      <dt className="col-span-2 pt-3">
        <Link className="underline-offset-4 hover:underline" to="/runs">
          Fiche du projet
        </Link>
      </dt>
    </dl>
  );
}
