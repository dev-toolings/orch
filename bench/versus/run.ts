#!/usr/bin/env bun
// Banc réel « système contre Claude seul » : les mêmes features, l'une après
// l'autre, sur des copies identiques du dépôt jouet du banc d'architecture.
//   - kiba-opus, kiba-sonnet : le vrai Kiba (launcher `kiba`, tmux -L orch,
//     lanes, porte `lane integrate`), lead Opus high (profil) ou Sonnet medium.
//   - opus-medium, opus-high, sonnet-medium, sonnet-high : `claude -p` seul,
//     une session reprise d'une feature à l'autre.
// Après chaque feature : test d'acceptation caché, suite du dépôt, puis commit
// (rôle de l'opérateur), pour tous les bras. Coût : transcripts Claude Code
// (messages dédoublonnés, grille src/core/paid.ts), revues Codex à part.
// Payant (quota Claude Code) : `bun bench/versus/run.ts --yes [--arms a,b] [--features F1,F2] [--with <dossier d'un run>]`,
// ou `--render <dossier d'un run>` pour recalculer coûts et rapport sans session.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { usagePriceForModel } from "../../src/core/paid.ts";
import { createToyRepo, loadWorkload } from "./workload.ts";
import { renderReport } from "./report.ts";

export interface Feature { id: string; size: string; files: string[]; objective: string; accept: string }
export interface Arm { id: string; label: string; kind: "kiba" | "claude"; model: string; effort: string }

const ARMS: Arm[] = [
  { id: "kiba-opus", label: "Kiba (lead Opus high)", kind: "kiba", model: "opus", effort: "high" },
  { id: "kiba-sonnet", label: "Kiba (lead Sonnet medium)", kind: "kiba", model: "sonnet", effort: "medium" },
  { id: "opus-medium", label: "Claude seul Opus medium", kind: "claude", model: "opus", effort: "medium" },
  { id: "opus-high", label: "Claude seul Opus high", kind: "claude", model: "opus", effort: "high" },
  { id: "sonnet-medium", label: "Claude seul Sonnet medium", kind: "claude", model: "sonnet", effort: "medium" },
  { id: "sonnet-high", label: "Claude seul Sonnet high", kind: "claude", model: "sonnet", effort: "high" },
];

const INVENTORY: Feature = {
  id: "F4", size: "feature", files: ["src/inventory.ts", "src/index.ts", "tests/inventory.test.ts", "docs/inventory.md"],
  objective: "Crée src/inventory.ts avec une classe `Inventory` : `add(sku: string, qty: number)` (qty entier > 0, sinon RangeError), `available(sku: string): number` (0 si inconnu), `reserve(items: { sku: string; qty: number }[]): string` qui réserve tout ou rien (si un article manque, lève une Error \"insufficient stock: <sku>\" sans rien réserver) et renvoie un id de réservation, `release(id: string)` qui rend le stock réservé (sans effet sur un id inconnu, déjà rendu ou déjà validé), `commit(id: string)` qui rend la réservation définitive (Error sur un id inconnu). Exporte-la depuis src/index.ts et documente-la dans docs/inventory.md.",
  accept: `import { expect, test } from "bun:test";
import { Inventory } from "../../src/index.ts";
test("F4", () => {
  const inv = new Inventory();
  inv.add("a", 5); inv.add("b", 1);
  expect(inv.available("zz")).toBe(0);
  expect(() => inv.add("a", 0)).toThrow(RangeError);
  expect(() => inv.add("a", 1.5)).toThrow(RangeError);
  const r = inv.reserve([{ sku: "a", qty: 2 }, { sku: "b", qty: 1 }]);
  expect(inv.available("a")).toBe(3);
  expect(inv.available("b")).toBe(0);
  expect(() => inv.reserve([{ sku: "a", qty: 1 }, { sku: "b", qty: 1 }])).toThrow("insufficient stock: b");
  expect(inv.available("a")).toBe(3);
  inv.release(r);
  expect(inv.available("a")).toBe(5);
  inv.release(r);
  expect(inv.available("a")).toBe(5);
  const r2 = inv.reserve([{ sku: "a", qty: 5 }]);
  inv.commit(r2);
  expect(inv.available("a")).toBe(0);
  inv.release(r2);
  expect(inv.available("a")).toBe(0);
  expect(() => inv.commit("nope")).toThrow();
});
`,
};

export function features(): Feature[] {
  const w = loadWorkload();
  const pick = (task: string, id: string): Feature => {
    const t = w.tasks.find((x) => x.id === task)!;
    return { id, size: t.size, files: t.files, objective: t.objective, accept: t.accept.replace(`test("${task}"`, `test("${id}"`) };
  };
  return [pick("T2", "F1"), pick("T5", "F2"), pick("T7", "F3"), INVENTORY];
}

