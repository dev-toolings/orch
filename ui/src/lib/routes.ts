// One label per route: the sidebar entry and the browser tab title read the same word.
export const APP_NAME = "Tableau Kiba";

export const PAGE_LABELS = {
  "/": "Aperçu",
  "/runs": "Lanes",
  "/approvals": "Approbations",
  "/agents": "Agents",
  "/tools": "Outils",
  "/providers": "Fournisseurs",
  "/spend": "Coûts",
  "/activity": "Activité",
  "/bus": "Bus",
  "/skills": "Compétences",
  "/atelier": "Atelier",
  "/flux": "Architecture",
} as const;

export type PagePath = keyof typeof PAGE_LABELS;

/** The sidebar choice is remembered per route kind: the Atelier wants width, the rest wants the menu. */
export type SidebarKind = "atelier" | "default";

export function sidebarKind(pathname: string): SidebarKind {
  return pathname === "/atelier" || pathname.startsWith("/atelier/") ? "atelier" : "default";
}

const SIDEBAR_KEY = "orch.sidebar.";

/** The operator's explicit choice, or the route kind's default (closed on the Atelier, open elsewhere). */
export function readSidebarOpen(kind: SidebarKind): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY + kind);
    if (raw === "open") return true;
    if (raw === "closed") return false;
  } catch {
    // storage blocked: fall through to the default
  }
  return kind !== "atelier";
}

export function storeSidebarOpen(kind: SidebarKind, open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY + kind, open ? "open" : "closed");
  } catch {
    // private mode: the choice just resets next visit
  }
}

function pageName(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  const lane = /^\/runs\/([^/]+)$/.exec(path);
  return lane ? `Lane ${decodeURIComponent(lane[1])}` : PAGE_LABELS[path as PagePath];
}

/** "Coûts · Tableau Kiba", "Lane 20261102… · Tableau Kiba"; the app name alone off the map. */
export function tabTitle(pathname: string): string {
  const page = pageName(pathname);
  return page ? `${page} · ${APP_NAME}` : APP_NAME;
}

/** "Coûts : Tableau Kiba, le tableau de bord d'orch."; the app sentence alone off the map. */
export function tabDescription(pathname: string): string {
  const page = pageName(pathname);
  const about = `${APP_NAME}, le tableau de bord d'orch.`;
  return page ? `${page} : ${about}` : about;
}
