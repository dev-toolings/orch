import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, ContactShadows, Html, Line, OrbitControls, QuadraticBezierLine, Text } from "@react-three/drei";
import interSemibold from "@fontsource/inter/files/inter-latin-600-normal.woff?url";
import interRegular from "@fontsource/inter/files/inter-latin-400-normal.woff?url";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CanvasTexture, QuadraticBezierCurve3, SRGBColorSpace, Vector3, type Group, type Mesh } from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { DashTask, DashSnapshot, LeadActivity, Selection } from "../types";
import { prefersReducedMotion } from "../lib/motion";
import { drawFrame, inkFor, KIBA_EDGE, paperFor, RAYON, stateFor, type Role } from "../lib/bloub";
import { BotEngine } from "../vendor/bloub/engine";
import { ACTIVITY_HEX, ago, buildRoom, deskTasks, harnessHex, taskLine, lastWord, laneActivity, resolveOverlays, type OverlayBox, type Room, type RoomDesk, type RoomLine } from "../lib/room";

// The atelier as an architect's scale model: card-stock floor, low walls,
// one desk per project with a lead present, lanes standing beside it.
const CELL = { w: 5.6, d: 5.2 };
const MAT = {
  floor: "#d9d4cb",
  zone: "#e6e2da",
  zoneHot: "#efebe4",
  wall: "#ece8e1",
  desk: "#f6f3ee",
  ink: "#1f1d1a",
  laptop: "#45423d",
  metal: "#9a958c",
  deskSide: "#e9e5de",
  key: "#d8d3ca",
  chair: "#3f3d39",
  mug: "#ffffff",
  pot: "#8f8b84",
  leaf: "#5d8758",
};
const TOP = 0.74; // desk top height
const SEAT = 0.5; // chair seat height
const SPRITE = 1.35; // avatar plane width in world units
const LANE_HEAD = 0.72 * (0.06 + SPRITE * 1.2); // top of a standing lane's avatar
const OVERLAY_GAP = 8; // px between an actor's head and its overlay
const TAIL_X = 18; // the bubble's tail sits this far from its right edge

type Vec3 = [number, number, number];

interface Placed {
  desk: RoomDesk;
  x: number;
  z: number;
}

export default function Floor3D({
  snap,
  selection,
  onSelect,
}: {
  snap: DashSnapshot;
  selection: Selection;
  onSelect: (next: Selection) => void;
}) {
  const room = useMemo(() => buildRoom(snap), [snap]);
  const quiet = prefersReducedMotion();
  const W = room.cols * CELL.w + 0.8;
  const D = room.rows * CELL.d + 0.8;
  const placed: Placed[] = room.desks.map((desk) => ({
    desk,
    x: (desk.col - (room.cols - 1) / 2) * CELL.w,
    z: (desk.row - (room.rows - 1) / 2) * CELL.d,
  }));
  const overlays = useMemo<OverlayReg>(() => ({ items: new Map(), version: 0 }), []);
  const shape = placed.map((p) => `${p.desk.project}:${p.desk.leads.length}:${p.desk.lanes.length}`).join("|");

  return (
    <Canvas
      orthographic
      frameloop={quiet ? "demand" : "always"}
      camera={{ position: [14, 13, 14], zoom: 40, near: -200, far: 400 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      onPointerMissed={() => onSelect(null)}
    >
      <hemisphereLight args={["#ffffff", "#a69d90", 1.15]} />
      <directionalLight position={[6, 12, 3]} intensity={1.7} color="#fff3e2" />
      <directionalLight position={[-8, 5, 9]} intensity={0.35} color="#dfe8ff" />
      <OverlayCtx.Provider value={overlays}>
      <OverlayLayout reg={overlays} />
      <Fit w={W} d={D} />
      <Plinth w={W} d={D} />
      {placed.map((p) => (
        <Desk
          key={p.desk.project}
          placed={p}
          room={room}
          tasks={deskTasks(snap, p.desk)}
          selection={selection}
          quiet={quiet}
          onSelect={onSelect}
        />
      ))}
      {room.links.map((link) => {
        const a = placed.find((p) => p.desk.project === link.from);
        const b = placed.find((p) => p.desk.project === link.to);
        if (!a || !b) return null;
        return <Courier key={link.id} from={[a.x, 1.6, a.z - 1.1]} to={[b.x, 1.6, b.z - 1.1]} lift={2.6} color={MAT.ink} quiet={quiet} />;
      })}
      </OverlayCtx.Provider>
      <ContactShadows key={shape} position={[0, 0.012, 0]} scale={[W, D]} blur={2.2} far={2.4} opacity={0.42} frames={1} resolution={512} />
      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        enableRotate
        enablePan
        enableZoom
        enableDamping={!quiet}
        minPolarAngle={0.55}
        maxPolarAngle={1.15}
        minAzimuthAngle={Math.PI / 4 - 0.6}
        maxAzimuthAngle={Math.PI / 4 + 0.6}
      />
    </Canvas>
  );
}

/** Frame the whole plinth on load and on resize; the operator can zoom after. */
function Fit({ w, d }: { w: number; d: number }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const span = (w + d) * Math.SQRT1_2;
    const tall = (w + d) * 0.41 + 2.4;
    camera.zoom = Math.max(8, Math.min(size.width / (span * 1.04), size.height / (tall * 1.06)));
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, w, d, invalidate]);
  return null;
}

