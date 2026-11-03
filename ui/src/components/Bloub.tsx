// A bloub avatar (src/vendor/bloub, MIT) as SVG: the body with its eyes cut
// out by a mask, orbits half behind and half in front, dots and the blue
// notification dot. Same drawing as the upstream BloubBot.vue.
import { useId } from "react";
import { inkFor, KIBA_EDGE, NOTIF_BLUE, PAPER, paperFor, RAYON, stateFor, useBloubFrame, VIEW, type Role, type StateId } from "../lib/bloub";
import { mixHex } from "../vendor/bloub/skins";
import type { LeadActivity } from "../types";

export function Bloub({
  state,
  ink,
  size,
  still = false,
  paper = PAPER,
  edge,
  label,
}: {
  state: StateId;
  ink: string;
  size: number;
  still?: boolean;
  paper?: string;
  edge?: string;
  label?: string;
}) {
  const frame = useBloubFrame(state, still);
  // Small icons are cropped to the body: the default frame keeps room for the
  // orbits and leaves a 24 px avatar with 2 px eyes.
  const half = size <= 32 ? 112 : VIEW;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const mask = `bloub-mask-${uid}`;
  const dot = (d: (typeof frame.dots)[number], i: number, key: string) => {
    const fill = d.color ?? (d.depth === undefined ? ink : mixHex(paper, ink, d.depth));
    return d.d
      ? <path key={`${key}${i}`} d={d.d} fill={fill} opacity={d.opacity} transform={`translate(${d.x} ${d.y}) rotate(${d.rot ?? 0}) scale(${RAYON})`} />
      : <circle key={`${key}${i}`} cx={d.x} cy={d.y} r={d.r} fill={fill} opacity={d.opacity} />;
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x={-VIEW} y={-VIEW} width={VIEW * 2} height={VIEW * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => <path key={i} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />)}
          {frame.notch ? <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" /> : null}
        </mask>
        {frame.arcs.map((arc) => (
          <linearGradient key={arc.id} id={`${uid}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>
            {arc.grad.stops.map((c, i) => <stop key={i} offset={i / Math.max(1, arc.grad.stops.length - 1)} stopColor={c} />)}
          </linearGradient>
        ))}
      </defs>
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => <path key={`b${arc.id}`} d={arc.back} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}
      </g>
      {frame.dotsBehind ? <g>{frame.dots.map((d, i) => dot(d, i, "pb"))}</g> : null}
      <g opacity={frame.bodyAlpha}>
        {/* Paper under the body: an orbit passing behind must not show through the eyes. */}
        <path d={frame.bodyPath} fill={paper} stroke={edge} strokeWidth={edge ? 6 : undefined} />
        <g mask={`url(#${mask})`}>
          <rect x={-VIEW} y={-VIEW} width={VIEW * 2} height={VIEW * 2} fill={ink} />
        </g>
      </g>
      {!frame.dotsBehind ? <g>{frame.dots.map((d, i) => dot(d, i, "pf"))}</g> : null}
      {frame.notif ? <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} /> : null}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => <path key={`f${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}
      </g>
    </svg>
  );
}

/** An agent's avatar: its harness colour, the state of what it does. */
export function AgentBloub({ harness, activity = "idle", role = "lead", size, still = false, label }: {
  harness: string | null | undefined;
  activity?: LeadActivity;
  role?: Role;
  size: number;
  still?: boolean;
  label?: string;
}) {
  return <Bloub state={stateFor(activity, role)} ink={inkFor(harness, role)} paper={paperFor(role)} edge={role === "lead" ? KIBA_EDGE : undefined} size={size} still={still} label={label} />;
}
