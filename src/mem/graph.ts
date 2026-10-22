// graph: `orch mem graph` draws the readable notes and their links as one
// self-contained HTML file (inline script, no CDN, no server) and prints its
// file:// URL. Links come from the notes themselves, no model: a supersede
// chain, shared tags, and close pairs from similar.ts. The page only renders
// what memGraph() computed. Idea from graphify's graph.html.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateDir } from "../core/paths.ts";
import { type Caller, closePairs, listNotes, type Scope } from "./mem.ts";
import { badge, standings } from "./outcome.ts";

// A tag carried by more notes than this is a hub (a repo name, "orch"): it
// would draw a clique, not a relation.
export const MAX_TAG_NOTES = 10;

export interface GraphNode {
  id: string;
  scope: Scope;
  status: string;
  date: string;
  tags: string[];
  label: string;
  body: string;
  standing?: string; // trusted | tentative | contested | dead_end
  badge?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "supersedes" | "tags" | "similar";
  label: string;
}

type Opts = { state?: string; cwd?: string; scope?: Scope; all?: boolean };

export function memGraph(caller: Caller, opts: Opts = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const notes = listNotes(caller, opts);
  const known = new Set(notes.map((n) => n.id));
  const standing = new Map(standings(caller, opts).map((s) => [s.note.id, s]));
  const nodes = notes.map((n): GraphNode => {
    const s = standing.get(n.id);
    const first = n.body.split("\n")[0];
    return {
      id: n.id, scope: n.scope, status: n.status ?? "active", date: n.date.slice(0, 10), tags: n.tags,
      label: first.length > 80 ? `${first.slice(0, 77)}...` : first, body: n.body,
      ...(s ? { standing: s.kind, badge: badge(s) } : {}),
    };
  });
  const edges: GraphEdge[] = [];
  const linked = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  for (const n of notes) {
    if (n.supersedes && known.has(n.supersedes)) {
      edges.push({ from: n.id, to: n.supersedes, kind: "supersedes", label: "supersedes" });
      linked.add(key(n.id, n.supersedes));
    }
  }
  const byTag = new Map<string, string[]>();
  for (const n of notes) for (const t of new Set(n.tags.map((t) => t.toLowerCase()))) byTag.set(t, [...(byTag.get(t) ?? []), n.id]);
  const shared = new Map<string, string[]>();
  for (const [tag, ids] of byTag) {
    if (ids.length < 2 || ids.length > MAX_TAG_NOTES) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = key(ids[i], ids[j]);
      shared.set(k, [...(shared.get(k) ?? []), tag]);
    }
  }
  for (const [k, tags] of [...shared].sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = k.split(" ");
    edges.push({ from, to, kind: "tags", label: tags.sort().join(", ") });
    linked.add(k);
  }
  for (const p of closePairs(caller, { ...opts, limit: Number.MAX_SAFE_INTEGER })) {
    const k = key(p.newer.id, p.older.id);
    if (!known.has(p.newer.id) || !known.has(p.older.id) || linked.has(k)) continue;
    edges.push({ from: p.newer.id, to: p.older.id, kind: "similar", label: `similar ${p.score.toFixed(2)}` });
    linked.add(k);
  }
  return { nodes, edges };
}

