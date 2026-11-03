import { Link } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Card, Kpi, PageHead } from "../components/ui";
import { EmptyState } from "../components/States";
import { Persona } from "../components/Persona";
import { harnessLabel, money, uptime } from "../lib/format";

export function ApprovalsPage() {
  return (
    <Page crumbs={["orch", "kev", "Approbations"]}>
      {(snap) => {
        const blocked = snap.lanes.filter((l) => l.blocked);
        return (
          <div>
            <PageHead
              title="Boîte d'approbation"
              subtitle={blocked.length ? `${blocked.length} lane${blocked.length > 1 ? "s" : ""} bloquée${blocked.length > 1 ? "s" : ""}` : "Aucune demande exposée."}
              live
            />
            <div className="grid gap-3 px-6 md:grid-cols-3">
              <Kpi title="En attente" value={String(blocked.length)} hint="lanes au statut blocked" />
              <Kpi title="Hooks" value="0" hint="orch n'expose pas encore les asks de hooks" />
              <Kpi title="Décidées" value="—" hint="lecture seule, pas d'action ici" />
            </div>
            <Card className="mx-6 my-4">
              {blocked.length === 0 ? (
                <EmptyState
                  title="Aucune approbation en attente"
                  text="Aucune lane bloquée, et les asks de hooks ne sont pas publiés sur /api/snapshot. Rien à inventer."
                />
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Agent</th>
                      <th className="px-4 py-2 font-medium">Lane</th>
                      <th className="px-4 py-2 font-medium">Projet</th>
                      <th className="px-4 py-2 font-medium">Durée</th>
                      <th className="px-4 py-2 font-medium">Coût</th>
                      <th className="px-4 py-2 font-medium">État</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocked.map((lane) => (
                      <tr key={lane.id} className="border-t border-border">
                        <td className="px-4 py-2">
                          <span className="flex items-center gap-2">
                            <Persona harness={lane.harness} size="sm" />
                            {harnessLabel(lane.harness)}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <Link className="underline-offset-4 hover:underline" to={`/runs/${encodeURIComponent(lane.id)}`}>{lane.id}</Link>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{lane.project}</td>
                        <td className="px-4 py-2 tabular-nums">{uptime(lane.durationSec)}</td>
                        <td className="px-4 py-2 tabular-nums">{money(lane.costUsd)}</td>
                        <td className="px-4 py-2"><Badge tone="danger">Bloquée</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        );
      }}
    </Page>
  );
}
