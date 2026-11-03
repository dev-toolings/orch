import { useEffect, useState } from "react";
import type { DashQuota, DashQuotaWindow } from "../types";
import { Badge } from "./ui";
import { barTone, countdown, parisTime, rateLabel } from "../lib/quota";

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function QuotaWindowRow({ w, now, compact }: { w: DashQuotaWindow; now: number; compact?: boolean }) {
  if (w.usedPercent == null) {
    return (
      <div className="flex items-center justify-between gap-2 text-muted-foreground" title={w.unavailable}>
        <span>{w.label}</span>
        <span className="truncate text-right">indisponible{!compact && w.unavailable ? ` · ${w.unavailable}` : ""}</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-muted-foreground">
        <span>{w.label}</span>
        <span className="tabular-nums text-foreground">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${barTone(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      <dl className={`mt-1 grid gap-x-3 text-muted-foreground ${compact ? "grid-cols-1" : "grid-cols-2"}`}>
        <div className="flex gap-1">
          <dt>Remise à zéro dans</dt>
          <dd className="tabular-nums text-foreground">
            {w.resetAt ? `${countdown(w.resetAt, now)} (${parisTime(w.resetAt, now)})` : w.note ?? "—"}
          </dd>
        </div>
        {compact ? null : (
          <div className="flex gap-1">
            <dt>Rythme</dt>
            <dd className="tabular-nums text-foreground">{rateLabel(w, now)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function QuotaWindows({ quota, compact = false }: { quota: DashQuota | undefined; compact?: boolean }) {
  const now = useNow();
  if (!quota) return null;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span className="truncate" title={quota.source}>{compact ? "Quotas" : `Source : ${quota.source}`}</span>
        <span className="flex shrink-0 items-center gap-1">
          {quota.capturedAt ? <span title={quota.capturedAt}>{parisTime(quota.capturedAt, now)}</span> : null}
          {quota.stale && quota.capturedAt ? <Badge tone="warning">ancien</Badge> : null}
        </span>
      </div>
      {quota.loading ? (
        <div className="text-muted-foreground">chargement…</div>
      ) : quota.unavailable ? (
        <div className="text-muted-foreground" title={quota.unavailable}>
          indisponible{compact ? "" : ` · ${quota.unavailable}`}
        </div>
      ) : (
        quota.windows.map((w) => <QuotaWindowRow key={w.id} w={w} now={now} compact={compact} />)
      )}
    </div>
  );
}
