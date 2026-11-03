import type { DashQuotaWindow } from "../types";

const PARIS_HM = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const PARIS_DAY_HM = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

/** "2 h 05", "3 j 4 h", "12 min". */
export function countdown(iso: string | undefined | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((t - now) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

/** Local Europe/Paris time; the weekday and date are added when not today. */
export function parisTime(iso: string | undefined | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sameDay = PARIS_DAY.format(new Date(t)) === PARIS_DAY.format(new Date(now));
  return sameDay ? PARIS_HM.format(new Date(t)) : PARIS_DAY_HM.format(new Date(t));
}

export function rateLabel(w: DashQuotaWindow, now: number): string {
  if (w.ratePerHour == null) return "—";
  const rate = `${w.ratePerHour.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %/h`;
  if (!w.projectedFullAt) return rate;
  if (w.fullBeforeReset === false) return `${rate} · tient jusqu'au reset`;
  return `${rate} · 100 % ${parisTime(w.projectedFullAt, now)}`;
}

export function barTone(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-warning";
  return "bg-sidebar-primary";
}
