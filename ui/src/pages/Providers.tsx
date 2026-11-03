import { Page } from "../components/Page";
import { Badge, Card, InlineInfoTooltip, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { QuotaWindows } from "../components/Quota";
import { money, tokens } from "../lib/format";

const ESTIMATED_COST_HINT = "Coût estimé (jour) : estimation tokens x tarif public, pas la facture réelle (abonnement = quota).";

export function ProvidersPage() {
  return (
    <Page crumbs={["orch", "kev", "Fournisseurs"]}>
      {(snap) => (
        <div>
          <PageHead
            title="Routage des fournisseurs"
            subtitle="Usage live depuis les sessions locales (coût API réel ou quota de login)."
          />
          {snap.providersSyncing ? (
            <div className="px-6 pb-2 text-xs text-muted-foreground">Synchronisation usage en cours...</div>
          ) : null}
          <div className="px-6 pb-3">
            <Card className="p-4">
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Coût estimé (jour) <InlineInfoTooltip text={ESTIMATED_COST_HINT} delayDuration={0} /></dt>
                  <dd className="tabular-nums">{money(snap.spend.used)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Capacité lanes</dt>
                  <dd className="tabular-nums">{snap.budget.budget}</dd>
                </div>
              </dl>
            </Card>
          </div>
          <div className="grid gap-3 px-6 pb-6 md:grid-cols-2">
            {snap.runtimes.map((rt) => (
              <Card key={rt.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    {rt.kind === "harness" ? <Persona harness={rt.name} /> : <span className="h-8 w-8 rounded-full bg-muted" />}
                    <span>
                      <span className="block font-medium">{rt.name}</span>
                      <span className="text-xs text-muted-foreground">{rt.detail}</span>
                    </span>
                  </span>
                  <Badge tone={rt.live ? "live" : rt.online ? "success" : "muted"}>
                    {rt.live ? "live" : rt.online ? "en ligne" : "hors ligne"}
                  </Badge>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Tokens entrée</dt>
                    <dd className="tabular-nums">{tokens(rt.tokens.input)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Tokens sortie</dt>
                    <dd className="tabular-nums">{tokens(rt.tokens.output)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Cache</dt>
                    <dd className="tabular-nums">{tokens(rt.tokens.cacheRead)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {rt.id === "host" ? "Coût (ledger orch aujourd'hui)" : "Coût"}
                    </dt>
                    <dd className="tabular-nums">
                      {rt.billing === "quota" ? "— (login)" : `${money(rt.costUsd)}${rt.estimate ? " (est.)" : ""}`}
                    </dd>
                  </div>
                </dl>
                {rt.kind === "harness" && rt.limits ? (
                  <div className="mt-4 border-t border-border pt-3">
                    <QuotaWindows quota={rt.limits} />
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