export const prompt = (f: Feature) =>
  `Feature ${f.id} : ${f.objective} Fichiers : ${f.files.join(", ")}. Ajoute un test qui couvre ce comportement. Quand bun test est vert, intègre le changement dans ce dépôt (branche develop, sans commit) puis réponds en une ligne.`;

const NUDGE = "Oui, vas-y : fais-le et intègre quand bun test est vert.";
const FEATURE_TIMEOUT_MS = 25 * 60_000;
const STATE = process.env.ORCH_STATE ?? join(process.env.HOME ?? homedir(), ".local", "state", "orch");
const PROJECTS = join(process.env.HOME ?? homedir(), ".claude", "projects");
const STRIP = /^(ORCH_LEAD|ORCH_HARNESS|ORCH_SESSION|ORCH_CONDUCTOR|ORCH_LEAD_PID|ORCH_LANE|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  return env;
}

function sh(cwd: string, ...argv: string[]): { ok: boolean; out: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: 180_000, env: cleanEnv() });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const tmux = (...args: string[]) => sh("/tmp", "tmux", "-L", "orch", ...args);
const sleep = (ms: number) => Bun.sleep(ms);
const changed = (repo: string) => sh(repo, "git", "status", "--porcelain").out.trim().length > 0;

export interface FeatureResult {
  id: string; startedAt: string; endedAt: string; seconds: number; accepted: boolean; suiteGreen: boolean;
  nudges: number; timedOut: boolean; reportedUsd?: number; turns?: number; acceptOut?: string;
  intents?: { id: string; kind: string; status: string; model?: string }[];
}
export interface ArmResult { arm: Arm; repo: string; features: FeatureResult[]; error?: string }

// Acceptation cachée (écrite puis retirée), suite du dépôt, commit opérateur.
function judge(repo: string, f: Feature): { accepted: boolean; suiteGreen: boolean; out: string } {
  const dir = join(repo, "tests", "accept");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${f.id}.test.ts`);
  writeFileSync(file, f.accept);
  const acc = sh(repo, "bun", "test", `./tests/accept/${f.id}.test.ts`);
  rmSync(dir, { recursive: true, force: true });
  const suite = sh(repo, "bun", "test");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=orch-bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", `bench: ${f.id}`);
  return { accepted: acc.ok, suiteGreen: suite.ok, out: acc.out.slice(-1500) };
}

// Tests cachés rejoués sur l'état final du dépôt : une feature finie plus tard
// (pendant la suivante) compte ici, pas dans le résultat par feature.
export function finalAccept(repo: string, feats: Feature[]): Record<string, boolean> {
  if (!existsSync(repo)) return {};
  const dir = join(repo, "tests", "accept");
  const out: Record<string, boolean> = {};
  try {
    for (const f of feats) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${f.id}.test.ts`), f.accept);
      out[f.id] = sh(repo, "bun", "test", `./tests/accept/${f.id}.test.ts`).ok;
      rmSync(join(dir, `${f.id}.test.ts`), { force: true });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

