import { Link } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Card, InlineInfoTooltip, Kpi, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { QuotaWindows } from "../components/Quota";
import { IconAlert, IconCoins, IconQueue, IconShield } from "../components/icons";
import { harnessLabel, lifeLabel, money, when } from "../lib/format";

const ESTIMATED_COST_HINT = "Coût estimé (jour) : estimation tokens x tarif public, pas la facture réelle (abonnement = quota).";

export function OverviewPage() {
  return (
    <Page crumbs={["orch", "kev", "Aperçu"]}>
      {(snap) => {
        const running = snap.lanes.filter((l) => l.life === "running" || l.life === "verify").length;
        const blocked = snap.lanes.filter((l) => l.blocked).length;
        const failed = snap.lanes.filter((l) => l.life === "failed").length;
        const max = Math.max(0.01, ...snap.daily.map((d) => d.costUsd));
        return (
          <div>
            <PageHead
              title="Opérations"
              subtitle="Santé des lanes, approbations et incidents, en lecture seule."
              live
            />
            <div className="grid gap-3 px-6 md:grid-cols-2 xl:grid-cols-4">
              <Kpi title="Lanes" value={String(snap.lanes.length)} hint={`${running} en cours`} icon={<IconQueue />} tile="indigo" />
              <Kpi title="Approbations" value={String(blocked)} hint={blocked ? "lanes bloquées" : "rien en attente"} icon={<IconShield />} tile="amber" />
              <Kpi
                title={<span className="inline-flex items-center">Coût estimé (jour) <InlineInfoTooltip text={ESTIMATED_COST_HINT} delayDuration={0} /></span>}
                value={money(snap.spend.used)}
                hint="info seulement"
                icon={<IconCoins />}
                tile="emerald"
              />
              <Kpi title="Incidents" value={String(failed)} hint={`${failed} échec${failed > 1 ? "s" : ""}`} icon={<IconAlert />} tile="rose" />
            </div>
            <div className="mt-4 grid gap-3 px-6 lg:grid-cols-2">
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Kiba</h2>
                  <Link to="/agents" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                    {snap.leads.length} session{snap.leads.length > 1 ? "s" : ""}
                  </Link>
                </div>
                {snap.leads.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">Aucun Kiba actif sur l'hôte.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {snap.leads.map((lead) => (
                      <li key={lead.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <Persona harness={lead.harness} size="sm" role="lead" />
                          <span className="truncate font-medium">{lead.id}</span>
                          <Badge>{harnessLabel(lead.harness)}</Badge>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {lead.supervised ? "supervisé" : "manuel"} · {lead.activity === "working" ? "en cours" : lead.activity === "busy" ? "occupé" : lead.activity === "blocked" ? "bloqué" : "repos"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Bus</h2>
                  <Link to="/bus" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                    ouvrir
                  </Link>
                </div>
                {!snap.bus.active ? (
                  <p className="mt-3 text-sm text-muted-foreground">Bus inactif.</p>
                ) : (
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Boîtes</dt>
                      <dd className="tabular-nums">{snap.bus.mailboxes.length}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Escalades</dt>
                      <dd className="tabular-nums">{snap.bus.pending.length}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Allers-retours</dt>
                      <dd className="tabular-nums">{snap.bus.rounds.roundTrips}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Messages</dt>
                      <dd className="tabular-nums">{snap.bus.recent.length}</dd>
                    </div>
                  </dl>
                )}
              </Card>
            </div>
            {snap.runtimes.some((rt) => rt.kind === "harness" && rt.limits) ? (
              <Card className="mx-6 mt-4 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Quotas fournisseurs</h2>
                  <Link to="/providers" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                    détails
                  </Link>
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-3">
                  {snap.runtimes.filter((rt) => rt.kind === "harness" && rt.limits).map((rt) => (
                    <div key={rt.id}>
                      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                        <Persona harness={rt.name} size="sm" />
                        {harnessLabel(rt.name)}
                      </div>
                      <QuotaWindows quota={rt.limits} compact />
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
            <div className="mt-4 grid gap-3 px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Débit des lanes</h2>
                  <span className="text-xs text-muted-foreground">journalier</span>
                </div>
                <div className="mt-6 flex h-36 items-end gap-2">
                  {snap.daily.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Pas encore de série au journal.</p>
                  ) : snap.daily.map((day) => (
                    <div key={day.day} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-t-md bg-sidebar-primary/80"
                        style={{ height: `${day.costUsd <= 0 ? 0 : Math.max(8, (day.costUsd / max) * 120)}px` }}
                      />
                      <span className="text-[10px] text-muted-foreground">{day.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="p-4">
                <h2 className="text-sm font-medium">Incidents</h2>
                <ul className="mt-3 space-y-3">
                  {snap.lanes.filter((l) => l.blocked || l.life === "failed").slice(0, 5).map((lane) => (
                    <li key={lane.id} className="text-sm">
                      <Link to={`/runs/${encodeURIComponent(lane.id)}`} className="font-medium hover:underline">
                        {lane.blocked ? "Bloquée" : "Échec"} · {lane.project}
                      </Link>
                      <p className="text-xs text-muted-foreground">{lane.model} · {lifeLabel(lane.life)}</p>
                    </li>
                  ))}
                  {snap.lanes.every((l) => !l.blocked && l.life !== "failed") ? (
                    <li className="text-sm text-muted-foreground">Aucun incident sur l'instantané.</li>
                  ) : null}
                </ul>
              </Card>
            </div>
            <Card className="mx-6 my-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-medium">Arbre des lanes</h2>
                <span className="text-xs text-muted-foreground">{snap.lanes.length} lanes</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Agent / lane</th>
                    <th className="px-4 py-2 font-medium">Projet</th>
                    <th className="px-4 py-2 font-medium">Tokens</th>
                    <th className="px-4 py-2 font-medium">Coût</th>
                    <th className="px-4 py-2 font-medium">Cycle</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.lanes.map((lane) => (
                    <tr key={lane.id} className="border-t border-border">
                      <td className="px-4 py-2">
                        <Link to={`/runs/${encodeURIComponent(lane.id)}`} className="flex items-center gap-2 hover:underline">
                          <Persona harness={lane.harness} size="sm" />
                          <span className="truncate">{lane.id}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{lane.project}</td>
                      <td className="px-4 py-2 tabular-nums">{lane.tokens.input + lane.tokens.output}</td>
                      <td className="px-4 py-2 tabular-nums">{money(lane.costUsd)}</td>
                      <td className="px-4 py-2">
                        <Badge tone={lane.blocked ? "danger" : lane.life === "running" || lane.life === "verify" ? "success" : "muted"}>
                          {lifeLabel(lane.life)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[11px] text-muted-foreground">{when(snap.at)}</p>
            </Card>
          </div>
        );
      }}
    </Page>
  );
}
