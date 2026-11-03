import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useSnapshot } from "../api";
import { AppShell } from "../components/AppShell";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { hasWebGL, initialView, storeView, type ViewMode } from "../lib/motion";
import type { Selection } from "../types";
import { Floor2D } from "./Floor2D";
import { ThreadList, ThreadView, useSeen } from "../components/Threads";
import { ACTIVITY_HEX, buildRoom } from "../lib/room";
import { buildThreads } from "../lib/threads";

const Floor3D = lazy(() => import("./Floor3D"));

export function FloorPage() {
  const state = useSnapshot();
  const [params] = useSearchParams();
  const requested = params.get("vue") === "plan" ? "2d" : params.get("vue") === "casier" ? "3d" : null;
  const [view, setView] = useState<ViewMode>(() => {
    if (requested === "2d") return "2d";
    if (requested === "3d" && hasWebGL()) return "3d";
    return initialView();
  });
  const [selection, setSelection] = useState<Selection>(null);
  const [large, setLarge] = useState(() => readScene() === "large");
  // undefined follows the liveliest thread until the operator picks one.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  const changeView = (mode: ViewMode) => {
    const next = mode === "3d" && !hasWebGL() ? "2d" : mode;
    setView(next);
    storeView(next);
  };

  const snap = state.status === "ok" ? state.snap : null;
  const room = useMemo(() => (snap ? buildRoom(snap) : null), [snap]);
  const empty = useMemo(
    () => snap != null && snap.leads.length === 0 && !snap.lanes.some((lane) => lane.life === "running" || lane.life === "blocked"),
    [snap],
  );
  const threads = useMemo(
    () => (room && snap ? buildThreads(room.lines, snap.projects.map((p) => p.name), snap.tasks ?? [], Date.parse(snap.at)) : []),
    [room, snap],
  );
  // Opened by default: the most recent thread a Kiba runs in; none when no Kiba
  // runs (a resting project opens only when picked, and stays in "Au repos").
  const live = (project: string | null) => !!project && !!snap?.leads.some((lead) => lead.project === project);
  const open = picked !== undefined && threads.some((t) => t.project === picked)
    ? picked
    : threads.find((t) => live(t.project))?.project ?? null;
  const thread = threads.find((t) => t.project === open) ?? null;
  const seen = useSeen(threads, open);

  // Picking someone in the scene opens their project's thread.
  useEffect(() => {
    if (!selection || !snap) return;
    const project = selection.kind === "project"
      ? selection.name
      : selection.kind === "lead"
        ? snap.leads.find((row) => row.id === selection.id)?.project
        : snap.lanes.find((row) => row.id === selection.id)?.project;
    if (project) setPicked(project);
  }, [selection, snap]);

  const [split, setSplit] = useState(readSplit);
  const pane = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moveSplit = (clientX: number) => {
    const box = pane.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    setSplit(clampSplit(((clientX - box.left) / box.width) * 100));
  };
  const onDividerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDividerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) moveSplit(e.clientX);
  };
  const onDividerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    storeSplit(split);
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -2 : e.key === "ArrowRight" ? 2 : 0;
    if (!step) return;
    e.preventDefault();
    const next = clampSplit(split + step);
    setSplit(next);
    storeSplit(next);
  };

  const toggleScene = () => {
    setLarge(!large);
    storeScene(large ? "mini" : "large");
  };

  return (
    <AppShell snap={snap} stream={state.stream}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-sm font-semibold">Atelier</h1>
          <div className="flex rounded-full border border-border" role="group" aria-label="Vue de l'atelier">
            <button type="button" className={`rounded-full px-3 py-1 text-sm ${view === "3d" ? "bg-muted text-foreground" : "text-muted-foreground"}`} aria-pressed={view === "3d"} onClick={() => changeView("3d")}>Maquette</button>
            <button type="button" className={`rounded-full px-3 py-1 text-sm ${view === "2d" ? "bg-muted text-foreground" : "text-muted-foreground"}`} aria-pressed={view === "2d"} onClick={() => changeView("2d")}>Plan</button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {room ? (
            <aside className="flex min-h-0 shrink-0 flex-col border-b border-border lg:w-60 lg:border-r lg:border-b-0">
              <ThreadList threads={threads} open={open} onOpen={setPicked} seen={seen} leads={snap?.leads ?? []} />
            </aside>
          ) : null}
          <div ref={pane} className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
            <div
              style={{ ["--split" as string]: `${split}%` }}
              className={`relative shrink-0 overflow-hidden border-b border-border lg:border-b-0 ${large || !room ? "min-h-0 flex-1" : "min-h-0 grow-0 basis-3/5 lg:basis-[var(--split)]"}`}
            >
              {state.status === "loading" ? <LoadingState /> : null}
              {state.status === "error" ? <ErrorState message={state.message} /> : null}
              {snap && empty ? <EmptyState /> : null}
              {snap && !empty && room ? (
                <div className="absolute inset-0">
                  {view === "3d" ? (
                    <Suspense fallback={<LoadingState />}>
                      <Floor3D snap={snap} selection={selection} onSelect={setSelection} />
                    </Suspense>
                  ) : (
                    <div className="h-full overflow-auto">
                      <Floor2D snap={snap} selection={selection} onSelect={setSelection} />
                    </div>
                  )}
                  {large ? <RoomFooter idle={room.idle} onSelect={setSelection} /> : null}
                </div>
              ) : null}
              {room ? (
                <button
                  type="button"
                  onClick={toggleScene}
                  aria-expanded={large}
                  className="absolute top-2 right-2 z-10 rounded-full border border-border bg-card/90 px-3 py-1 text-xs text-muted-foreground backdrop-blur hover:text-foreground"
                >
                  {large ? "Réduire la maquette" : "Agrandir la maquette"}
                </button>
              ) : null}
            </div>
            {room && !large ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Redimensionner la maquette et la conversation"
                aria-valuemin={SPLIT_MIN}
                aria-valuemax={SPLIT_MAX}
                aria-valuenow={Math.round(split)}
                tabIndex={0}
                onPointerDown={onDividerDown}
                onPointerMove={onDividerMove}
                onPointerUp={onDividerUp}
                onPointerCancel={onDividerUp}
                onKeyDown={onDividerKey}
                className="hidden w-1 shrink-0 cursor-col-resize touch-none border-l border-border hover:bg-muted focus-visible:bg-muted lg:block"
              />
            ) : null}
            {room && !large ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-border lg:border-t-0">
                <ThreadView thread={thread} selection={selection} onSelect={setSelection} />
              </div>
            ) : null}
            {snap ? <Panel snap={snap} selection={selection} onClose={() => setSelection(null)} /> : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

const SCENE_KEY = "orch.atelier.scene";

function readScene(): string | null {
  try {
    return localStorage.getItem(SCENE_KEY);
  } catch {
    return null;
  }
}

function storeScene(size: "mini" | "large"): void {
  try {
    localStorage.setItem(SCENE_KEY, size);
  } catch {
    // private mode: the size just resets next visit
  }
}

const SPLIT_KEY = "orch.atelier.split";
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;

function clampSplit(value: number): number {
  return Number.isFinite(value) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value)) : 50;
}

function readSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    return raw === null ? 50 : clampSplit(Number(raw));
  } catch {
    return 50;
  }
}

function storeSplit(value: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(value * 10) / 10));
  } catch {
    // private mode: the ratio just resets next visit
  }
}

const LEGEND: { key: keyof typeof ACTIVITY_HEX; label: string }[] = [
  { key: "working", label: "en cours" },
  { key: "busy", label: "occupé" },
  { key: "blocked", label: "bloqué" },
];

/** Projects with nobody present, plus the halo key. Sits over the scene. */
function RoomFooter({ idle, onSelect }: { idle: string[]; onSelect: (next: Selection) => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-6 px-4 pb-3">
      {idle.length ? (
        <div className="pointer-events-auto max-w-2xl text-xs leading-6">
          <span className="mr-2 font-medium text-muted-foreground">Au repos</span>
          {idle.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelect({ kind: "project", name })}
              className="mr-2.5 text-muted-foreground/80 hover:text-foreground"
            >
              {name}
            </button>
          ))}
        </div>
      ) : <span />}
      <ul className="flex shrink-0 gap-3 text-xs text-muted-foreground" aria-label="Halo d'activité">
        {LEGEND.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full ring-2 ring-inset" style={{ ["--tw-ring-color" as string]: ACTIVITY_HEX[item.key] }} />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
