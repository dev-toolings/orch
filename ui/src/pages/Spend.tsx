import { useMemo, useState } from "react";
import { Page } from "../components/Page";
import { StatusPill } from "../components/Status";
import { Card, InlineInfoTooltip, Kpi, PageHead, Pager } from "../components/ui";
import { money, when } from "../lib/format";
import { countdown } from "../lib/quota";
import type { DashCostDay, DashCosts, DashLedgerLine, DashRuntime } from "../types";

const ESTIMATED_COST_HINT = "Estimation tokens x tarif public, pas la facture réelle (un abonnement se lit en quota).";
const PAGE_SIZE = 15;

const SERIES: { key: keyof Pick<DashCostDay, "lead" | "lane" | "consult" | "other">; label: string; color: string }[] = [
  { key: "lead", label: "Kiba", color: "#8b93ff" },
  { key: "lane", label: "Lanes", color: "#2fb39a" },
  { key: "consult", label: "Revues et contests", color: "#e0a526" },
  { key: "other", label: "Autres", color: "#8c877e" },
];

export function SpendPage() {
  return (
    <Page crumbs={["orch", "kev", "Coûts"]}>
      {(snap) => (
        <div className="pb-6">
          <PageHead
            title="Coûts estimés"
            subtitle="Kiba, lanes et revues sur 14 jours, depuis le journal de dépense (jour de Paris)."
          />
          <Kpis costs={snap.costs} claude={snap.runtimes.find((rt) => rt.id === "claude")} />
          <DailyChart days={snap.costs.days} />
          <div className="mt-4 grid gap-3 px-6 lg:grid-cols-2">
            <Breakdown title="Par projet" rows={snap.costs.byProject} total={snap.costs.week} />
            <Breakdown title="Par modèle" rows={snap.costs.byModel} total={snap.costs.week} />
          </div>
          <RunsTable ledger={snap.ledger} />
        </div>
      )}
    </Page>
  );
}

function Kpis({ costs, claude }: { costs: DashCosts; claude: DashRuntime | undefined }) {
  const now = Date.now();
  const window = claude?.limits?.windows.find((w) => w.usedPercent != null);
  return (
    <div className="grid gap-3 px-6 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        title={<span className="inline-flex items-center">Aujourd'hui <InlineInfoTooltip text={ESTIMATED_COST_HINT} delayDuration={0} /></span>}
        value={money(costs.today)}
        hint="estimation, jour de Paris"
      />
      <Kpi title="7 jours" value={money(costs.week)} hint={`moyenne ${money(costs.week / 7)} par jour`} />
      <Kpi
        title="Par run de lane"
        value={costs.perLaneRun == null ? "—" : money(costs.perLaneRun)}
        hint={`${costs.laneRuns} run${costs.laneRuns > 1 ? "s" : ""} sur 7 jours`}
      />
      <Kpi
        title="Quota Claude"
        value={window ? `${Math.round(window.usedPercent ?? 0)} %` : "—"}
        hint={window
          ? `${window.label}${window.resetAt ? `, reset dans ${countdown(window.resetAt, now)}` : ""}${claude?.limits?.stale ? " (ancien)" : ""}`
          : "pas de relevé (statusLine)"}
      />
    </div>
  );
}

