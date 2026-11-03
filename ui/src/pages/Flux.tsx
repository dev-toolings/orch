import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Page } from "../components/Page";
import { useFlow } from "../lib/flow";
import type { ArchBlock, BlockTone, FlowState } from "../types";

// Kiba's architecture drawn as a line map: the main line is the path of one
// request, from your session to the repository; the dashed line below is what
// comes back to Kiba. Stations sit on a fixed grid so the picture never moves.
type Row = "top" | "main" | "back" | "low";
type Mark = "stop" | "hub" | "gate" | "end" | "side";
const PLACE: Record<string, { col: number; row: Row; mark: Mark }> = {
  operator: { col: 1, row: "main", mark: "stop" },
  lead: { col: 2, row: "main", mark: "hub" },
  dispatch: { col: 3, row: "main", mark: "stop" },
  route: { col: 4, row: "main", mark: "stop" },
  budget: { col: 5, row: "main", mark: "stop" },
  lanes: { col: 6, row: "main", mark: "stop" },
  gate: { col: 7, row: "main", mark: "gate" },
  develop: { col: 8, row: "main", mark: "end" },
  watchdog: { col: 6, row: "top", mark: "side" },
  wake: { col: 2, row: "back", mark: "side" },
  inbox: { col: 3, row: "back", mark: "side" },
  results: { col: 6, row: "back", mark: "side" },
  events: { col: 3, row: "low", mark: "side" },
};
const GRID_ROW: Record<Row, number> = { top: 2, main: 3, back: 4, low: 5 };
const ZONES = [
  { label: "Entrée", from: 1, to: 1 },
  { label: "Conduite", from: 2, to: 2 },
  { label: "Répartition", from: 3, to: 5 },
  { label: "Exécution", from: 6, to: 6 },
  { label: "Livraison", from: 7, to: 8 },
];
const MAIN = ["operator", "lead", "dispatch", "route", "budget", "lanes", "gate", "develop"];
const BACK = ["lanes", "results", "inbox", "wake", "lead"];

const METRIC: Record<BlockTone, string> = {
  idle: "text-muted-foreground",
  busy: "text-foreground",
  ok: "text-foreground",
  wait: "text-amber-500",
  bad: "text-rose-400",
};

type Point = { x: number; y: number };

