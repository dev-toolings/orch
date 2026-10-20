#!/usr/bin/env bun
// Billable memory benchmark (calls real models): run only on the operator's
// request. One "learn" session per harness hears 20 private decisions about a
// fictional project (4 corrected later) and must save them with orch mem; then
// each question is asked in a fresh session, once with those notes (mem arm)
// and once with an empty store (control arm). Scores answers and records
// tokens and cost per session. Usage: bun scripts/mem-bench.ts <out-dir> [claude,codex,grok]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type Fact = { id: string; say: string; q: string; a: string; fix?: string; old?: string };
const FACTS: Fact[] = [
  { id: "F01", say: "Le serveur de staging du projet Atlas s'appelle bivouac-7.", q: "Comment s'appelle le serveur de staging du projet Atlas ?", a: "bivouac-7" },
  { id: "F02", say: "Sur Atlas, les migrations de base ne se lancent que le jeudi.", q: "Quel jour lance-t-on les migrations de base sur Atlas ?", a: "jeudi" },
  { id: "F03", say: "Le port local de l'API Atlas est 4817.", q: "Quel est le port local de l'API Atlas ?", a: "4817" },
  { id: "F04", say: "La base de test d'Atlas s'appelle atlas_qa_ember.", q: "Comment s'appelle la base de test d'Atlas ?", a: "atlas_qa_ember" },
  { id: "F05", say: "Le client pilote d'Atlas est Verlaine Logistique.", fix: "Correction : le client pilote d'Atlas n'est plus Verlaine Logistique, c'est Orbe Transports.", q: "Quel est le client pilote d'Atlas ?", a: "orbe transports", old: "verlaine" },
  { id: "F06", say: "Pour Atlas, je veux des messages de commit en anglais, à l'impératif.", q: "En quelle langue doivent être les messages de commit d'Atlas ?", a: "anglais" },
  { id: "F07", say: "Le budget cloud mensuel maximum d'Atlas est de 340 euros.", q: "Quel est le budget cloud mensuel maximum d'Atlas, en euros ?", a: "340" },
  { id: "F08", say: "Le feature flag de la nouvelle facturation Atlas est ATLAS_BILLING_V3.", q: "Quel feature flag active la nouvelle facturation d'Atlas ?", a: "atlas_billing_v3" },
  { id: "F09", say: "Les alertes d'Atlas partent sur le canal Slack atlas-pager.", q: "Sur quel canal Slack partent les alertes d'Atlas ?", a: "atlas-pager" },
  { id: "F10", say: "Le timeout HTTP des workers Atlas est de 45 secondes.", fix: "Correction : le timeout HTTP des workers Atlas passe de 45 à 90 secondes.", q: "Quel est le timeout HTTP des workers Atlas, en secondes ?", a: "90", old: "45" },
  { id: "F11", say: "Atlas utilise la librairie de dates luxon, jamais date-fns.", q: "Quelle librairie de dates utilise Atlas ?", a: "luxon" },
  { id: "F12", say: "La responsable produit d'Atlas s'appelle Maëlle Ronsard.", q: "Comment s'appelle la responsable produit d'Atlas ?", a: "ronsard" },
  { id: "F13", say: "Les releases d'Atlas sont taguées au format atlas-AAAA.MM.N.", q: "Quel est le format des tags de release d'Atlas ?", a: "atlas-aaaa.mm.n" },
  { id: "F14", say: "Pour Atlas je refuse tout ORM : SQL brut avec Kysely uniquement.", q: "Quel outil d'accès à la base utilise-t-on sur Atlas ?", a: "kysely" },
  { id: "F15", say: "Atlas est déployé dans la région eu-west-3.", fix: "Correction : Atlas migre de eu-west-3 vers la région eu-central-1.", q: "Dans quelle région cloud Atlas est-il déployé ?", a: "eu-central-1", old: "eu-west-3" },
  { id: "F16", say: "Les exports d'Atlas vont dans le bucket atlas-exports-cold.", q: "Dans quel bucket vont les exports d'Atlas ?", a: "atlas-exports-cold" },
  { id: "F17", say: "Le seuil d'alerte de latence p95 d'Atlas est de 380 ms.", q: "Quel est le seuil d'alerte de latence p95 d'Atlas, en ms ?", a: "380" },
  { id: "F18", say: "Le nom de code de la v2 d'Atlas est Héron.", q: "Quel est le nom de code de la v2 d'Atlas ?", a: "heron" },
  { id: "F19", say: "Je veux que les PR d'Atlas fassent au plus 400 lignes.", q: "Combien de lignes au plus doit faire une PR d'Atlas ?", a: "400" },
  { id: "F20", say: "La clé de chiffrement d'Atlas tourne tous les 21 jours.", fix: "Correction : la clé de chiffrement d'Atlas tourne désormais tous les 14 jours, plus 21.", q: "Tous les combien de jours tourne la clé de chiffrement d'Atlas ?", a: "14", old: "21" },
];

const RULES = `Memory rules (the operator's lead developer):
- Before answering about a past decision or an operator preference, run \`orch mem search <words>\` (then \`orch mem show <id>\` if needed).
- Save only durable decisions, one note each: \`orch mem add "..."\` (project scope by default). Write each note in the operator's language and words: recall is by keyword, so a note in another language is not found.
- A decision that changes: \`orch mem supersede <id> "..."\`. Never add a contradicting note beside the old one.
Use only your shell tool. Run commands one at a time.`;

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