function Plinth({ w, d }: { w: number; d: number }) {
  return (
    <group>
      <mesh position={[0, -0.25, 0]}>
        <boxGeometry args={[w, 0.5, d]} />
        <meshStandardMaterial color={MAT.floor} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.55, -d / 2 + 0.08]}>
        <boxGeometry args={[w, 1.1, 0.16]} />
        <meshStandardMaterial color={MAT.wall} roughness={0.9} />
      </mesh>
      <mesh position={[-w / 2 + 0.08, 0.55, 0.08]}>
        <boxGeometry args={[0.16, 1.1, d - 0.16]} />
        <meshStandardMaterial color={MAT.wall} roughness={0.9} />
      </mesh>
    </group>
  );
}

function Desk({
  placed,
  room,
  tasks,
  selection,
  quiet,
  onSelect,
}: {
  placed: Placed;
  room: Room;
  tasks: DashTask[];
  selection: Selection;
  quiet: boolean;
  onSelect: (next: Selection) => void;
}) {
  const { desk, x, z } = placed;
  const selected = selection?.kind === "project" && selection.name === desk.project;
  const [hover, setHover] = useState(false);
  const zw = CELL.w - 0.5;
  const zd = CELL.d - 0.5;
  // One workstation per lead, side by side; the lead sits behind it facing the room.
  const stationX = (i: number) => (i - (desk.leads.length - 1) / 2) * 2.1;
  const leadAt = (i: number): Vec3 => [stationX(i), 0, -1.3];
  const laneX0 = desk.leads.length ? stationX(desk.leads.length - 1) + 1.55 : -0.4;
  const laneAt = (i: number): Vec3 => [laneX0 + Math.floor(i / 3) * 0.85, 0, -1.0 + (i % 3) * 0.95];
  const word = lastWord(room, desk.project);
  const speakerAt = anchorOf(word, desk, leadAt, laneAt);
  const origin: [number, number] = [x, z];
  // One overlay per actor: the lane that speaks shows its bubble, not its tag.
  const speakingLane = word && word.speaker.kind === "lane" && desk.lanes.some((lane) => lane.id === word.speaker.id) ? word.speaker.id : null;
  const lead0 = leadAt(0);
  const meta = deskMeta(desk);
  const titleSize = Math.max(0.22, Math.min(0.42, (zw - 0.64 - meta.length * 0.14 - 0.2) / (Math.max(1, desk.project.length) * 0.58)));
  const pick = (ev: ThreeEvent<MouseEvent>) => {
    ev.stopPropagation();
    onSelect({ kind: "project", name: desk.project });
  };

  return (
    <group position={[x, 0, z]}>
      <mesh
        position={[0, 0.004, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={pick}
        onPointerOver={(ev) => { ev.stopPropagation(); setHover(true); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = ""; }}
      >
        <planeGeometry args={[zw, zd]} />
        <meshStandardMaterial color={hover || selected ? MAT.zoneHot : MAT.zone} roughness={1} />
      </mesh>
      {selected ? (
        <Line
          points={[[-zw / 2, 0.02, -zd / 2], [zw / 2, 0.02, -zd / 2], [zw / 2, 0.02, zd / 2], [-zw / 2, 0.02, zd / 2], [-zw / 2, 0.02, -zd / 2]]}
          color={MAT.ink}
          lineWidth={1.5}
        />
      ) : null}
      <Plant position={[zw / 2 - 0.45, 0, -zd / 2 + 0.45]} />
      {desk.leads.map((lead, i) => {
        const at = leadAt(i);
        return (
          <group key={lead.id}>
            <Station x={stationX(i)} activity={lead.activity} onClick={pick} />
            <Figure
              position={at}
              harness={lead.harness}
              activity={lead.activity}
              role="lead"
              seated
              scale={1}
              selected={selection?.kind === "lead" && selection.id === lead.id}
              quiet={quiet}
              label={`Kiba, ${desk.project}`}
              onClick={() => onSelect({ kind: "lead", id: lead.id })}
            />
          </group>
        );
      })}
      {desk.lanes.map((lane, i) => {
        const at = laneAt(i);
        const activity = laneActivity(lane);
        return (
          <group key={lane.id}>
            <SideTable position={[at[0], 0, at[2] + 0.5]} />
            {desk.leads.length ? (
              <Courier
                from={[lead0[0], 1.9, lead0[2]]}
                to={[at[0], 1.2, at[2]]}
                lift={0.9}
                color={ACTIVITY_HEX[activity]}
                quiet={quiet || activity === "blocked"}
              />
            ) : null}
            <Figure
              position={at}
              harness={lane.harness}
              activity={activity}
              role="lane"
              scale={0.72}
              selected={selection?.kind === "lane" && selection.id === lane.id}
              quiet={quiet}
              label={`Lane ${lane.harness}, ${desk.project}`}
              onClick={() => onSelect({ kind: "lane", id: lane.id })}
            />
            {speakingLane === lane.id ? null : (
              <LaneProgress
                id={`${desk.project}:tag:${lane.id}`}
                origin={origin}
                at={[at[0], LANE_HEAD, at[2]]}
                task={tasks.find((i) => i.progress?.id === lane.id)}
              />
            )}
          </group>
        );
      })}
      {/* Title on the zone's front edge, clear of every desk and stool, drawn over them. */}
      <group position={[-zw / 2 + 0.32, 0.016, zd / 2 - 0.14]} rotation={[-Math.PI / 2, 0, 0]}>
        <Text
          font={interSemibold}
          fontSize={titleSize}
          color={MAT.ink}
          anchorX="left"
          anchorY="bottom"
          whiteSpace="nowrap"
          letterSpacing={-0.02}
          renderOrder={20}
          material-depthTest={false}
        >
          {desk.project}
        </Text>
        <Text
          font={interRegular}
          fontSize={0.24}
          color="#5f5a52"
          anchorX="right"
          anchorY="bottom"
          whiteSpace="nowrap"
          position={[zw - 0.64, 0, 0]}
          renderOrder={20}
          material-depthTest={false}
        >
          {meta}
        </Text>
      </group>
      {word && speakerAt ? (
        <Overlay id={`${desk.project}:bubble`} origin={origin} anchor={speakerAt} prio={2} align="tail">
          <Bubble line={word} />
        </Overlay>
      ) : null}
    </group>
  );
}

// The orch serve task a lane runs, as in the plan view: state, step, phase,
// turns and what it is doing now, floating over the lane's figure.
function LaneProgress({ id, origin, at, task }: { id: string; origin: [number, number]; at: Vec3; task?: DashTask }) {
  if (!task?.progress) return null;
  const full = `${task.id} · ${taskLine(task)}`;
  const more = task.progress.lastText ?? task.objective;
  return (
    <Overlay id={id} origin={origin} anchor={at} prio={1} align="center">
      <div className="atelier-progress w-max max-w-[13rem] truncate" title={more ? `${full}\n${more}` : full}>
        <span className="font-mono">{task.id}</span> · {taskLine(task)}
      </div>
    </Overlay>
  );
}

function deskMeta(desk: RoomDesk): string {
  const leads = desk.leads.length;
  const lanes = desk.lanes.length;
  const parts = [];
  if (leads) parts.push(leads > 1 ? `${leads} Kiba` : "Kiba");
  if (lanes) parts.push(lanes > 1 ? `${lanes} lanes` : "1 lane");
  return parts.join(", ") || "Courrier en attente";
}

function anchorOf(
  word: RoomLine | null,
  desk: RoomDesk,
  leadAt: (i: number) => Vec3,
  laneAt: (i: number) => Vec3,
): Vec3 | null {
  if (!word) return null;
  if (word.speaker.kind === "lane") {
    const i = desk.lanes.findIndex((lane) => lane.id === word.speaker.id);
    if (i >= 0) {
      const at = laneAt(i);
      return [at[0], LANE_HEAD, at[2]];
    }
  }
  const i = Math.max(0, desk.leads.findIndex((lead) => lead.id === word.speaker.id));
  const at = desk.leads.length ? leadAt(i) : [0, 0, -0.2] as Vec3;
  return [at[0], desk.leads.length ? SEAT + SPRITE * 1.2 : 1.2, at[2]];
}

function Bubble({ line }: { line: RoomLine }) {
  return (
    <div className="atelier-bubble" data-role={line.speaker.kind} data-tone={line.tone} style={{ transform: "none" }}>
      <p className="atelier-bubble-who">
        <span>{line.speaker.name}</span>
        <time dateTime={line.at}>{ago(line.at)}</time>
      </p>
      <p className="atelier-bubble-text">{line.text}</p>
    </div>
  );
}

interface OverlayEntry {
  ref: { current: HTMLDivElement | null };
  anchor: Vec3; // world space
  prio: number;
  align: "tail" | "center";
}
interface OverlayReg {
  items: Map<string, OverlayEntry>;
  version: number;
}
const OverlayCtx = createContext<OverlayReg | null>(null);

/** An HTML label tied to a world point; OverlayLayout places it in screen space. */
function Overlay({
  id,
  origin,
  anchor,
  prio,
  align,
  children,
}: {
  id: string;
  origin: [number, number];
  anchor: Vec3;
  prio: number;
  align: "tail" | "center";
  children: ReactNode;
}) {
  const reg = useContext(OverlayCtx);
  const invalidate = useThree((s) => s.invalidate);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reg) return;
    reg.items.set(id, { ref, anchor: [origin[0] + anchor[0], anchor[1], origin[1] + anchor[2]], prio, align });
    reg.version++;
    invalidate();
  });
  useEffect(
    () => () => {
      if (!reg) return;
      reg.items.delete(id);
      reg.version++;
      invalidate();
    },
    [reg, id, invalidate],
  );
  return (
    <Html position={anchor} zIndexRange={[40, 30]} style={{ pointerEvents: "none" }}>
      <div ref={ref} className="w-max">{children}</div>
    </Html>
  );
}

