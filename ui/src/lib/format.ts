import type { DashLane, DashLead, LaneLife, LeadActivity } from "../types";

export const money = (n: number) =>
  n.toLocaleString("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);

export function uptime(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
}

export function activityLabel(a: LeadActivity): string {
  if (a === "working") return "En cours";
  if (a === "blocked") return "Bloqué";
  if (a === "busy") return "Occupé";
  return "Au repos";
}

export function lifeLabel(life: LaneLife): string {
  const map: Record<LaneLife, string> = {
    queued: "En attente",
    claimed: "Prise",
    running: "En cours",
    verify: "VERIFY",
    done: "Faite",
    failed: "Échec",
    blocked: "Bloquée",
  };
  return map[life];
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: "En cours",
    blocked: "Bloqué",
    complete: "Terminée",
    failed: "Échec",
    integrated: "Intégrée",
    dropped: "Abandonnée",
    refused: "Refusée",
    timeout: "Délai",
    queued: "En attente",
    claimed: "Prise",
    verify: "VERIFY",
    done: "Faite",
  };
  return map[status] ?? status;
}

export function harnessLabel(h: string): string {
  if (h === "claude") return "Claude";
  if (h === "codex") return "Codex";
  if (h === "grok") return "Grok";
  return h;
}

export function busStatusLabel(status: string): string {
  if (status === "inbox") return "boîte";
  if (status === "ack") return "accusé";
  if (status === "escalate") return "escalade";
  if (status === "invalid") return "invalide";
  return status;
}

export function busKindLabel(kind: string): string {
  if (kind === "request") return "demande";
  if (kind === "reply") return "réponse";
  if (kind === "contract") return "contrat";
  return kind;
}

export function spendLine(used: number): string {
  return money(used);
}

export function lanesOf(project: string, lanes: DashLane[]): DashLane[] {
  return lanes.filter((lane) => lane.project === project);
}

export function leadsOf(project: string, leads: DashLead[]): DashLead[] {
  return leads.filter((lead) => lead.project === project);
}

export function activeLanes(lanes: DashLane[]): DashLane[] {
  return lanes.filter((lane) => lane.life === "running" || lane.life === "blocked" || lane.life === "verify");
}

export const LIVES: LaneLife[] = ["queued", "claimed", "running", "verify", "done", "failed", "blocked"];