// The data goes in as JSON with every "<" escaped, so a note body can never
// close the script tag; the page writes note text with textContent only.
export function graphHtml(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, title: string): string {
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return PAGE.replaceAll("__TITLE__", title.replace(/[<>&"]/g, "")).replace("__DATA__", () => data);
}

export function writeGraph(caller: Caller, opts: Opts & { out?: string } = {}): { url: string; nodes: number; edges: number } {
  const graph = memGraph(caller, opts);
  const path = opts.out ?? join(opts.state ?? stateDir(), "mem", "graph.html");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, graphHtml(graph, `orch mem${opts.scope ? ` (${opts.scope})` : ""}`));
  chmodSync(path, 0o600); // operator and lead notes are private
  return { url: pathToFileURL(path).href, nodes: graph.nodes.length, edges: graph.edges.length };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>__TITLE__</title>
<style>
:root{--bg:#0d0f14;--panel:#151821;--line:#252a35;--text:#e6e9ef;--muted:#8b93a3}
*{box-sizing:border-box}body{margin:0;font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden}
#view{flex:1;position:relative}canvas{display:block;width:100%;height:100%;cursor:grab}canvas.drag{cursor:grabbing}canvas.hover{cursor:pointer}
aside{width:380px;padding:18px;overflow:auto;border-left:1px solid var(--line);background:var(--panel)}
h1{font-size:15px;margin:0 0 4px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 0 8px}
.k{color:var(--muted)}.row{display:flex;flex-wrap:wrap;gap:6px 14px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap}.dot{width:10px;height:10px;border-radius:50%}
label.chip{cursor:pointer}
pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;background:#1c2029;padding:10px;border-radius:8px;border:1px solid var(--line)}
input[type=text]{width:100%;margin:14px 0 0;padding:8px 10px;background:#1c2029;color:inherit;border:1px solid var(--line);border-radius:8px;outline:none}
input[type=text]:focus{border-color:#3b82f6}
.link{cursor:pointer;padding:4px 0;border-top:1px solid var(--line)}.link:hover{color:#fff}
</style></head><body>
<div id="view"><canvas id="c"></canvas></div>
<aside><h1>__TITLE__</h1><div id="stats" class="k"></div>
<h2>Show</h2><div class="row">
<label class="chip"><input type="checkbox" id="tTags" checked> tags as nodes</label>
<label class="chip"><input type="checkbox" id="tScopes" checked> scope hubs</label>
<label class="chip"><input type="checkbox" id="tLone" checked> isolated notes</label></div>
<h2>Legend</h2><div class="row" id="legend"></div>
<input type="text" id="q" placeholder="Filter: words, tags, id">
<h2>Note</h2><div id="info" class="k">Hover to light up a note's links, click to read it, drag a note to move it. Wheel to zoom, drag the background to pan, double click to recenter.</div></aside>
<script>
const G = __DATA__;
const SCOPE = {project: "#58a6ff", operator: "#d2a8ff", lead: "#3fd0a6"};
const RING = {trusted: "#3fb950", tentative: "#8b949e", contested: "#f0883e", dead_end: "#f85149"};
const EDGE = {supersedes: "#e3b341", tags: "#6e7681", similar: "#a371f7", hub: "#3a4150"};
const $ = (id) => document.getElementById(id);
const html = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
for (const [k, c] of Object.entries(SCOPE)) { const s = html("span", "", "chip"), d = html("i", "", "dot"); d.style.background = c; s.append(d, k); $("legend").append(s); }
for (const [k, c] of Object.entries(RING)) { const s = html("span", "", "chip"), d = html("i", "", "dot"); d.style.border = "3px solid " + c; s.append(d, k.replace("_", " ")); $("legend").append(s); }
for (const [k, c] of [["tag", "#8b949e"]]) { const s = html("span", "", "chip"), d = html("i", "", "dot"); d.style.background = c; d.style.width = d.style.height = "7px"; s.append(d, k); $("legend").append(s); }
for (const [k, c] of [["supersedes", EDGE.supersedes], ["shared tag", EDGE.tags], ["close note", EDGE.similar]]) { const s = html("span", "", "chip"), b = html("i"); b.style.cssText = "width:22px;height:2px;background:" + c; s.append(b, k); $("legend").append(s); }

// The world: note nodes from the data, plus tag and scope nodes derived from it.
let nodes = [], links = [], byId = new Map(), adj = new Map();
const seed = (i) => { const a = i * 2.399963, r = 12 * Math.sqrt(i + 1); return [r * Math.cos(a), r * Math.sin(a)]; };
const old = new Map();
function build() {
  for (const n of nodes) old.set(n.id, n);
  const showTags = $("tTags").checked, showScopes = $("tScopes").checked, showLone = $("tLone").checked;
  const list = [], ls = [];
  const put = (n) => { const o = old.get(n.id); const [x, y] = seed(list.length); list.push(Object.assign(n, o ? {x: o.x, y: o.y, vx: o.vx, vy: o.vy} : {x, y, vx: 0, vy: 0})); };
  for (const n of G.nodes) put(Object.assign({}, n, {kind: "note"}));
  for (const e of G.edges) if (!(showTags && e.kind === "tags")) ls.push({from: e.from, to: e.to, kind: e.kind, label: e.label});
  if (showTags) { const tags = new Map(); for (const n of G.nodes) for (const t of n.tags) { const k = t.toLowerCase(); tags.set(k, (tags.get(k) || 0) + 1); ls.push({from: n.id, to: "tag:" + k, kind: "tags", label: "#" + k}); }
    for (const [t, count] of tags) put({id: "tag:" + t, kind: "tag", label: "#" + t, count}); }
  if (showScopes) { for (const s of Object.keys(SCOPE)) if (G.nodes.some((n) => n.scope === s)) put({id: "scope:" + s, kind: "scope", scope: s, label: s});
    for (const n of G.nodes) ls.push({from: n.id, to: "scope:" + n.scope, kind: "hub", label: n.scope}); }
  const ids = new Map(list.map((n) => [n.id, n])), deg = new Map();
  for (const l of ls) for (const id of [l.from, l.to]) deg.set(id, (deg.get(id) || 0) + 1);
  nodes = list.filter((n) => showLone || n.kind !== "note" || G.edges.some((e) => e.from === n.id || e.to === n.id) || (showTags && n.tags.length));
  byId = new Map(nodes.map((n) => [n.id, n]));
  links = ls.filter((l) => byId.has(l.from) && byId.has(l.to)).map((l) => Object.assign(l, {a: byId.get(l.from), b: byId.get(l.to)}));
  adj = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const l of links) { adj.get(l.from).add(l.to); adj.get(l.to).add(l.from); }
  for (const n of nodes) { const d = adj.get(n.id).size;
    n.r = n.kind === "scope" ? 14 : n.kind === "tag" ? 3 + Math.min(5, n.count) : 4 + Math.min(6, (G.edges.filter((e) => e.from === n.id || e.to === n.id).length) * 1.5); }
  const lone = G.nodes.filter((n) => !G.edges.some((e) => e.from === n.id || e.to === n.id)).length;
  $("stats").textContent = G.nodes.length + " notes, " + G.edges.length + " note links, " + lone + " with no note link";
  alpha = Math.max(alpha, 0.8);
}

// A small force simulation: repulsion, springs, a pull to the center, collisions.
let alpha = 1, drag = null, hover = null, selected = null, query = "";
function tick() {
  const k = alpha;
  for (let i = 0; i < nodes.length; i++) { const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) { const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 > 160000) continue; if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const f = (a.kind === "scope" || b.kind === "scope" ? 2600 : 900) / d2 * k, d = Math.sqrt(d2);
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      const min = a.r + b.r + 6; if (d < min) { const push = (min - d) / d * 0.25; a.vx += dx * push; a.vy += dy * push; b.vx -= dx * push; b.vy -= dy * push; } } }
  for (const l of links) { const {a, b} = l, dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = l.kind === "hub" ? 80 : l.kind === "tags" ? 55 : 70, s = l.kind === "hub" ? 0.03 : 0.06, f = (d - rest) * s * k / d;
    const wa = adj.get(b.id).size / (adj.get(a.id).size + adj.get(b.id).size);
    a.vx += dx * f * wa; a.vy += dy * f * wa; b.vx -= dx * f * (1 - wa); b.vy -= dy * f * (1 - wa); }
  for (const n of nodes) { n.vx -= n.x * 0.006 * k; n.vy -= n.y * 0.006 * k;
    if (n === drag?.node) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy; }
  alpha = Math.max(0.03, alpha * 0.985);
}

const cv = $("c"), ctx = cv.getContext("2d");
let view = {x: 0, y: 0, k: 1}, W = 0, H = 0;
function resize() { const dpr = devicePixelRatio || 1; W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
// fit the whole graph in the view, with a margin
function center() { if (!nodes.length) { view = {x: W / 2, y: H / 2, k: 1}; return; }
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.max(0.3, Math.min(2.5, 0.85 * Math.min(W / (x1 - x0 + 80), H / (y1 - y0 + 80))));
  view = {x: W / 2 - k * (x0 + x1) / 2, y: H / 2 - k * (y0 + y1) / 2, k}; }
const toWorld = (px, py) => [(px - view.x) / view.k, (py - view.y) / view.k];
const lit = (n) => { const focus = hover || selected; return !focus || n === focus || adj.get(focus.id)?.has(n.id); };
const matches = (n) => !query || (n.label + " " + (n.body || "") + " " + (n.tags || []).join(" ") + " " + n.id).toLowerCase().includes(query);
const colorOf = (n) => n.kind === "tag" ? "#8b949e" : SCOPE[n.scope];
function draw() {
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.2); g.addColorStop(0, "#141822"); g.addColorStop(1, "#0d0f14");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
  const focus = hover || selected;
  for (const l of links) { const on = focus && (l.a === focus || l.b === focus);
    ctx.globalAlpha = focus ? (on ? 0.95 : 0.06) : l.kind === "hub" ? 0.22 : 0.55;
    ctx.strokeStyle = on && l.kind === "hub" ? SCOPE[l.label] : EDGE[l.kind]; ctx.lineWidth = (l.kind === "supersedes" ? 2.2 : on ? 1.6 : 1) / Math.sqrt(view.k);
    ctx.setLineDash(l.kind === "similar" ? [5, 4] : []); ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke(); }
  ctx.setLineDash([]);
  for (const n of nodes) { const on = lit(n) && matches(n); ctx.globalAlpha = on ? 1 : 0.12;
    if (n === focus || (n.kind === "scope")) { ctx.shadowColor = colorOf(n); ctx.shadowBlur = n === focus ? 24 : 14; }
    ctx.fillStyle = colorOf(n); ctx.globalAlpha *= n.status && n.status !== "active" ? 0.4 : 1;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    if (n.standing) { ctx.strokeStyle = RING[n.standing]; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2); ctx.stroke(); } }
  // labels: hubs always, the rest fade in with zoom, the focus and its neighbors always
  ctx.textAlign = "center"; ctx.lineJoin = "round";
  for (const n of nodes) {
    const near = focus && lit(n), fade = n.kind === "scope" ? 1 : near ? 1 : Math.max(0, Math.min(1, (view.k - (n.kind === "tag" ? 1.2 : 1.5)) / 0.5));
    if (fade <= 0 || !matches(n)) continue;
    const size = (n.kind === "scope" ? 14 : 11) / Math.max(0.8, Math.sqrt(view.k));
    ctx.font = (n.kind === "scope" ? "600 " : "") + size + "px system-ui, sans-serif"; ctx.globalAlpha = fade * (lit(n) ? 1 : 0.15);
    const text = n.kind === "note" ? (n.label.length > 42 ? n.label.slice(0, 41) + "..." : n.label) : n.label;
    ctx.strokeStyle = "#0d0f14"; ctx.lineWidth = 4 / view.k; ctx.strokeText(text, n.x, n.y + n.r + size + 2);
    ctx.fillStyle = n.kind === "tag" ? "#9aa3b2" : "#e6e9ef"; ctx.fillText(text, n.x, n.y + n.r + size + 2); }
  ctx.restore(); ctx.globalAlpha = 1;
}
function frame() { if (alpha > 0.031 || drag) tick(); draw(); requestAnimationFrame(frame); }
function pick(px, py) { const [x, y] = toWorld(px, py); let best = null, bd = Infinity;
  for (const n of nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.r + 4, 8 / view.k) && d < bd) { best = n; bd = d; } } return best; }
function show(n) {
  selected = n; const info = $("info"); info.textContent = ""; info.className = "";
  if (n.kind !== "note") { info.append(html("div", n.kind + " " + n.label, "k"));
    for (const id of adj.get(n.id)) { const m = byId.get(id), a = html("div", m.label, "link"); a.onclick = () => show(m); info.append(a); } return; }
  info.append(html("div", n.scope + " / " + n.status + " / " + n.date + (n.badge ? "  " + n.badge : ""), "k"), html("div", n.id, "k"));
  if (n.tags.length) info.append(html("div", "tags: " + n.tags.join(", "), "k"));
  info.append(html("pre", n.body));
  for (const l of links) if ((l.a === n || l.b === n) && l.kind !== "hub") { const m = l.a === n ? l.b : l.a, a = html("div", l.label + "  " + m.label, "link"); a.onclick = () => show(m); info.append(a); }
}
const pos = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
cv.addEventListener("mousedown", (ev) => { const [px, py] = pos(ev), n = pick(px, py);
  drag = n ? {node: n, moved: false} : {pan: true, x: px - view.x, y: py - view.y, moved: false}; cv.classList.add("drag"); });
addEventListener("mousemove", (ev) => { const [px, py] = pos(ev);
  if (drag?.node) { const [x, y] = toWorld(px, py); drag.node.x = x; drag.node.y = y; drag.moved = true; alpha = Math.max(alpha, 0.3); }
  else if (drag?.pan) { view.x = px - drag.x; view.y = py - drag.y; drag.moved = true; }
  else { hover = pick(px, py); cv.classList.toggle("hover", !!hover); } });
addEventListener("mouseup", () => { if (drag && !drag.moved) { if (drag.node) show(drag.node); else { selected = null; } } drag = null; cv.classList.remove("drag"); });
cv.addEventListener("mouseleave", () => { hover = null; });
cv.addEventListener("dblclick", center);
cv.addEventListener("wheel", (ev) => { ev.preventDefault(); const [px, py] = pos(ev), f = Math.exp(-ev.deltaY * 0.0015);
  view.x = px - (px - view.x) * f; view.y = py - (py - view.y) * f; view.k = Math.max(0.15, Math.min(6, view.k * f)); }, {passive: false});
$("q").addEventListener("input", (ev) => { query = ev.target.value.toLowerCase().trim(); });
for (const id of ["tTags", "tScopes", "tLone"]) $(id).addEventListener("change", build);
addEventListener("resize", resize);
resize(); build(); for (let i = 0; i < 300; i++) tick(); center(); frame();
</script></body></html>
`;
