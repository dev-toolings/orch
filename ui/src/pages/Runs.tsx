import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Button, Card, Field, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { harnessLabel, lifeLabel, money, uptime } from "../lib/format";
import type { DashLane, DashWorking, LaneLife } from "../types";

const GROUPS: { life: LaneLife; hint: string }[] = [
  { life: "running", hint: "Exécution en direct : dernière étape du worker." },
  { life: "verify", hint: "VERIFY en cours ou déjà posé." },
  { life: "claimed", hint: "Pid pris, pas encore running." },
  { life: "queued", hint: "En attente, sans pid." },
  { life: "blocked", hint: "Attend une décision." },
  { life: "failed", hint: "Échec, refus, délai." },
  { life: "done", hint: "Terminée ou intégrée." },
];

export function RunsPage() {
  const [q, setQ] = useState("");
  return (
    <Page crumbs={["orch", "kev", "Lanes"]}>
      {(snap) => {
        const lanes = snap.lanes.filter((lane) => {
          const hay = `${lane.id} ${lane.project} ${lane.model} ${lane.harness}`.toLowerCase();
          return hay.includes(q.trim().toLowerCase());
        });
        return (
          <div>
            <PageHead
              title="Lanes"
              subtitle="Triage des lanes — une lane = un ticket."
              live
              actions={<span className="text-xs text-muted-foreground tabular-nums">{lanes.length} lanes</span>}
            />
            <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
              <Field value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une lane…" className="max-w-sm" />
              <Button onClick={() => setQ("")}>Effacer</Button>
            </div>
            <div className="space-y-4 px-6 pb-6">
              {GROUPS.map((group) => {
                const rows = lanes.filter((l) => l.life === group.life);
                if (!rows.length) return null;
                return <Group key={group.life} life={group.life} hint={group.hint} lanes={rows} working={snap.working} />;
              })}
              {lanes.length === 0 ? <p className="text-sm text-muted-foreground">Aucune lane sur cet instantané.</p> : null}
            </div>
          </div>
        );
      }}
    </Page>
  );
}

function Group({ life, hint, lanes, working }: { life: LaneLife; hint: string; lanes: DashLane[]; working: DashWorking[] }) {
  const open = useMemo(() => life === "running" || life === "verify" || life === "blocked", [life]);
  const [on, setOn] = useState(open);
  return (
    <Card>
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOn((v) => !v)}
        aria-expanded={on}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={`h-2 w-2 rounded-full ${life === "failed" || life === "blocked" ? "bg-destructive" : life === "running" || life === "verify" ? "bg-success" : "bg-muted-foreground"}`} />
          {lifeLabel(life)} · {lanes.length}
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
      {on ? (
        <ul className="divide-y divide-border border-t border-border">
          {lanes.map((lane) => {
            const live = working.find((row) => row.laneId === lane.id);
            return (
              <li key={lane.id}>
                <Link to={`/runs/${encodeURIComponent(lane.id)}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-muted/60 transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]">
                  <Persona harness={lane.harness} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{lane.id}</span>
                    <span className="block text-xs text-muted-foreground">
                      {lane.project} · {harnessLabel(lane.harness)} · {lane.model}{live ? ` · effort ${lane.effort ?? "—"}` : ""}
                    </span>
                    {live ? <LiveStep row={live} /> : null}
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">{uptime(live ? live.elapsedSec : lane.durationSec)}</span>
                  <span className="tabular-nums text-xs">{money(lane.costUsd)}</span>
                  <Badge tone={lane.blocked ? "danger" : "muted"}>{lifeLabel(lane.life)}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

// One live line per running lane: last tool (and file) or phase, then the
// worker's last words. Without progress.json, says so instead of guessing.
function LiveStep({ row }: { row: DashWorking }) {
  if (!row.live) {
    return <span className="block text-xs text-muted-foreground">Pas de progression en direct (progress.json absent).</span>;
  }
  return (
    <span className="mt-1 block text-xs" aria-live="polite">
      <span className="font-medium">{row.lastStep}</span>
      {row.toolCalls != null ? <span className="tabular-nums text-muted-foreground"> · {row.toolCalls} appels</span> : null}
      {row.lastText ? <span className="block truncate text-muted-foreground">{row.lastText}</span> : null}
    </span>
  );
}