/**
 * Projects every overlay, sits it OVERLAY_GAP px above its actor's head, then
 * runs the greedy collision pass. Redone only when the camera, the canvas, or
 * the set of overlays changes.
 */
function OverlayLayout({ reg }: { reg: OverlayReg }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const last = useRef("");
  const retries = useRef(0);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    let ready = 0;
    reg.items.forEach((e) => { if (e.ref.current) ready++; });
    const p = camera.position;
    const sig = `${reg.version}|${ready}|${size.width}|${size.height}|${camera.zoom}|${p.x}|${p.y}|${p.z}`;
    if (sig === last.current) return;
    last.current = sig;
    if (ready < reg.items.size && retries.current++ < 60) {
      // Html content mounts a tick late; look again (demand mode renders no further frame).
      last.current = "";
      invalidate();
    } else if (ready === reg.items.size) {
      retries.current = 0;
    }
    camera.updateMatrixWorld();
    const boxes: OverlayBox[] = [];
    const base = new Map<string, { el: HTMLDivElement; sx: number; sy: number; x: number; y: number }>();
    reg.items.forEach((e, id) => {
      const el = e.ref.current;
      if (!el) return;
      v.set(e.anchor[0], e.anchor[1], e.anchor[2]).project(camera);
      const sx = ((v.x + 1) / 2) * size.width;
      const sy = ((1 - v.y) / 2) * size.height;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = sx - (e.align === "tail" ? w - TAIL_X : w / 2);
      const y = sy - h - OVERLAY_GAP;
      base.set(id, { el, sx, sy, x, y });
      boxes.push({ id, x, y, w, h, prio: e.prio });
    });
    const placed = resolveOverlays(boxes);
    base.forEach((b, id) => {
      const at = placed.get(id);
      b.el.style.transform = `translate(${b.x - b.sx}px, ${b.y + (at?.dy ?? 0) - b.sy}px)`;
      b.el.style.visibility = at?.hidden ? "hidden" : "visible";
    });
  });
  return null;
}

