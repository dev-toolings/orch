// Atelier avatars: bloub (src/vendor/bloub, MIT), one animated shape per
// agent. The state follows what the agent does; the colour is its harness.
// One requestAnimationFrame clock is shared by every animated avatar; a still
// avatar (lists, reduced motion) is sampled once and never re-rendered.
import { useEffect, useMemo, useRef, useState } from "react";
import { BotEngine, type BotFrame } from "../vendor/bloub/engine";
import { NOTIF_BLUE } from "../vendor/bloub/decor";
import { mixHex } from "../vendor/bloub/skins";
import { DEMI_VIEWBOX, RAYON } from "../vendor/bloub/repere";
import type { StateId } from "../vendor/bloub/states";
import type { LeadActivity } from "../types";
import { prefersReducedMotion } from "./motion";
import { harnessHex } from "./room";

export type Role = "lead" | "lane";
export type { BotFrame, StateId };
export const VIEW = DEMI_VIEWBOX;
export const PAPER = "#fffdf9";
export { NOTIF_BLUE, RAYON };

/** What an agent's avatar plays for what it is doing. */
export function stateFor(activity: LeadActivity, role: Role): StateId {
  if (role === "lane") return activity === "blocked" ? "exclaim" : activity === "idle" ? "idle" : "play";
  if (activity === "working") return "orbit";
  if (activity === "busy") return "thinking";
  if (activity === "blocked") return "alert";
  return "idle";
}

// Kiba, the lead, is a white bloub with black eyes; a lane wears its
// harness colour. The eyes are holes showing the paper, so the paper is
// what colours them.
export const KIBA_INK = "#ffffff";
export const KIBA_PAPER = "#141414";
// Outline that keeps a white body readable on the light floor.
export const KIBA_EDGE = "#1f1d1a";

export function inkFor(harness: string | null | undefined, role: Role = "lane"): string {
  return role === "lead" ? KIBA_INK : harnessHex(harness);
}

export function paperFor(role: Role = "lane"): string {
  return role === "lead" ? KIBA_PAPER : PAPER;
}

// Shared clock: seconds since the first animated avatar mounted.
type Tick = (t: number) => void;
const subscribers = new Set<Tick>();
let raf = 0;
let clock = 0;
let last = 0;
function loop(ms: number) {
  raf = requestAnimationFrame(loop);
  // Bounded delta: a hidden tab resumes where it was instead of jumping.
  clock += last ? Math.min((ms - last) / 1000, 0.064) : 0;
  last = ms;
  for (const fn of subscribers) fn(clock);
}
function subscribe(fn: Tick): () => void {
  subscribers.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && raf) { cancelAnimationFrame(raf); raf = 0; last = 0; }
  };
}

/** The current frame of an avatar playing `state`; animated unless `still`. */
export function useBloubFrame(state: StateId, still = false): BotFrame {
  const engine = useMemo(() => new BotEngine(RAYON, state), []); // eslint-disable-line react-hooks/exhaustive-deps
  const animate = !still && !prefersReducedMotion();
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(animate ? clock : 1));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    engine.setState(state, animate ? clock : 0);
    if (!animate) setFrame(engine.sample(1.5));
  }, [state, engine, animate]);
  useEffect(() => (animate ? subscribe((t) => setFrame(engine.sample(t))) : undefined), [engine, animate]);
  return frame;
}

/** Same as the SVG, on a 2D canvas (the 3D room's textures). */
export function drawFrame(ctx: CanvasRenderingContext2D, frame: BotFrame, ink: string, paper = PAPER, edge?: string): void {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const k = width / (VIEW * 2);
  ctx.setTransform(k, 0, 0, k, width / 2, height / 2);
  const arcs = (side: "back" | "front") => {
    for (const arc of frame.arcs) {
      const g = ctx.createLinearGradient(arc.grad.x1, arc.grad.y1, arc.grad.x2, arc.grad.y2);
      arc.grad.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, arc.grad.stops.length - 1), c));
      ctx.save();
      ctx.globalAlpha = arc.opacity;
      ctx.strokeStyle = g;
      ctx.lineWidth = arc.width;
      ctx.lineCap = "round";
      ctx.stroke(new Path2D(arc[side]));
      ctx.restore();
    }
  };
  const dots = () => {
    for (const dot of frame.dots) {
      ctx.save();
      ctx.globalAlpha = dot.opacity;
      ctx.fillStyle = dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth));
      if (dot.d) {
        ctx.translate(dot.x, dot.y);
        ctx.rotate(((dot.rot ?? 0) * Math.PI) / 180);
        ctx.scale(RAYON, RAYON);
        ctx.fill(new Path2D(dot.d));
      } else {
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  };
  arcs("back");
  if (frame.dotsBehind) dots();
  // Body, then the eyes and the notch painted in paper: the holes of the SVG mask.
  ctx.save();
  ctx.globalAlpha = frame.bodyAlpha;
  ctx.fillStyle = ink;
  const body = new Path2D(frame.bodyPath);
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 6;
    ctx.stroke(body);
  }
  ctx.fill(body);
  ctx.fillStyle = paper;
  for (const eye of frame.eyes) {
    const m = /matrix\(([^)]+)\)/.exec(eye.matrix)?.[1].split(/[\s,]+/).map(Number);
    ctx.save();
    if (m && m.length === 6) ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = frame.bodyAlpha * eye.alpha;
    ctx.fill(new Path2D(eye.d));
    ctx.restore();
  }
  if (frame.notch) {
    ctx.beginPath();
    ctx.arc(frame.notch.x, frame.notch.y, frame.notch.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (!frame.dotsBehind) dots();
  if (frame.notif) {
    ctx.fillStyle = NOTIF_BLUE;
    ctx.beginPath();
    ctx.arc(frame.notif.x, frame.notif.y, frame.notif.r, 0, Math.PI * 2);
    ctx.fill();
  }
  arcs("front");
}