function Station({ block, mark, selected, onSelect, dotRef }: {
  block: ArchBlock; mark: Mark; selected: boolean; onSelect: () => void; dotRef: (el: HTMLSpanElement | null) => void;
}) {
  const side = mark === "side";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative block w-full rounded-md pb-1 pl-8 pr-2 pt-5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        selected ? "bg-muted" : "hover:bg-muted/50"
      }`}
    >
      <span ref={dotRef} className={`arch-dot arch-${mark} ${block.tone === "busy" ? "arch-busy" : ""}`} style={{ top: 0 }} />
      <span className={`block font-semibold leading-tight ${side ? "text-[13px] text-foreground/85" : mark === "hub" ? "text-[15px]" : "text-sm"}`}>
        {block.title}
      </span>
      <span className="mt-1 block space-y-0.5 text-[12.5px] leading-[1.45] text-muted-foreground">
        {block.config.slice(0, side ? 2 : 3).map((c, n) => <span key={n} className="block">{c}</span>)}
      </span>
      {block.live ? (
        <span className={`mt-1.5 block text-[12.5px] font-medium tabular-nums ${METRIC[block.tone]}`}>{block.live}</span>
      ) : null}
    </button>
  );
}

function Detail({ block, onClose }: { block: ArchBlock; onClose: () => void }) {
  return (
    <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold">{block.title}</h2>
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          Fermer
        </button>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed">{block.about}</p>
      <h3 className="mt-5 text-xs font-semibold text-muted-foreground">Réglages</h3>
      <ul className="mt-1 space-y-1 text-[13px] leading-snug">
        {block.config.map((c, n) => <li key={n}>{c}</li>)}
      </ul>
      {block.live ? (
        <>
          <h3 className="mt-5 text-xs font-semibold text-muted-foreground">En ce moment</h3>
          <p className={`mt-1 text-[13px] tabular-nums ${METRIC[block.tone]}`}>{block.live}</p>
        </>
      ) : null}
      <h3 className="mt-5 text-xs font-semibold text-muted-foreground">Code</h3>
      <ul className="mt-1 space-y-0.5 font-mono text-[12px]">
        {block.sources.map((s) => <li key={s}>{s}</li>)}
      </ul>
    </aside>
  );
}

function Lines({ points }: { points: Record<string, Point> }) {
  const p = (id: string) => points[id];
  const path = (ids: string[]) => ids.every(p) ? ids.map((id, n) => `${n ? "L" : "M"}${p(id)!.x},${p(id)!.y}`).join(" ") : "";
  const link = (from: string, to: string) => path([from, to]);
  // The return line bends at right angles: down from the lanes, left along the row, up into Kiba.
  const back = BACK.every(p) ? `M${p("lanes")!.x},${p("lanes")!.y + 12} L${p("results")!.x},${p("results")!.y} L${p("wake")!.x},${p("wake")!.y} L${p("wake")!.x},${p("lead")!.y + 16}` : "";
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" fill="none" stroke="var(--arch-back)" strokeWidth="1.6" />
        </marker>
      </defs>
      <path d={path(MAIN)} stroke="var(--arch-line)" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d={back} stroke="var(--arch-back)" strokeWidth="2" strokeDasharray="6 5" fill="none" strokeLinejoin="round" markerEnd="url(#arch-arrow)" />
      <path d={link("events", "inbox")} stroke="var(--arch-back)" strokeWidth="2" strokeDasharray="6 5" fill="none" markerEnd="url(#arch-arrow)" />
      <path d={link("watchdog", "lanes")} stroke="var(--arch-back)" strokeWidth="2" strokeDasharray="6 5" fill="none" markerEnd="url(#arch-arrow)" />
    </svg>
  );
}

function LineMap({ state, selected, onSelect }: { state: FlowState; selected: string | null; onSelect: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const dots = useRef<Record<string, HTMLSpanElement | null>>({});
  const [points, setPoints] = useState<Record<string, Point>>({});

  const measure = useCallback(() => {
    const root = box.current?.getBoundingClientRect();
    if (!root) return;
    const next: Record<string, Point> = {};
    for (const [id, el] of Object.entries(dots.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[id] = { x: r.left - root.left + r.width / 2, y: r.top - root.top + r.height / 2 };
    }
    setPoints(next);
  }, []);
  useLayoutEffect(measure, [state, measure]);
  useEffect(() => {
    if (!box.current) return;
    const o = new ResizeObserver(measure);
    o.observe(box.current);
    return () => o.disconnect();
  }, [measure]);

  const blocks = new Map(state.blocks.map((b) => [b.id, b]));
  return (
    <div ref={box} className="relative grid min-w-[1080px] grid-cols-8 gap-x-4 gap-y-6 px-6 pb-10 pt-6" style={{ gridTemplateRows: "auto auto auto auto auto" }}>
      {ZONES.map((z) => (
        <div key={z.label} className="border-t border-border pt-1.5 text-xs text-muted-foreground" style={{ gridColumn: `${z.from} / ${z.to + 1}`, gridRow: 1 }}>
          {z.label}
        </div>
      ))}
      <p className="self-start pt-5 text-xs leading-snug text-muted-foreground" style={{ gridColumn: 1, gridRow: GRID_ROW.back }}>
        Ce qu'orch serve journalise et publie, sans que tu tapes.
      </p>
      <Lines points={points} />
      {Object.entries(PLACE).map(([id, at]) => {
        const block = blocks.get(id);
        if (!block) return null;
        return (
          <div key={id} style={{ gridColumn: at.col, gridRow: GRID_ROW[at.row] }}>
            <Station
              block={block}
              mark={at.mark}
              selected={selected === id}
              onSelect={() => onSelect(id)}
              dotRef={(el) => { dots.current[id] = el; }}
            />
          </div>
        );
      })}
    </div>
  );
}

function FluxView() {
  const { state, status } = useFlow();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const block = state?.blocks.find((b) => b.id === selected);

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-border px-6 py-4">
        <div className="max-w-[70ch]">
          <h1 className="text-lg font-semibold">Architecture de Kiba</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Le trajet d'une demande, de ta session au dépôt, avec les réglages réels de chaque étape. Clique une étape pour voir son rôle et son code.
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <svg width="28" height="8" aria-hidden><path d="M2,4 L26,4" stroke="var(--arch-line)" strokeWidth="5" strokeLinecap="round" /></svg>
            une demande
          </span>
          <span className="flex items-center gap-2">
            <svg width="28" height="8" aria-hidden><path d="M2,4 L26,4" stroke="var(--arch-back)" strokeWidth="2" strokeDasharray="6 5" /></svg>
            les retours
          </span>
          <span className={status === "live" ? "text-foreground" : "text-amber-500"}>
            {status === "live" ? "Réglages à jour" : status === "offline" ? "Hors ligne" : "Reconnexion"}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {state ? <LineMap state={state} selected={selected} onSelect={setSelected} /> : <p className="p-6 text-sm text-muted-foreground">Chargement de l'architecture...</p>}
        </div>
        {block ? <Detail block={block} onClose={() => setSelected(null)} /> : null}
      </div>
    </div>
  );
}

export function FluxPage() {
  return <Page crumbs={["orch", "kev", "Architecture"]}>{() => <FluxView />}</Page>;
}