const LEGS: [number, number][] = [[-0.84, -0.37], [0.84, -0.37], [-0.84, 0.37], [0.84, 0.37]];

/** A desk on legs: monitor facing the lead, keyboard, mouse, mug, chair behind. */
function Station({ x, activity, onClick }: { x: number; activity: LeadActivity; onClick: (ev: ThreeEvent<MouseEvent>) => void }) {
  const lit = activity !== "idle";
  return (
    <group position={[x, 0, -0.35]} onClick={onClick}>
      <mesh position={[0, TOP - 0.03, 0]}>
        <boxGeometry args={[1.8, 0.06, 0.85]} />
        <meshStandardMaterial color={MAT.desk} roughness={0.7} />
      </mesh>
      {LEGS.map(([lx, lz]) => (
        <mesh key={`${lx}:${lz}`} position={[lx, (TOP - 0.06) / 2, lz]}>
          <boxGeometry args={[0.05, TOP - 0.06, 0.05]} />
          <meshStandardMaterial color={MAT.metal} roughness={0.4} metalness={0.3} />
        </mesh>
      ))}
      <mesh position={[0, 0.44, 0.37]}>
        <boxGeometry args={[1.62, 0.46, 0.02]} />
        <meshStandardMaterial color={MAT.deskSide} roughness={0.85} />
      </mesh>
      {/* Monitor: its back faces the room, the screen faces the lead. */}
      <mesh position={[0, TOP + 0.01, 0.14]}>
        <boxGeometry args={[0.32, 0.02, 0.2]} />
        <meshStandardMaterial color={MAT.laptop} roughness={0.5} />
      </mesh>
      <mesh position={[0, TOP + 0.17, 0.17]}>
        <boxGeometry args={[0.06, 0.32, 0.04]} />
        <meshStandardMaterial color={MAT.laptop} roughness={0.5} />
      </mesh>
      <mesh position={[0, TOP + 0.43, 0.13]}>
        <boxGeometry args={[0.94, 0.54, 0.04]} />
        <meshStandardMaterial color={MAT.laptop} roughness={0.45} />
      </mesh>
      <mesh position={[0, TOP + 0.43, 0.108]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[0.88, 0.48]} />
        <meshBasicMaterial color={lit ? "#cfe3ff" : "#2a2926"} />
      </mesh>
      <mesh position={[0.4, TOP + 0.22, 0.151]}>
        <circleGeometry args={[0.028, 16]} />
        <meshBasicMaterial color={ACTIVITY_HEX[activity]} />
      </mesh>
      <mesh position={[0, TOP + 0.012, -0.2]}>
        <boxGeometry args={[0.62, 0.025, 0.18]} />
        <meshStandardMaterial color={MAT.key} roughness={0.6} />
      </mesh>
      <mesh position={[0.45, TOP + 0.015, -0.2]}>
        <boxGeometry args={[0.08, 0.03, 0.12]} />
        <meshStandardMaterial color={MAT.key} roughness={0.6} />
      </mesh>
      <mesh position={[-0.68, TOP + 0.07, -0.16]}>
        <cylinderGeometry args={[0.06, 0.055, 0.14, 20]} />
        <meshStandardMaterial color={MAT.mug} roughness={0.4} />
      </mesh>
      <group position={[0, 0, -0.95]}>
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[0.26, 0.26, 0.04, 5]} />
          <meshStandardMaterial color={MAT.chair} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.26, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.4, 12]} />
          <meshStandardMaterial color={MAT.metal} roughness={0.4} />
        </mesh>
        <mesh position={[0, SEAT - 0.03, 0]}>
          <boxGeometry args={[0.52, 0.07, 0.5]} />
          <meshStandardMaterial color={MAT.chair} roughness={0.7} />
        </mesh>
        <mesh position={[0, SEAT + 0.32, -0.24]}>
          <boxGeometry args={[0.5, 0.58, 0.06]} />
          <meshStandardMaterial color={MAT.chair} roughness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