type Run = { text: string; input: number; cached: number; output: number; usd: number | null; ok: boolean; secs: number };

function sh(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; input?: string }) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", timeout: 600_000, maxBuffer: 64 << 20 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status, secs: (Date.now() - t) / 1000 };
}

function runHarness(h: string, prompt: string, cwd: string, state: string): Run {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ORCH_STATE: state, ORCH_HARNESS: h };
  delete env.ORCH_LEAD;
  delete env.ORCH_LANE;
  if (h === "claude") {
    const r = sh("claude", ["-p", prompt, "--model", "haiku", "--allowedTools", "Bash", "--output-format", "json"], { cwd, env });
    try {
      const j = JSON.parse(r.out);
      const u = j.usage ?? {};
      return { text: j.result ?? "", input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, usd: j.total_cost_usd ?? null, ok: r.code === 0, secs: r.secs };
    } catch { return { text: r.out.slice(-500), input: 0, cached: 0, output: 0, usd: null, ok: false, secs: r.secs }; }
  }
  if (h === "codex") {
    const last = join(cwd, ".last.txt");
    const r = sh("codex", ["exec", "--json", "-C", cwd, "-s", "workspace-write", "--skip-git-repo-check", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-o", last, prompt], { cwd, env });
    let input = 0, cached = 0, output = 0;
    for (const line of r.out.split("\n")) {
      try {
        const e = JSON.parse(line);
        const u = e.usage ?? e.msg?.usage ?? (e.type === "turn.completed" ? e.usage : null);
        if (u) { input += u.input_tokens ?? 0; cached += u.cached_input_tokens ?? 0; output += u.output_tokens ?? 0; }
      } catch {}
    }
    const text = existsSync(last) ? readFileSync(last, "utf8") : "";
    return { text, input: input - cached, cached, output, usd: null, ok: r.code === 0, secs: r.secs };
  }
  const f = join(cwd, ".prompt.txt");
  writeFileSync(f, prompt);
  const r = sh("grok", ["--cwd", cwd, "--prompt-file", f, "--output-format", "json", "--always-approve"], { cwd: "/tmp", env });
  try {
    const j = JSON.parse(r.out);
    const u = j.usage ?? {};
    return { text: j.text ?? "", input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, usd: j.total_cost_usd ?? null, ok: r.code === 0, secs: r.secs };
  } catch { return { text: r.out.slice(-500), input: 0, cached: 0, output: 0, usd: null, ok: false, secs: r.secs }; }
}

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  spawnSync("sh", ["-c", "git init -q && printf 'Atlas\\n' > README.md && git add . && git -c user.email=b@b -c user.name=b commit -q -m init"], { cwd: dir });
}

const [outDir = "/tmp/mem-bench", list = "claude,codex,grok"] = process.argv.slice(2);
for (const h of list.split(",")) {
  const base = join(outDir, h);
  const memRepo = join(base, "mem-repo"), ctlRepo = join(base, "ctl-repo");
  repo(memRepo); repo(ctlRepo);
  const memState = join(base, "mem-state"), ctlState = join(base, "ctl-state");
  mkdirSync(memState, { recursive: true }); mkdirSync(ctlState, { recursive: true });
  const learnPrompt = `${RULES}\n\nWork only inside ${memRepo}. During this work session the operator tells you, in order:\n${FACTS.map((f) => `- ${f.say}`).join("\n")}\nLater in the same session the operator adds:\n${FACTS.filter((f) => f.fix).map((f) => `- ${f.fix}`).join("\n")}\nApply the memory rules to everything the operator said, then reply "done".`;
  const learn = runHarness(h, learnPrompt, memRepo, memState);
  const notes = spawnSync("sh", ["-c", "ls .orch/mem 2>/dev/null | wc -l"], { cwd: memRepo, encoding: "utf8" }).stdout.trim();
  const rows: unknown[] = [];
  for (const f of FACTS.slice(0, Number(process.env.BENCH_N ?? FACTS.length))) {
    const ask = (dir: string) => `${RULES}\n\nWork only inside ${dir}. The operator asks: ${f.q}\nAnswer in one short line. If you do not know, say "unknown".`;
    const mem = runHarness(h, ask(memRepo), memRepo, memState);
    const ctl = runHarness(h, ask(ctlRepo), ctlRepo, ctlState);
    const score = (r: Run) => ({ correct: norm(r.text).includes(norm(f.a)), stale: !!f.old && norm(r.text).includes(norm(f.old)) && !norm(r.text).includes(norm(f.a)) });
    rows.push({ id: f.id, corrected: !!f.fix, mem: { ...mem, ...score(mem), text: mem.text.slice(0, 200) }, ctl: { ...ctl, ...score(ctl), text: ctl.text.slice(0, 200) } });
    writeFileSync(join(base, "results.json"), JSON.stringify({ harness: h, learn: { ...learn, text: learn.text.slice(0, 300), notes: Number(notes) }, rows }, null, 2));
  }
  console.log(`${h} done`);
}