async function claudeTurn(arm: Arm, repo: string, text: string, session: string, resume: boolean, log: string): Promise<{ usd: number; turns: number }> {
  const proc = Bun.spawn(["claude", "-p", text, "--output-format", "json", "--model", arm.model, "--effort", arm.effort,
    "--permission-mode", "bypassPermissions", resume ? "--resume" : "--session-id", session], { cwd: repo, env: cleanEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGTERM"), FEATURE_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  writeFileSync(log, `${out}\n--- stderr\n${err}`);
  // total_cost_usd est cumulé sur une session reprise (--resume) : le rapport en prend le maximum.
  try { const j = JSON.parse(out); return { usd: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0 }; } catch { return { usd: 0, turns: 0 }; }
}

async function runClaudeArm(arm: Arm, repo: string, feats: Feature[], logs: string): Promise<FeatureResult[]> {
  const session = randomUUID();
  const out: FeatureResult[] = [];
  let started = false;
  for (const f of feats) {
    const t0 = Date.now();
    let { usd, turns } = await claudeTurn(arm, repo, prompt(f), session, started, join(logs, `${f.id}.json`));
    started = true;
    let nudges = 0;
    if (!changed(repo)) {
      nudges++;
      const r = await claudeTurn(arm, repo, NUDGE, session, true, join(logs, `${f.id}-nudge.json`));
      usd += r.usd; turns += r.turns;
    }
    const t1 = Date.now();
    const j = judge(repo, f);
    out.push({ id: f.id, startedAt: new Date(t0).toISOString(), endedAt: new Date(t1).toISOString(), seconds: (t1 - t0) / 1000,
      accepted: j.accepted, suiteGreen: j.suiteGreen, nudges, timedOut: t1 - t0 >= FEATURE_TIMEOUT_MS, reportedUsd: usd, turns, acceptOut: j.accepted ? undefined : j.out });
    console.log(`[${arm.id}] ${f.id} ${j.accepted ? "OK" : "ÉCHEC"} ${((t1 - t0) / 1000).toFixed(0)} s ${usd.toFixed(3)} $`);
  }
  return out;
}

const TERMINAL = new Set(["done", "failed", "env-failed", "cancelled", "refused", "answered", "ignored", "escalated", "needs-lead"]);
// escalated et needs-lead attendent le lead : on exige donc un tour du lead après le dernier changement.

// Intentions de Kiba pour ce dépôt : la première ligne porte le dépôt, les suivantes seulement l'id.
function intentsOf(repo: string): Map<string, { id: string; kind: string; status: string; model?: string; at: number }> {
  const file = join(STATE, "kiba", "intents.jsonl");
  const map = new Map<string, { id: string; kind: string; status: string; model?: string; at: number }>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let r: { id?: string; repo?: string; kind?: string; status?: string; model?: string; at?: string } = {};
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.id) continue;
    const cur = map.get(r.id);
    if (!cur && r.repo !== repo) continue;
    map.set(r.id, { id: r.id, kind: r.kind ?? cur?.kind ?? "?", status: r.status ?? cur?.status ?? "?", model: r.model ?? cur?.model, at: Date.parse(r.at ?? "") || cur?.at || 0 });
  }
  return map;
}

function pulse(pid: number): { state: string; at: number } | null {
  try { const p = JSON.parse(readFileSync(join(STATE, "leads", `pulse-${pid}.json`), "utf8")); return { state: p.state, at: Date.parse(p.at) }; } catch { return null; }
}

async function send(session: string, text: string): Promise<void> {
  tmux("send-keys", "-t", session, "C-u");
  tmux("send-keys", "-t", session, "-l", text);
  await sleep(1000);
  tmux("send-keys", "-t", session, "Enter");
}

async function runKibaArm(arm: Arm, repo: string, feats: Feature[], logs: string, runId: string): Promise<FeatureResult[]> {
  const session = `vs-${runId}-${arm.id}`;
  const launch = ["kiba", ...(arm.model === "opus" ? [] : ["--model", arm.model, "--effort", arm.effort])].join(" ");
  const started = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", repo, "-e", `PATH=${process.env.PATH}`, "-e", "ORCH_MEMORY=off", launch);
  if (!started.ok) throw new Error(`tmux : ${started.out}`);
  const pid = Number(tmux("display", "-p", "-t", session, "#{pane_pid}").out.trim());
  const capture = () => tmux("capture-pane", "-p", "-t", session).out;
  try {
    const ready = Date.now() + 120_000;
    // Prêt : le battement n'existe qu'après le premier prompt, on attend donc l'écran de saisie.
    while (!pulse(pid) && !/bypass permissions on/.test(capture())) {
      if (Date.now() > ready) throw new Error(`Kiba ne démarre pas :\n${capture().slice(-1500)}`);
      // Invite de confiance du dossier : le choix par défaut est « No, exit ».
      if (/Yes, I trust this folder/.test(capture())) { tmux("send-keys", "-t", session, "Down"); await sleep(300); tmux("send-keys", "-t", session, "Enter"); }
      await sleep(3000);
    }
    await sleep(3000);
    const out: FeatureResult[] = [];
    for (const f of feats) {
      const before = new Set(intentsOf(repo).keys());
      const t0 = Date.now();
      await send(session, prompt(f));
      let nudges = 0, timedOut = false, resent = false;
      for (;;) {
        await sleep(5000);
        const now = Date.now();
        if (now - t0 > FEATURE_TIMEOUT_MS) { timedOut = true; break; }
        const p = pulse(pid);
        // Invite non soumise (aucun battement depuis l'envoi) : une seule relance d'Entrée.
        if (!resent && now - t0 > 30_000 && (p?.at ?? 0) < t0) { resent = true; tmux("send-keys", "-t", session, "Enter"); continue; }
        const mine = [...intentsOf(repo).values()].filter((i) => !before.has(i.id));
        const live = mine.some((i) => !TERMINAL.has(i.status));
        const lastChange = Math.max(t0, ...mine.map((i) => i.at));
        if (!p || p.state !== "idle" || p.at < t0 || p.at < lastChange || live || now - p.at < 45_000) continue;
        if (!changed(repo) && nudges === 0) { nudges++; await send(session, NUDGE); continue; }
        break;
      }
      const t1 = Date.now();
      writeFileSync(join(logs, `${f.id}.pane.txt`), capture());
      const intents = [...intentsOf(repo).values()].filter((i) => !before.has(i.id)).map(({ id, kind, status, model }) => ({ id, kind, status, model }));
      const j = judge(repo, f);
      out.push({ id: f.id, startedAt: new Date(t0).toISOString(), endedAt: new Date(t1).toISOString(), seconds: (t1 - t0) / 1000,
        accepted: j.accepted, suiteGreen: j.suiteGreen, nudges, timedOut, intents, acceptOut: j.accepted ? undefined : j.out });
      console.log(`[${arm.id}] ${f.id} ${j.accepted ? "OK" : "ÉCHEC"} ${((t1 - t0) / 1000).toFixed(0)} s, ${intents.length} intention(s)`);
    }
    return out;
  } finally {
    writeFileSync(join(logs, "pane-final.txt"), capture());
    tmux("kill-session", "-t", session);
  }
}