/** A lane's small table: a laptop whose screen faces the lane standing behind it. */
function SideTable({ position }: { position: Vec3 }) {
  const top = 0.56;
  return (
    <group position={position}>
      <mesh position={[0, top - 0.02, 0]}>
        <boxGeometry args={[0.62, 0.04, 0.4]} />
        <meshStandardMaterial color={MAT.desk} roughness={0.7} />
      </mesh>
      <mesh position={[0, (top - 0.04) / 2, 0]}>
        <cylinderGeometry args={[0.03, 0.03, top - 0.04, 12]} />
        <meshStandardMaterial color={MAT.metal} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.18, 0.18, 0.03, 20]} />
        <meshStandardMaterial color={MAT.metal} roughness={0.4} />
      </mesh>
      <mesh position={[0, top + 0.012, -0.04]}>
        <boxGeometry args={[0.4, 0.02, 0.26]} />
        <meshStandardMaterial color={MAT.laptop} roughness={0.5} />
      </mesh>
      <mesh position={[0, top + 0.13, 0.1]} rotation={[0.25, 0, 0]}>
        <boxGeometry args={[0.4, 0.24, 0.015]} />
        <meshStandardMaterial color={MAT.laptop} roughness={0.45} />
      </mesh>
    </group>
  );
}

function Plant({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[0.22, 0.17, 0.36, 20]} />
        <meshStandardMaterial color={MAT.pot} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.62, 0]}>
        <icosahedronGeometry args={[0.34, 0]} />
        <meshStandardMaterial color={MAT.leaf} roughness={0.8} flatShading />
      </mesh>
      <mesh position={[0.12, 0.9, 0.06]}>
        <icosahedronGeometry args={[0.22, 0]} />
        <meshStandardMaterial color={MAT.leaf} roughness={0.8} flatShading />
      </mesh>
    </group>
  );
}

