// Rapport HTML autonome du banc versus (aucune ressource externe).
import type { Arm, Feature, FeatureResult, Usage } from "./run.ts";

type U = Usage & { byModel: Record<string, Usage> };
interface Row {
  arm: Arm; repo: string; features: FeatureResult[]; error?: string; finalAccepted?: Record<string, boolean>;
  cost: { lead: U; workers: U; per: { id: string; lead: U; workers: U; activeSeconds?: number }[]; codex: { sessions: number; input: number; cached: number; output: number } };
}
export interface Doc { runId: string; startedAt: string; endedAt: string; features: Feature[]; results: Row[] }

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (n: number) => `${n.toFixed(n < 1 ? 3 : 2)} $`;
const dur = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : `${Math.round(n / 1000)} k`);

const secondsOf = (r: Row, f: FeatureResult) => r.cost.per.find((p) => p.id === f.id)?.activeSeconds ?? f.seconds;

function summary(r: Row) {
  const passed = r.features.filter((f) => f.accepted).length;
  const seconds = r.features.reduce((n, f) => n + secondsOf(r, f), 0);
  const total = r.cost.lead.usd + r.cost.workers.usd;
  return { passed, seconds, total, perPass: passed ? total / passed : Infinity };
}

export function renderReport(doc: Doc): string {
  const rows = doc.results.map((r) => ({ r, s: summary(r) }));
  const n = doc.features.length;
  const maxUsd = Math.max(0.0001, ...rows.map((x) => x.s.total));
  const maxSec = Math.max(1, ...rows.map((x) => x.s.seconds));
  const ranked = [...rows].filter((x) => x.s.passed === n).sort((a, b) => a.s.total - b.s.total);
  const best = ranked[0];
  const kibaBest = rows.filter((x) => x.r.arm.kind === "kiba").sort((a, b) => a.s.total - b.s.total)[0];
  const soloBest = rows.filter((x) => x.r.arm.kind === "claude" && x.s.passed === n).sort((a, b) => a.s.total - b.s.total)[0];

  const verdict = best
    ? `Le moins cher à ${n}/${n} features réussies : <b>${esc(best.r.arm.label)}</b>, ${usd(best.s.total)}.` +
      (kibaBest && soloBest ? ` Le meilleur bras Kiba coûte <b>${(kibaBest.s.total / soloBest.s.total).toFixed(1)} fois</b> le meilleur Claude seul (${usd(kibaBest.s.total)} contre ${usd(soloBest.s.total)}).` : "")
    : "Aucun bras n'a réussi toutes les features.";

  const costBars = rows.map(({ r, s }) => {
    const lw = (r.cost.lead.usd / maxUsd) * 100, ww = (r.cost.workers.usd / maxUsd) * 100;
    const leadName = r.arm.kind === "kiba" ? "Kiba (lead)" : "session";
    return `<div class="bar-row"><span class="bar-label">${esc(r.arm.label)}</span><span class="bar-track">
      <span class="seg s1" style="width:${lw}%" title="${esc(leadName)} : ${usd(r.cost.lead.usd)}"></span>${ww > 0 ? `<span class="seg s2" style="width:${ww}%" title="lanes : ${usd(r.cost.workers.usd)}"></span>` : ""}
      </span><span class="bar-value">${usd(s.total)}</span></div>`;
  }).join("");
  const timeBars = rows.map(({ r, s }) => `<div class="bar-row"><span class="bar-label">${esc(r.arm.label)}</span><span class="bar-track">
      <span class="seg s1" style="width:${(s.seconds / maxSec) * 100}%" title="${dur(s.seconds)}"></span></span><span class="bar-value">${dur(s.seconds)}</span></div>`).join("");

  const head = doc.features.map((f) => `<th>${esc(f.id)}<br><small>${esc(f.size)}</small></th>`).join("");
  const matrix = rows.map(({ r, s }) => {
    const cells = doc.features.map((f) => {
      const fr = r.features.find((x) => x.id === f.id);
      const c = r.cost.per.find((x) => x.id === f.id);
      if (!fr) return `<td class="na">non lancé</td>`;
      const cost = (c?.lead.usd ?? 0) + (c?.workers.usd ?? 0);
      const flags = [fr.nudges ? `${fr.nudges} relance` : "", fr.timedOut ? "délai dépassé" : "", fr.suiteGreen ? "" : "suite rouge"].filter(Boolean).join(", ");
      const late = !fr.accepted && r.finalAccepted?.[f.id] ? "<br><small>réussie plus tard, pendant la feature suivante</small>" : "";
      return `<td class="${fr.accepted ? "ok" : "ko"}"><b>${fr.accepted ? "✓ réussie" : "✗ échec"}</b>${late}<br>${dur(secondsOf(r, fr))} · ${usd(cost)}${flags ? `<br><small>${esc(flags)}</small>` : ""}</td>`;
    }).join("");
    return `<tr><th class="rowh">${esc(r.arm.label)}${r.error ? `<br><small class="err">${esc(r.error.slice(0, 200))}</small>` : ""}</th>${cells}
      <td><b>${s.passed}/${n}</b>${r.finalAccepted ? `<br><small>au final : ${Object.values(r.finalAccepted).filter(Boolean).length}/${n}</small>` : ""}</td><td><b>${usd(s.total)}</b></td><td>${dur(s.seconds)}</td><td>${Number.isFinite(s.perPass) ? usd(s.perPass) : "n/a"}</td></tr>`;
  }).join("");

  const models = (u: U) => Object.entries(u.byModel).map(([m, x]) => `${m} ${usd(x.usd)} (${x.messages} appels, ${tok(x.cacheRead)} lus en cache)`).join(" ; ") || "aucun";
  const tokensTable = rows.map(({ r }) => `<tr><th class="rowh">${esc(r.arm.label)}</th><td>${models(r.cost.lead)}</td><td>${models(r.cost.workers)}</td>
      <td>${r.cost.codex.sessions ? `${r.cost.codex.sessions} session(s), ${tok(r.cost.codex.input)} entrée, ${tok(r.cost.codex.output)} sortie` : "aucune"}</td>
      <td>${r.arm.kind === "claude" ? usd(Math.max(0, ...r.features.map((f) => f.reportedUsd ?? 0))) : "n/a"}</td></tr>`).join("");

  const kibaDetail = rows.filter(({ r }) => r.arm.kind === "kiba").map(({ r }) => `<h3>${esc(r.arm.label)}</h3><ul>${r.features.map((f) =>
    `<li><b>${esc(f.id)}</b> : ${(f.intents ?? []).map((i) => `${esc(i.kind)}${i.model ? ` (${esc(i.model)})` : ""} → ${esc(i.status)}`).join(", ") || "aucune intention"}${f.acceptOut ? `<details><summary>sortie du test caché</summary><pre>${esc(f.acceptOut)}</pre></details>` : ""}</li>`).join("")}</ul>`).join("");
  const failures = rows.flatMap(({ r }) => r.arm.kind === "claude" ? r.features.filter((f) => f.acceptOut).map((f) => `<details><summary>${esc(r.arm.label)} · ${esc(f.id)}</summary><pre>${esc(f.acceptOut)}</pre></details>`) : []).join("");

  const feats = doc.features.map((f) => `<li><b>${esc(f.id)}</b> (${esc(f.size)}, ${f.files.length} fichier(s)) : ${esc(f.objective)}</li>`).join("");

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Banc versus ${esc(doc.runId)} : Kiba contre Claude seul</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--surface-2:#f1f0ec;--text-primary:#0b0b0b;--text-secondary:#52514e;--grid:#dcdad3;--series-1:#2a78d6;--series-2:#eb6834;--good:#0a7a3a;--bad:#b42318}
@media (prefers-color-scheme:dark){.viz-root{color-scheme:dark;--surface-1:#1a1a19;--surface-2:#242422;--text-primary:#f0efec;--text-secondary:#c3c2b7;--grid:#3a3936;--series-1:#3987e5;--series-2:#d95926;--good:#4cc27a;--bad:#f0776a}}
body{margin:0}.viz-root{background:var(--surface-1);color:var(--text-primary);font:15px/1.5 system-ui,sans-serif;min-height:100vh;padding:28px 36px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}h3{font-size:15px;margin:16px 0 4px}.muted{color:var(--text-secondary)}
.verdict{background:var(--surface-2);border-radius:8px;padding:14px 18px;margin:18px 0;font-size:16px}
.bar-row{display:grid;grid-template-columns:230px 1fr 90px;align-items:center;gap:12px;margin:6px 0}.bar-label{color:var(--text-secondary);text-align:right}
.bar-track{display:flex;gap:2px;height:18px;border-left:1px solid var(--grid)}.seg{height:100%;min-width:2px}.seg:last-child{border-radius:0 4px 4px 0}
.s1{background:var(--series-1)}.s2{background:var(--series-2)}.bar-value{font-variant-numeric:tabular-nums}
.legend{display:flex;gap:18px;margin:4px 0 8px 242px;color:var(--text-secondary);font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--grid);padding:8px 10px;text-align:left;vertical-align:top}
td.ok b{color:var(--good)}td.ko b{color:var(--bad)}.rowh{font-weight:600;white-space:nowrap}.err{color:var(--bad)}small{color:var(--text-secondary)}
pre{white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:8px;border-radius:6px}ul{padding-left:20px}
</style></head><body><div class="viz-root">
<h1>Kiba contre Claude seul, sur les mêmes features</h1>
<div class="muted">Run ${esc(doc.runId)} · du ${esc(doc.startedAt)} au ${esc(doc.endedAt)} · ${doc.results.length} bras · ${n} features</div>
<div class="verdict">${verdict}</div>

<h2>Coût total par bras (équivalent API, estimation)</h2>
<div class="legend"><span><i class="s1"></i>lead ou session</span><span><i class="s2"></i>lanes (workers Kiba)</span></div>
${costBars}
<h2>Durée totale (somme des features)</h2>
${timeBars}

<h2>Résultat par feature</h2>
<table><thead><tr><th>Bras</th>${head}<th>Réussies</th><th>Coût</th><th>Durée</th><th>Coût par feature réussie</th></tr></thead><tbody>${matrix}</tbody></table>

<h2>Détail des jetons</h2>
<table><thead><tr><th>Bras</th><th>Lead ou session</th><th>Lanes</th><th>Revues Codex (quota Codex, hors coût Claude)</th><th>Coût annoncé par claude -p (cumulé sur la session)</th></tr></thead><tbody>${tokensTable}</tbody></table>

<h2>Ce que Kiba a lancé</h2>${kibaDetail || "<p class=\"muted\">Aucun bras Kiba.</p>"}
${failures ? `<h2>Échecs des bras Claude seul</h2>${failures}` : ""}

<h2>Features</h2><ul>${feats}</ul>

<h2>Méthode</h2><ul>
<li>Même dépôt jouet (TypeScript, Bun) pour chaque bras, une copie par bras ; les features passent l'une après l'autre, dans la même session.</li>
<li>Kiba : le vrai produit (launcher <code>kiba</code>, session tmux, lanes réelles, porte <code>lane integrate</code>), lead Opus high (profil) ou Sonnet medium (<code>kiba --model sonnet --effort medium</code>), avec <code>ORCH_MEMORY=off</code> pour ne pas écrire dans ta mémoire.</li>
<li>Claude seul : <code>claude -p</code> avec tes réglages habituels, <code>--permission-mode bypassPermissions</code>, session reprise d'une feature à l'autre.</li>
<li>Même consigne pour tous. Une relance unique (« Oui, vas-y ») seulement si rien n'a changé dans le dépôt, comptée dans le tableau.</li>
<li>Réussite : un test d'acceptation caché, écrit après coup puis retiré. Ensuite la suite du dépôt, puis un commit dans le rôle de l'opérateur.</li>
<li>Coût : messages des transcripts Claude Code (dédoublonnés), grille de <code>src/core/paid.ts</code>. C'est un équivalent API : sur l'abonnement Max, c'est du quota, pas une facture. Les revues Codex sont comptées en jetons, sur le quota Codex. Contrôle croisé : pour Claude seul, ce calcul donne environ 20 % de plus que le coût annoncé par <code>claude -p</code> ; la même méthode est appliquée à tous les bras.</li>
<li>Durée : pour Claude seul, la durée de <code>claude -p</code> ; pour Kiba, de l'envoi de la demande au dernier message d'un modèle (lead ou lane).</li>
<li>Limites : un seul essai par case (n = 1) ; les bras d'un même run ont tourné en parallèle, ce qui peut allonger les durées ; le rappel mémoire de Kiba est coupé, donc son coût réel est un peu plus haut.</li>
</ul></div></body></html>
`;
}