// --- coût, à partir des transcripts --------------------------------------

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number; messages: number }
const empty = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, messages: 0 });

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

interface Msg { at: number; model: string; u: Record<string, number>; file: string }

// Messages assistant des sessions dont le dossier de projet contient `tag`,
// dédoublonnés par message.id (un message par bloc de contenu dans le transcript).
export function messages(tag: string, projects = PROJECTS): Msg[] {
  const byId = new Map<string, Msg>();
  if (!existsSync(projects)) return [];
  for (const d of readdirSync(projects).filter((d) => d.includes(tag))) {
    for (const file of walk(join(projects, d))) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        let r: { type?: string; timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, number> } } = {};
        try { r = JSON.parse(line); } catch { continue; }
        if (r.type !== "assistant" || !r.message?.usage || !r.message.id || r.message.model === "<synthetic>") continue;
        byId.set(r.message.id, { at: Date.parse(r.timestamp ?? ""), model: r.message.model ?? "", u: r.message.usage, file });
      }
    }
  }
  return [...byId.values()];
}

export function sum(msgs: Msg[]): Usage & { byModel: Record<string, Usage> } {
  const all = { ...empty(), byModel: {} as Record<string, Usage> };
  for (const m of msgs) {
    const p = usagePriceForModel(m.model, "claude");
    const i = m.u.input_tokens ?? 0, o = m.u.output_tokens ?? 0, cr = m.u.cache_read_input_tokens ?? 0, cw = m.u.cache_creation_input_tokens ?? 0;
    const usd = (i * p.inputUsdPerM + o * p.outputUsdPerM + cr * p.cacheReadUsdPerM + cw * p.cacheWriteUsdPerM) / 1e6;
    const fam = /opus/.test(m.model) ? "opus" : /haiku/.test(m.model) ? "haiku" : /sonnet/.test(m.model) ? "sonnet" : m.model;
    for (const t of [all, (all.byModel[fam] ??= empty())]) {
      t.input += i; t.output += o; t.cacheRead += cr; t.cacheWrite += cw; t.usd += usd; t.messages++;
    }
  }
  return all;
}

// Revues Codex (porte d'une lane risquée) : jetons des sessions Codex dont le cwd contient `tag`.
export function codexTokens(tag: string, since: number): { sessions: number; input: number; cached: number; output: number } {
  const root = join(process.env.HOME ?? homedir(), ".codex", "sessions");
  const acc = { sessions: 0, input: 0, cached: 0, output: 0 };
  if (!existsSync(root)) return acc;
  for (const file of walk(root)) {
    if (statSync(file).mtimeMs < since) continue;
    const text = readFileSync(file, "utf8");
    const head = text.slice(0, 4000);
    if (!head.includes(tag)) continue;
    const last = [...text.matchAll(/"total_token_usage":(\{[^}]*\})/g)].at(-1);
    if (!last) continue;
    const t = JSON.parse(last[1]!);
    acc.sessions++; acc.input += t.input_tokens ?? 0; acc.cached += t.cached_input_tokens ?? 0; acc.output += t.output_tokens ?? 0;
  }
  return acc;
}