function DailyChart({ days }: { days: DashCostDay[] }) {
  const max = Math.max(0.01, ...days.map((d) => d.total));
  return (
    <Card className="mx-6 mt-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Coût par jour</h2>
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Légende">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 grid h-48 grid-flow-col auto-cols-fr items-end gap-1.5" role="list">
        {days.map((day) => (
          <div key={day.day} role="listitem" className="flex h-full flex-col items-center gap-1" title={dayTitle(day)}>
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-end gap-1">
              {day.total > 0 ? <span className="text-[10px] tabular-nums text-muted-foreground">{short(day.total)}</span> : null}
              {/* 85 % leaves room for the amount above the tallest bar. */}
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${(day.total / max) * 85}%`, minHeight: day.total > 0 ? 2 : 0 }}>
                {SERIES.map((s) => (day[s.key] > 0 ? (
                  <span key={s.key} style={{ height: `${(day[s.key] / day.total) * 100}%`, background: s.color }} />
                ) : null))}
              </div>
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{day.day.slice(8)}/{day.day.slice(5, 7)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const BREAKDOWN_ROWS = 6;

function Breakdown({ title, rows, total }: { title: string; rows: { name: string; usd: number }[]; total: number }) {
  const shown = rows.slice(0, BREAKDOWN_ROWS);
  const rest = rows.slice(BREAKDOWN_ROWS).reduce((n, row) => n + row.usd, 0);
  const max = Math.max(0.01, ...shown.map((row) => row.usd), rest);
  return (
    <Card className="p-4">
      <h2 className="text-sm font-medium">{title} <span className="font-normal text-muted-foreground">· 7 jours</span></h2>
      {rows.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Rien dépensé sur 7 jours.</p> : (
        <ul className="mt-3 space-y-2">
          {[...shown, ...(rest > 0 ? [{ name: `${rows.length - BREAKDOWN_ROWS} autres`, usd: rest }] : [])].map((row) => (
            <li key={row.name} className="grid grid-cols-[minmax(0,10rem)_1fr_4.5rem] items-center gap-3 text-sm">
              <span className="truncate" title={row.name}>{row.name}</span>
              <span className="h-2 rounded-full bg-muted">
                <span className="block h-2 rounded-full bg-foreground/70" style={{ width: `${(row.usd / max) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums" title={total > 0 ? `${Math.round((row.usd / total) * 100)} % des 7 jours` : undefined}>{money(row.usd)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RunsTable({ ledger }: { ledger: DashLedgerLine[] }) {
  const [page, setPage] = useState(0);
  // A run's outcome (integrated, dropped, ...) is a later ledger line: shown as its status.
  const runs = useMemo(() => {
    const outcome = new Map<string, string>();
    for (const row of ledger) if (row.kind === "outcome" && row.status && !outcome.has(row.id)) outcome.set(row.id, row.status);
    return ledger.filter((row) => row.kind === "run").map((row) => ({ ...row, status: outcome.get(row.id) ?? row.status }));
  }, [ledger]);
  const pages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = runs.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  return (
    <Card className="mx-6 mt-4 overflow-hidden">
      <h2 className="px-4 py-3 text-sm font-medium">Runs de lanes</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Quand</th>
              <th className="px-4 py-2 font-medium">Projet</th>
              <th className="px-4 py-2 font-medium">Modèle</th>
              <th className="px-4 py-2 font-medium">Statut</th>
              <th className="px-4 py-2 text-right font-medium">Coût</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={`${row.id}-${row.at}-${i}`} className="border-t border-border">
                <td className="px-4 py-2 whitespace-nowrap tabular-nums text-muted-foreground">{when(row.at)}</td>
                <td className="px-4 py-2">{row.project ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">{row.model ?? "—"}{row.effort ? <span className="text-muted-foreground"> · {row.effort}</span> : null}</td>
                <td className="px-4 py-2">{row.status ? <StatusPill status={row.status} /> : "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.costUsd ? money(row.costUsd) : <span className="text-muted-foreground" title="pas d'usage relevé pour ce run">—</span>}</td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr className="border-t border-border"><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Aucun run de lane.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager page={current} pages={pages} total={runs.length} size={PAGE_SIZE} onPage={setPage} />
    </Card>
  );
}

function short(usd: number): string {
  return usd >= 100 ? `${Math.round(usd)} $` : usd >= 10 ? `${usd.toFixed(0)} $` : `${usd.toFixed(2).replace(".", ",")} $`;
}

function dayTitle(day: DashCostDay): string {
  const parts = SERIES.filter((s) => day[s.key] > 0).map((s) => `${s.label} ${money(day[s.key])}`);
  return `${day.day} : ${money(day.total)}${parts.length ? ` (${parts.join(", ")})` : ""}${day.runs ? `, ${day.runs} run${day.runs > 1 ? "s" : ""}` : ""}`;
}
