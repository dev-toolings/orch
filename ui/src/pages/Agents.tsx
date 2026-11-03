import { Link } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Card, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { harnessLabel, uptime } from "../lib/format";

export function AgentsPage() {
  return (
    <Page crumbs={["orch", "kev", "Agents"]}>
      {(snap) => (
        <div>
          <PageHead title="Agents" subtitle="Chaque Kiba vu sur l'hôte : sessions natives lancées avec kiba." live />
          {snap.leads.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">Aucun Kiba en cours. Lance kiba dans un terminal ; le travail en fond passe par orch serve.</p>
          ) : (
            <ul className="grid gap-3 px-6 pb-6 md:grid-cols-2">
              {snap.leads.map((lead) => (
                <li key={lead.id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex items-center gap-3">
                        <Persona harness={lead.harness} role="lead" />
                        <span>
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{lead.id}</span>
                            <Badge>{harnessLabel(lead.harness)}</Badge>
                          </span>
                          <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" to="/runs">
                            {lead.project}
                          </Link>
                        </span>
                      </span>
                      <Badge tone={lead.activity === "working" ? "success" : lead.activity === "busy" ? "warning" : lead.activity === "blocked" ? "danger" : "muted"}>
                        {lead.activity === "working" ? "En cours" : lead.activity === "busy" ? "Occupé" : lead.activity === "blocked" ? "Bloqué" : "Au repos"}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Modèle</dt><dd>{lead.model}</dd>
                      <dt className="text-muted-foreground">Effort</dt><dd>{lead.effort}</dd>
                      <dt className="text-muted-foreground">Approbation</dt><dd>{lead.permissionMode ?? "—"}</dd>
                      <dt className="text-muted-foreground">En ligne depuis</dt><dd>{uptime(lead.uptimeSec)}</dd>
                      <dt className="text-muted-foreground">Session</dt><dd>{lead.supervised ? "supervisée" : "manuelle"}</dd>
                      <dt className="text-muted-foreground">Pilotage</dt><dd>{lead.remoteControl ? "à distance" : "local"}</dd>
                    </dl>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