export function accountArm(r: ArmResult, since: number) {
  const tag = basename(r.repo);
  const msgs = messages(tag);
  // Le lead Kiba : la session du dossier du dépôt qui commence la première.
  const repoDirMsgs = msgs.filter((m) => !m.file.includes("orch-lanes"));
  const firstAt = new Map<string, number>();
  for (const m of repoDirMsgs) firstAt.set(m.file, Math.min(firstAt.get(m.file) ?? Infinity, m.at));
  const leadFile = [...firstAt].sort((a, b) => a[1] - b[1])[0]?.[0];
  const isLead = (m: Msg) => r.arm.kind === "claude" || m.file === leadFile;
  const per = r.features.map((f) => {
    const [a, b] = [Date.parse(f.startedAt), Date.parse(f.endedAt)];
    const inF = msgs.filter((m) => m.at >= a && m.at <= b);
    // Kiba : la fin réelle est le dernier message d'un modèle, pas la fin de l'attente du banc (repos stable 45 s).
    const activeSeconds = r.arm.kind === "kiba" && inF.length ? (Math.max(...inF.map((m) => m.at)) - a) / 1000 : undefined;
    return { id: f.id, lead: sum(inF.filter(isLead)), workers: sum(inF.filter((m) => !isLead(m))), activeSeconds };
  });
  return { lead: sum(msgs.filter(isLead)), workers: sum(msgs.filter((m) => !isLead(m))), per, codex: codexTokens(tag, since) };
}

async function main(args: string[]): Promise<number> {
  const render = args.indexOf("--render");
  if (render >= 0) {
    // Recalcule coûts et rapport d'un run existant, sans aucune session.
    const dir = args[render + 1]!;
    const doc = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { startedAt: string; results: (ArmResult & { cost: unknown })[] };
    const feats = (doc as unknown as { features: Feature[] }).features;
    doc.results = doc.results.map((r) => ({ ...r, cost: accountArm(r, Date.parse(doc.startedAt)), finalAccepted: finalAccept(r.repo, feats) }));
    writeFileSync(join(dir, "results.json"), JSON.stringify(doc, null, 2) + "\n");
    writeFileSync(join(dir, "report.html"), renderReport(doc as unknown as Parameters<typeof renderReport>[0]));
    console.log(`rapport : file://${join(dir, "report.html")}`);
    return 0;
  }
  if (!args.includes("--yes")) { console.error("banc payant (quota Claude Code) : relancer avec --yes"); return 2; }
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const arms = opt("--arms") ? ARMS.filter((a) => opt("--arms")!.split(",").includes(a.id)) : ARMS;
  const feats = opt("--features") ? features().filter((f) => opt("--features")!.split(",").includes(f.id)) : features();
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const root = join("/tmp", `orch-versus-${runId}`);
  const outDir = join(STATE, "bench", "versus", runId);
  mkdirSync(root, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const since = Date.now();
  const w = loadWorkload();
  console.log(`banc versus ${runId} : ${arms.map((a) => a.id).join(", ")} × ${feats.map((f) => f.id).join(", ")}`);
  const results = await Promise.all(arms.map(async (arm): Promise<ArmResult> => {
    const repo = createToyRepo(w, `vs${runId.slice(9, 15)}-${arm.id}-`, root);
    sh(repo, "git", "checkout", "-q", "-b", "develop");
    const logs = join(outDir, "logs", arm.id);
    mkdirSync(logs, { recursive: true });
    try {
      const fr = arm.kind === "kiba" ? await runKibaArm(arm, repo, feats, logs, runId.slice(9, 15)) : await runClaudeArm(arm, repo, feats, logs);
      return { arm, repo, features: fr };
    } catch (e) {
      console.error(`[${arm.id}] ${e instanceof Error ? e.message : e}`);
      return { arm, repo, features: [], error: e instanceof Error ? e.message : String(e) };
    }
  }));
  await sleep(5000);
  const accounted: unknown[] = results.map((r) => ({ ...r, cost: accountArm(r, since) }));
  // --with <dossier> : reprend les bras déjà mesurés d'un run précédent (mêmes features).
  const prev = opt("--with");
  if (prev) {
    const old = JSON.parse(readFileSync(join(prev, "results.json"), "utf8")) as { runId: string; results: (ArmResult & { cost: unknown; runId?: string })[] };
    for (const r of old.results) if (!arms.some((a) => a.id === r.arm.id) && !r.error) accounted.push({ ...r, runId: r.runId ?? old.runId });
  }
  const doc = { runId, startedAt: new Date(since).toISOString(), endedAt: new Date().toISOString(), features: feats, results: accounted };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(doc, null, 2) + "\n");
  const html = join(outDir, "report.html");
  writeFileSync(html, renderReport(doc as Parameters<typeof renderReport>[0]));
  console.log(`rapport : file://${html}`);
  return 0;
}

if (import.meta.main) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
