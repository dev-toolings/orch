// Estimated spend for the dashboard, from the one spend journal every paid
// call writes (lanes, consults, Kiba sessions). Pure: the caller reads rows.
import type { SpendEntry } from "../core/policy.ts";
import type { DashCostDay, DashCosts } from "./types.ts";

const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
const DAYS_SHOWN = 14;
const WEEK = 7;

export type CostKind = "lead" | "lane" | "consult" | "other";

export function costKind(source: string): CostKind {
  if (source.startsWith("lead:")) return "lead";
  if (source.startsWith("lane:")) return "lane";
  if (source.startsWith("consult:")) return "consult";
  return "other";
}

export function parisDay(iso: string | Date): string | null {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return Number.isFinite(t) ? PARIS_DAY.format(new Date(t)) : null;
}

/**
 * Rows a Kiba session recorded more than once. Claude Code repeats a
 * message's usage on each content block, and before message ids were kept
 * every block became a row: same session, model and tokens.
 */
export function dedupeSpend(rows: SpendEntry[]): SpendEntry[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.source.startsWith("lead:claude")) return true;
    const message = (row as { message?: string }).message;
    if (!row.tokens && !message) return true;
    const key = message
      ? `${row.session}|m|${message}`
      : `${row.session}|t|${row.model}|${JSON.stringify(row.tokens)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function costsOf(raw: SpendEntry[], now: Date): DashCosts {
  const rows = dedupeSpend(raw);
  const days = lastDays(now, DAYS_SHOWN);
  const byDay = new Map<string, DashCostDay>(days.map((day) => [day, { day, total: 0, lead: 0, lane: 0, consult: 0, other: 0, runs: 0 }]));
  const week = new Set(days.slice(-WEEK));
  const byProject = new Map<string, number>();
  const byModel = new Map<string, number>();
  let laneUsd = 0;
  let laneRuns = 0;
  for (const row of rows) {
    const day = parisDay(row.at);
    const cell = day ? byDay.get(day) : undefined;
    if (!cell) continue;
    const kind = costKind(row.source);
    cell[kind] += row.usd;
    cell.total += row.usd;
    if (kind === "lane") cell.runs += 1;
    if (!week.has(cell.day)) continue;
    const project = row.project || "sans projet";
    byProject.set(project, (byProject.get(project) ?? 0) + row.usd);
    const model = row.model || row.provider || "inconnu";
    byModel.set(model, (byModel.get(model) ?? 0) + row.usd);
    if (kind === "lane") {
      laneUsd += row.usd;
      laneRuns += 1;
    }
  }
  const list = [...byDay.values()];
  return {
    today: list.at(-1)?.total ?? 0,
    week: list.slice(-WEEK).reduce((n, d) => n + d.total, 0),
    days: list,
    byProject: ranked(byProject),
    byModel: ranked(byModel),
    laneRuns,
    perLaneRun: laneRuns ? laneUsd / laneRuns : null,
  };
}

function ranked(map: Map<string, number>): { name: string; usd: number }[] {
  return [...map].map(([name, usd]) => ({ name, usd })).filter((row) => row.usd > 0).sort((a, b) => b.usd - a.usd);
}

/** The last `n` Paris days, oldest first, today last. */
function lastDays(now: Date, n: number): string[] {
  // Step from noon UTC of today's Paris date: a DST change can neither skip nor repeat a day.
  const base = Date.parse(`${parisDay(now)}T12:00:00Z`);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(parisDay(new Date(base - i * 24 * 60 * 60 * 1000))!);
  return out;
}
