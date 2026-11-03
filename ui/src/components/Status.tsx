import type { LeadActivity } from "../types";
import { activityLabel, statusLabel } from "../lib/format";

const activityTone: Record<LeadActivity, string> = {
  working: "bg-success/15 text-success",
  busy: "bg-warning/15 text-warning",
  idle: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/15 text-destructive",
};

export function ActivityPill({ activity }: { activity: LeadActivity }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${activityTone[activity]}`}>
      {activityLabel(activity)}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const activity = status === "running" ? "working" : status === "blocked" ? "blocked" : "idle";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${activityTone[activity]}`}>
      {statusLabel(status)}
    </span>
  );
}