/**
 * The agent's bloub (src/vendor/bloub) drawn on a canvas, as a texture: the
 * state follows its activity, the colour its harness. Redrawn every frame of
 * the scene, once only when motion is reduced.
 */
function useBloubTexture(harness: string, activity: LeadActivity, role: Role, quiet: boolean): CanvasTexture {
  const state = stateFor(activity, role);
  const engine = useMemo(() => new BotEngine(RAYON, state), []); // eslint-disable-line react-hooks/exhaustive-deps
  const canvas = useMemo(() => Object.assign(document.createElement("canvas"), { width: 256, height: 256 }), []);
  const tex = useMemo(() => {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [canvas]);
  const now = useRef(0);
  const drawn = useRef(false);
  const ink = inkFor(harness, role);
  useEffect(() => {
    engine.setState(state, now.current);
    drawn.current = false;
  }, [engine, state]);
  useEffect(() => { drawn.current = false; }, [ink]);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame(({ clock, invalidate }) => {
    if (quiet && drawn.current) return;
    now.current = quiet ? 1.5 : clock.elapsedTime;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawFrame(ctx, engine.sample(now.current), ink, paperFor(role), role === "lead" ? KIBA_EDGE : undefined);
    tex.needsUpdate = true;
    if (quiet && !drawn.current) invalidate();
    drawn.current = true;
  });
  return tex;
}

/** A figurine in the harness colour; the floor halo carries its activity. */
function Figure({
  position,
  harness,
  activity,
  role,
  seated = false,
  scale,
  selected,
  quiet,
  label,
  onClick,
}: {
  position: Vec3;
  harness: string;
  activity: LeadActivity;
  role: Role;
  seated?: boolean;
  scale: number;
  selected: boolean;
  quiet: boolean;
  label: string;
  onClick: () => void;
}) {
  const body = useRef<Group>(null);
  const halo = useRef<Mesh>(null);
  const phase = useMemo(() => (position[0] * 7.3 + position[2] * 3.1) % (Math.PI * 2), [position]);
  const moving = !quiet && (activity === "working" || activity === "busy");
  const lift = selected ? 0.16 : 0;
  useFrame(({ clock }) => {
    if (!moving) return;
    const t = clock.elapsedTime;
    if (body.current) body.current.position.y = lift + Math.max(0, Math.sin(t * (activity === "working" ? 3.2 : 1.6) + phase)) * 0.05;
    if (halo.current) {
      const k = 1 + ((t * 0.7 + phase) % 1) * 0.35;
      halo.current.scale.set(k, k, 1);
      (halo.current.material as { opacity: number }).opacity = 0.75 * (1.35 - k) / 0.35;
    }
  });
  const color = harnessHex(harness);
  const tex = useBloubTexture(harness, activity, role, quiet);
  const glow = ACTIVITY_HEX[activity];
  const handle = (ev: ThreeEvent<MouseEvent>) => {
    ev.stopPropagation();
    onClick();
  };
  return (
    <group
      position={position}
      scale={scale}
      onClick={handle}
      onPointerOver={(ev) => { ev.stopPropagation(); document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = ""; }}
      name={label}
    >
      {activity !== "idle" ? (
        <mesh ref={halo} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.34, 0.44, 48]} />
          <meshBasicMaterial color={glow} transparent opacity={0.75} depthWrite={false} />
        </mesh>
      ) : null}
      {selected ? (
        <mesh position={[0, 0.021, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.56, 48]} />
          <meshBasicMaterial color={MAT.ink} />
        </mesh>
      ) : null}
      <group ref={body} position={[0, lift, 0]}>
        {seated ? null : (
          <mesh position={[0, 0.04, 0]}>
            <cylinderGeometry args={[0.3, 0.32, 0.08, 32]} />
            <meshStandardMaterial color={color} roughness={0.6} />
          </mesh>
        )}
        {/* Upright billboard (turns on Y only), stretched to undo the isometric squash. */}
        <Billboard lockX lockZ position={[0, (seated ? SEAT : 0.06) + SPRITE * 1.2 * 0.42, 0]}>
          <mesh>
            <planeGeometry args={[SPRITE, SPRITE * 1.2]} />
            <meshBasicMaterial map={tex} transparent alphaTest={0.02} depthWrite={false} toneMapped={false} />
          </mesh>
        </Billboard>
      </group>
    </group>
  );
}

