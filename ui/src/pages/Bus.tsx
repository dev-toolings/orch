import { Link } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Card, Kpi, PageHead } from "../components/ui";
import { busKindLabel, busStatusLabel, when } from "../lib/format";

export function BusPage() {
  return (
    <Page crumbs={["orch", "kev", "Bus"]}>
      {(snap) => {
        const bus = snap.bus;
        return (
          <div>
            <PageHead
              title="Bus inter-projets"
              subtitle="Boîtes, messages récents et escalades — lecture seule, sans corps ni clés."
              live
            />
            {!bus.active ? (
              <p className="px-6 text-sm text-muted-foreground">Bus inactif.</p>
            ) : (
              <>
                <div className="grid gap-3 px-6 md:grid-cols-4">
                  <Kpi title="Boîtes" value={String(bus.mailboxes.length)} hint="projets avec une boîte" />
                  <Kpi title="Escalades" value={String(bus.pending.length)} hint="en attente opérateur" tile="amber" />
                  <Kpi title="Allers-retours" value={String(bus.rounds.roundTrips)} hint={`max hop ${bus.rounds.maxHop}`} />
                  <Kpi title="Fils" value={String(bus.rounds.threads)} hint={`${bus.rounds.hops} hops cumulés`} />
                </div>
                <Card className="mx-6 my-4 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="text-sm font-medium">Boîtes</h2>
                    <span className="text-xs text-muted-foreground">{bus.mailboxes.length} projet{bus.mailboxes.length > 1 ? "s" : ""}</span>
                  </div>
                  {bus.mailboxes.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">Aucune boîte sous le dossier du bus.</p>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-2 font-medium">Projet</th>
                          <th className="px-4 py-2 font-medium">Valides</th>
                          <th className="px-4 py-2 font-medium">Invalides</th>
                          <th className="px-4 py-2 font-medium">Accusés</th>
                          <th className="px-4 py-2 font-medium">Escalades</th>
                          <th className="px-4 py-2 font-medium">Voisins</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bus.mailboxes.map((box) => (
                          <tr key={box.project} className="border-t border-border">
                            <td className="px-4 py-2">
                              <Link to="/runs" className="hover:underline">{box.project}</Link>
                            </td>
                            <td className="px-4 py-2 tabular-nums">{box.inboxValid}</td>
                            <td className="px-4 py-2 tabular-nums">{box.inboxInvalid}</td>
                            <td className="px-4 py-2 tabular-nums">{box.acked}</td>
                            <td className="px-4 py-2 tabular-nums">{box.escalated}</td>
                            <td className="px-4 py-2 text-muted-foreground">
                              {box.neighbors.length
                                ? box.neighbors.map((n) => `${n.name} (${n.role})`).join(", ")
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
                <Card className="mx-6 mb-4 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="text-sm font-medium">Messages récents</h2>
                    <span className="text-xs text-muted-foreground">{bus.recent.length} visibles</span>
                  </div>
                  {bus.recent.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">Aucun message à afficher.</p>
                  ) : (
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-2 font-medium">De</th>
                          <th className="px-4 py-2 font-medium">À</th>
                          <th className="px-4 py-2 font-medium">Type</th>
                          <th className="px-4 py-2 font-medium">État</th>
                          <th className="px-4 py-2 font-medium">Heure</th>
                          <th className="px-4 py-2 font-medium">Sujet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bus.recent.map((row) => (
                          <tr key={`${row.id}-${row.status}-${row.at}`} className="border-t border-border">
                            <td className="px-4 py-2">{row.from || "—"}</td>
                            <td className="px-4 py-2">{row.to || "—"}</td>
                            <td className="px-4 py-2">{busKindLabel(row.kind)}</td>
                            <td className="px-4 py-2">
                              <Badge tone={row.status === "escalate" ? "warning" : row.status === "invalid" ? "danger" : "muted"}>
                                {busStatusLabel(row.status)}
                              </Badge>
                            </td>
                            <td className="px-4 py-2 text-muted-foreground">{when(row.at)}</td>
                            <td className="px-4 py-2 text-muted-foreground">{row.subject || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
                {bus.pending.length ? (
                  <Card className="mx-6 mb-6 overflow-hidden">
                    <div className="border-b border-border px-4 py-3">
                      <h2 className="text-sm font-medium">Escalades en attente</h2>
                    </div>
                    <ul className="divide-y divide-border">
                      {bus.pending.map((row) => (
                        <li key={row.id} className="px-4 py-3 text-sm">
                          <p className="font-medium">{row.from} → {row.to}</p>
                          <p className="text-muted-foreground">{row.subject || busKindLabel(row.kind)} · {when(row.at)}</p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </>
            )}
          </div>
        );
      }}
    </Page>
  );
}
