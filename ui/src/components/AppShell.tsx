import { AgentBloub } from "./Bloub";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { StreamState } from "../api";
import type { DashSnapshot } from "../types";
import { money, when } from "../lib/format";
import { applyTheme, readTheme, type Theme } from "../lib/theme";
import { PAGE_LABELS, readSidebarOpen, sidebarKind, storeSidebarOpen } from "../lib/routes";
import { Field, InlineInfoTooltip } from "./ui";
import {
  IconBook, IconBox, IconFlow, IconCoins, IconGrid, IconLayout, IconMoon,
  IconPeople, IconPulse, IconQueue, IconSearch, IconShield, IconSun, IconBolt, IconMail,
} from "./icons";

const ESTIMATED_COST_HINT = "Coût estimé (jour) : estimation tokens x tarif public, pas la facture réelle (abonnement = quota).";

type Item = { to: string; label: string; icon: ReactNode; end?: boolean; badge?: number };

export function AppShell({
  snap,
  stream,
  crumbs,
  children,
}: {
  snap: DashSnapshot | null;
  stream: StreamState;
  crumbs?: string[];
  children: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [theme, setTheme] = useState<Theme>("dark");
  const loc = useLocation();
  const kind = sidebarKind(loc.pathname);
  const [openByKind, setOpenByKind] = useState(() => ({ [kind]: readSidebarOpen(kind) }) as Partial<Record<typeof kind, boolean>>);
  const open = openByKind[kind] ?? readSidebarOpen(kind);
  const toggleSidebar = () => {
    storeSidebarOpen(kind, !open);
    setOpenByKind((prev) => ({ ...prev, [kind]: !open }));
  };

  useEffect(() => {
    const next = readTheme();
    setTheme(next);
    applyTheme(next);
  }, []);

  const blocked = snap?.lanes.filter((l) => l.blocked).length ?? 0;
  const items: Item[] = [
    { to: "/", label: PAGE_LABELS["/"], icon: <IconLayout />, end: true },
    { to: "/runs", label: PAGE_LABELS["/runs"], icon: <IconQueue /> },
    { to: "/approvals", label: PAGE_LABELS["/approvals"], icon: <IconShield />, badge: blocked || undefined },
    { to: "/agents", label: PAGE_LABELS["/agents"], icon: <IconPeople /> },
    { to: "/tools", label: PAGE_LABELS["/tools"], icon: <IconGrid /> },
    { to: "/providers", label: PAGE_LABELS["/providers"], icon: <IconBolt /> },
    { to: "/spend", label: PAGE_LABELS["/spend"], icon: <IconCoins /> },
    { to: "/activity", label: PAGE_LABELS["/activity"], icon: <IconPulse /> },
    { to: "/bus", label: PAGE_LABELS["/bus"], icon: <IconMail /> },
    { to: "/skills", label: PAGE_LABELS["/skills"], icon: <IconBook /> },
    { to: "/atelier", label: PAGE_LABELS["/atelier"], icon: <IconBox /> },
    { to: "/flux", label: PAGE_LABELS["/flux"], icon: <IconFlow /> },
  ];
  const visible = items.filter((item) => item.label.toLowerCase().includes(q.trim().toLowerCase()));
  const trail = crumbs ?? trailOf(loc.pathname);
  const lead = snap?.leads[0];
  const used = snap?.spend.used ?? 0;

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  const crumb = useMemo(() => trail, [trail]);

  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      <aside
        id="main-sidebar"
        className={`flex shrink-0 flex-col overflow-y-auto overflow-x-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
          open ? "w-[260px]" : "w-14"
        }`}
      >
        <div className={`flex items-center gap-2 pt-4 pb-3 ${open ? "px-4" : "justify-center"}`}>
          <img src="/favicon.svg" alt="" className="h-7 w-7 shrink-0 rounded-md" />
          {open ? <span className="text-sm font-semibold">orch</span> : null}
        </div>
        {open ? (
          <label className="relative mx-4 mb-3 block">
            <IconSearch className="pointer-events-none absolute left-2.5 top-2 text-muted-foreground" size={14} />
            <Field
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher…"
              aria-label="Filtrer le menu"
              className="pl-8"
            />
          </label>
        ) : null}
        {open ? (
          <p className="px-5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Espace</p>
        ) : null}
        <nav className={`flex flex-col gap-0.5 ${open ? "px-3" : "items-center px-2"}`} aria-label="Principal">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={open ? undefined : item.label}
              aria-label={open ? undefined : item.label}
              className={({ isActive }) =>
                `relative flex h-9 items-center gap-2 rounded-full text-sm font-medium transition-[background-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
                  open ? "px-3" : "w-9 justify-center"
                } ${isActive ? "bg-sidebar-accent text-foreground" : "text-foreground/80 hover:bg-sidebar-accent"}`
              }
            >
              <span className="text-muted-foreground">{item.icon}</span>
              {open ? <span className="flex-1 truncate">{item.label}</span> : null}
              {item.badge ? (
                open ? (
                  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{item.badge}</span>
                ) : (
                  <span aria-hidden className="absolute right-1 top-1 h-2 w-2 rounded-full bg-warning" />
                )
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className={`mt-auto pb-3 pt-6 ${open ? "px-4" : "flex justify-center px-2"}`}>
          {snap && open ? (
            <div className="mb-3">
              <p className="text-[11px] text-muted-foreground">
                Coût estimé (jour) <InlineInfoTooltip text={ESTIMATED_COST_HINT} delayDuration={0} />
              </p>
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                {money(used)}
              </p>
            </div>
          ) : null}
          <div
            className="flex items-center gap-2 rounded-lg px-1 py-1"
            title={open ? undefined : `Kiba · ${lead ? `${lead.harness} · ${lead.project}` : "aucun chef actif"}`}
          >
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center">
              <AgentBloub harness={lead?.harness ?? null} activity={lead?.activity ?? "idle"} role="lead" size={28} still={!lead} />
            </span>
            {open ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">Kiba</p>
                <p className="truncate text-[11px] text-muted-foreground">{lead ? `${lead.harness} · ${lead.project}` : "aucun chef actif"}</p>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <main className="m-2 ml-0 flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-border bg-background">
        <header className="flex h-12 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-expanded={open}
              aria-controls="main-sidebar"
              aria-label={open ? "Replier le menu" : "Déplier le menu"}
              title={open ? "Replier le menu" : "Déplier le menu"}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color] duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </button>
            <img src="/favicon.svg" alt="" className="h-5 w-5 rounded-sm" />
            <span className="shrink-0 text-sm font-semibold">orch</span>
            <p className="truncate text-sm text-muted-foreground">
            {crumb.map((c, i) => (
              <span key={`${c}-${i}`}>
                {i > 0 ? <span className="mx-1.5 text-border">/</span> : null}
                <span className={i === crumb.length - 1 ? "text-foreground" : ""}>{c}</span>
              </span>
            ))}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted transition-[background-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]"
              aria-label={theme === "dark" ? "Passer en clair" : "Passer en sombre"}
            >
              {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
            </button>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs ${
                stream.status === "live"
                  ? "text-success"
                  : stream.status === "reconnecting"
                    ? "text-warning"
                    : "text-muted-foreground"
              }`}
              title={stream.lastEventAt ? `Dernier événement : ${when(stream.lastEventAt)}` : "Pas encore d'événement"}
            >
              <span className="relative inline-flex h-1.5 w-1.5">
                {stream.status === "live" ? <span className="flux-ping absolute inline-flex h-full w-full rounded-full bg-success/60" /> : null}
                <span
                  className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                    stream.status === "live"
                      ? "bg-success"
                      : stream.status === "reconnecting"
                        ? "bg-warning"
                        : "bg-muted-foreground"
                  }`}
                />
              </span>
              {stream.status === "live" ? "Live" : stream.status === "reconnecting" ? "Reconnexion…" : "Hors ligne"}
              {stream.lastEventAt ? <span className="tabular-nums text-muted-foreground">{when(stream.lastEventAt)}</span> : null}
            </span>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </main>
    </div>
  );
}

function trailOf(path: string): string[] {
  if (path === "/") return ["orch", "kev", "Aperçu"];
  const map: Record<string, string[]> = {
    "/runs": ["orch", "kev", "Lanes"],
    "/approvals": ["orch", "kev", "Approbations"],
    "/agents": ["orch", "kev", "Agents"],
    "/tools": ["orch", "kev", "Outils"],
    "/providers": ["orch", "kev", "Fournisseurs"],
    "/spend": ["orch", "kev", "Coûts"],
    "/activity": ["orch", "kev", "Activité"],
    "/bus": ["orch", "kev", "Bus"],
    "/skills": ["orch", "kev", "Compétences"],
    "/atelier": ["orch", "kev", "Atelier"],
    "/flux": ["orch", "kev", "Architecture"],
  };
  if (map[path]) return map[path];
  if (path.startsWith("/runs/")) return ["orch", "kev", "Lanes", "Trace"];
  if (path.startsWith("/projects/")) return ["orch", "kev", "Lanes"];
  return ["orch", "kev"];
}