/** A curved path with a sheet of paper travelling along it: a spec handed to a lane, or a bus message. */
function Courier({ from, to, lift, color, quiet }: { from: Vec3; to: Vec3; lift: number; color: string; quiet: boolean }) {
  const mid: Vec3 = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + lift, (from[2] + to[2]) / 2];
  const curve = useMemo(
    () => new QuadraticBezierCurve3(new Vector3(from[0], from[1], from[2]), new Vector3(mid[0], mid[1], mid[2]), new Vector3(to[0], to[1], to[2])),
    [from[0], from[1], from[2], to[0], to[1], to[2], mid[1]],
  );
  const sheet = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (quiet || !sheet.current) return;
    const t = (clock.elapsedTime * 0.45) % 1;
    sheet.current.position.copy(curve.getPoint(t));
    sheet.current.rotation.y = t * Math.PI;
  });
  return (
    <group>
      <QuadraticBezierLine start={from} end={to} mid={mid} color={color} lineWidth={1.25} dashed dashSize={0.12} gapSize={0.09} transparent opacity={0.8} />
      {quiet ? null : (
        <mesh ref={sheet} position={from}>
          <boxGeometry args={[0.2, 0.01, 0.26]} />
          <meshStandardMaterial color="#ffffff" roughness={0.9} />
        </mesh>
      )}
    </group>
  );
}
