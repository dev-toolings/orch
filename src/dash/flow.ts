// The /flux page: Kiba's product architecture, one block per component with
// the settings it really runs with (profile `kiba`, policy, live machine
// budget, engine health) and a light live counter. Read-only, no model call.
import { loadPolicy } from "../core/policy.ts";
import { loadProfile, type Profile } from "../core/profile.ts";
import { tasksDir, TaskStore, type TasksState } from "../core/tasks.ts";
import { engineHealth } from "../harness/health.ts";
import { HARNESS_IDS, installed, type HarnessId } from "../harness/registry.ts";
import { DEFAULT_ROUTE } from "../lanes/route.ts";
import { kibaProfile, nativeChoice, withLeadOverride } from "../kiba/native.ts";
import { TASK_KINDS, validateKibaConfig } from "../kiba/rules.ts";
import { SLOT_WAIT_DEFAULT_SECONDS } from "../lane.ts";
import type { DashSnapshot } from "./types.ts";

export type BlockTone = "idle" | "busy" | "ok" | "bad" | "wait";
export interface ArchBlock {
  id: string; title: string; config: string[]; live: string | null; tone: BlockTone;
  about: string; sources: string[];
}
export interface FlowState { at: string; blocks: ArchBlock[] }

const DAY_MS = 24 * 3600_000;

function tasksState(state: string): TasksState | null {
  try { return new TaskStore(tasksDir(state)).read(); } catch { return null; }
}

const rung = (r: { model?: string | null; effort?: string | null }) => [r.model, r.effort].filter(Boolean).join(" ");
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

export function flowState(snap: DashSnapshot, state: string, profile: Profile = loadProfile(kibaProfile()), now = Date.now(), isInstalled: (h: HarnessId) => boolean = installed): FlowState {
  const kiba = validateKibaConfig(profile.kiba ?? {}, profile.name);
  let lead = nativeChoice(profile);
  try { const policy = loadPolicy().lead; if (policy) lead = withLeadOverride(lead, policy); } catch { /* profile value */ }
  const route = { ...DEFAULT_ROUTE, ...profile.route };
  const recent = (at: unknown) => now - Date.parse(String(at ?? "")) <= DAY_MS;

  const t = tasksState(state);
  const tasks = Object.values(t?.tasks ?? {});
  const today = tasks.filter((x) => x.state !== "ended" || recent(x.updated));
  const running = today.filter((x) => x.state === "working" || x.state === "idle");
  const back = today.filter((x) => x.state === "blocked" || x.state === "person/answer" || x.state === "person/review");
  const effects = Object.values(t?.outbox ?? {});
  const delivered = effects.filter((e) => e.kind === "deliver" && e.status === "done" && recent(e.at)).length;
  const refused = today.filter((x) => (x.failure ?? "").startsWith("delivery refused by the gate")).length;
  const pending = effects.filter((e) => e.status === "pending").length;
  const events = Object.values(t?.events ?? {}).filter((e) => recent(e.at));
  const ci = events.filter((e) => e.source === "github").length;
  const fresh = Object.values(t?.events ?? {}).filter((e) => e.disposition === "new").length;
  const results = Object.values(t?.jobs ?? {}).filter((j) => j.status === "complete").length;
  const watchdog = tasks.reduce((n, x) => n + x.evidence.filter((e) => e.kind.startsWith("watchdog-") && recent(e.at)).length, 0);

  const leads = snap.leads;
  const working = leads.filter((l) => l.activity === "working" || l.activity === "busy");
  const lanes = snap.lanes.filter((l) => l.life === "running" || l.life === "verify" || l.life === "claimed");
  const b = snap.budget;
  const health = engineHealth(state);
  const engines = HARNESS_IDS.map((h) => !isInstalled(h) ? `${h} absent` : (health[h]?.until ?? 0) > now ? `${h} indisponible (${health[h]!.kind})` : `${h} prêt`);
  const review = profile.review.claude;

  const blocks: ArchBlock[] = [
    {
      id: "operator", title: "Opérateur", tone: working.length ? "busy" : "idle",
      config: ["écrit dans la session de Kiba", "pilote orch serve : orch task new|follow|stop"],
      live: leads.length ? leads.map((l) => `${l.project} : ${l.activity === "idle" ? "au repos" : "au travail"}`).join(", ") : "aucun Kiba en marche",
      about: "Tu parles à Kiba dans sa session native (terminal ou Remote Control) : il travaille directement, les lanes sont optionnelles. Le travail en fond passe par orch serve et ses tâches.",
      sources: ["src/lead.ts", "src/serve/cli.ts"],
    },
    {
      id: "events", title: "CI et revues", tone: ci ? "wait" : "idle",
      config: ["orch serve interroge gh (poll_seconds)", "CI en échec, revue « changes requested »", "dépôts déclarés dans serve.yaml"],
      live: `${plural(ci, "événement")} sur 24\u00a0h`,
      about: "Sans appel de modèle : orch serve interroge gh sur les dépôts de sa politique et enregistre chaque nouvel échec comme événement, texte non fiable. Le premier passage d'un dépôt ne fait que noter son historique.",
      sources: ["src/core/github.ts", "src/serve/engine.ts (pollGithubSource)"],
    },
    {
      id: "results", title: "Résultats des workers", tone: results ? "ok" : "idle",
      config: ["un reçu par étape (execute, verify, review)", "processus détaché, identité sous verrou"],
      live: `${plural(results, "étape")} terminée${results > 1 ? "s" : ""} dans le journal`,
      about: "Chaque étape d'une tâche est un job détaché qui écrit son reçu ; le moteur l'adopte après un redémarrage, ou la marque interrompue avec une note de reprise.",
      sources: ["src/serve/job.ts", "src/serve/workers.ts"],
    },
    {
      id: "inbox", title: "Journal des tâches", tone: fresh ? "wait" : "idle",
      config: ["tasks/state.json, sous verrou", "événement enregistré avant traitement, dédupliqué", "filtre par code, provenance marquée"],
      live: `${fresh} événement${fresh > 1 ? "s" : ""} à traiter, ${plural(events.length, "reçu")} sur 24\u00a0h`,
      about: "Tout ce qui arrive à orch serve passe ici : demandes, suites, CI et revues. Un suivi sur un fil connu va droit au worker de sa tâche, sans appel de routeur. Le texte venu de l'extérieur reste une donnée, jamais un ordre.",
      sources: ["src/core/tasks.ts", "src/core/inbound.ts (filterEvent)"],
    },
    {
      id: "wake", title: "Outbox", tone: pending ? "wait" : "idle",
      config: ["seule voie de publication", "livraison, commentaire de PR, notification", "réconcilié avec la destination avant une reprise"],
      live: `${pending} effet${pending > 1 ? "s" : ""} en attente`,
      about: "Les workers ne publient jamais. L'outbox livre par lane integrate, commente une PR avec un marqueur et notifie au plus une fois ; chaque effet est vérifié à sa destination avant d'être retenté.",
      sources: ["src/serve/engine.ts (drainOutbox)", "src/presence/notify.ts"],
    },
    {
      id: "lead", title: "Kiba (lead)", tone: working.length ? "busy" : leads.length ? "idle" : "wait",
      config: [`Claude natif ${rung(lead)}`, "agent kiba, mémoire et outils natifs", "Claude seulement ; Codex et Grok : workers et revues"],
      live: leads.length ? `${plural(leads.length, "session")}, ${working.length} au travail` : "aucune session",
      about: "Un seul agent implémente et vérifie le travail dans la session. Les lanes servent à isoler ou paralléliser ; orch task adopt fait passer son travail par la porte de livraison. kiba --conductor affiche l'état d'orch serve.",
      sources: ["src/kiba/native.ts", "catalog/kiba-native.md", "catalog/profiles/kiba.yaml"],
    },
    {
      id: "dispatch", title: "orch serve et échelle", tone: back.length ? "bad" : running.length ? "busy" : "idle",
      config: [
        TASK_KINDS.map((k) => `${k} ${rung(kiba.ladder[k])}`).join(", "),
        `${kiba.escalate_after} échecs : un barreau plus haut ; ${kiba.max_attempts} : retour à l'opérateur`,
        "une tâche : mandat fixe (FILES, VERIFY, risque), une session worker reprenable",
      ],
      live: `${running.length} en cours, ${today.length - running.length - back.length} finies, ${back.length} pour toi (24\u00a0h)`,
      about: "Le moteur déterministe admet les événements, route un suivi au worker propriétaire et n'appelle le routeur modèle que pour un événement ambigu sans tâche. Après des échecs, un barreau plus haut (modèle puis effort, jamais au-dessus de high), puis retour à l'opérateur.",
      sources: ["src/serve/engine.ts", "src/kiba/rules.ts"],
    },
    {
      id: "route", title: "Routage des harnais", tone: engines.some((e) => e.includes("indisponible")) ? "wait" : "ok",
      config: [`ordre : ${route.order.join(" > ")}`, `revue : ${review.to} ${rung(review)}`, `contest : ${(profile.contest?.to ?? []).join(", ")}, juge ${profile.contest?.judge?.model ?? "?"}`],
      live: engines.join(", "),
      about: "Le premier harnais installé et disponible dans l'ordre du profil prend la lane. Un harnais en panne ou sans quota est marqué indisponible 15 min et la lane passe au suivant. Une tâche risquée passe d'abord sa spec à plusieurs modèles et un juge, puis demande une revue d'une autre famille.",
      sources: ["src/lanes/route.ts", "src/harness/health.ts", "src/lane.ts (laneContest)"],
    },
    {
      id: "budget", title: "Budget machine", tone: b.budget > 0 && lanes.length >= b.budget ? "wait" : lanes.length ? "busy" : "idle",
      config: [
        `${b.budget} places, toute la machine (limite : ${b.limitedBy})`,
        `plafond ${b.ceiling}, CPU ${b.cpu}, RAM ${b.ram}${b.quota != null ? `, quota ${b.quota}` : ""}`,
        `attente ${profile.limits.slot_wait_seconds ?? SLOT_WAIT_DEFAULT_SECONDS} s si plein, VERIFY ${profile.limits.verify_concurrent} à la fois`,
      ],
      live: `${lanes.length}/${b.budget} places prises`,
      about: "Une place par lane ou par consultation, partagée entre tous les Kiba et tous les projets. Le budget est le plus petit de : cœurs / 2, RAM libre, plafond du profil, quota. Plein : la lane attend une place, puis abandonne.",
      sources: ["src/lanes/budget.ts", "src/lanes/slots.ts", "src/lane.ts (waitLaneSlot)"],
    },
    {
      id: "lanes", title: "Lanes (workers)", tone: lanes.length ? "busy" : "idle",
      config: ["un worktree git par lane", "écrit seulement dans son worktree", `délai ${kiba.lane_timeout_seconds} s`],
      live: lanes.length ? `${lanes.length} en cours : ${lanes.map((l) => l.model).join(", ")}` : "aucune en cours",
      about: "Chaque lane lance un harnais sans interface dans son propre worktree, avec l'environnement minimal, puis exécute VERIFY. Le worker ne peut écrire que dans son worktree (garde PreToolUse) ; une écriture ailleurs fait échouer la lane.",
      sources: ["src/lane.ts", "src/lanes/guard.ts", "src/harness/proc.ts"],
    },
    {
      id: "watchdog", title: "Watchdog", tone: watchdog ? "wait" : "idle",
      config: [`${kiba.watchdog.stall_seconds} s sans activité`, `${kiba.watchdog.max_turns_without_test} étapes sans test`, "écriture hors FILES"],
      live: `${watchdog} signa${watchdog > 1 ? "ux" : "l"} sur 24\u00a0h`,
      about: "Surveille les workers d'orch serve : blocage, boucle sans test, dérive hors FILES. Il tue le groupe de processus fautif et le note dans les preuves de la tâche ; l'échelle s'applique ensuite.",
      sources: ["src/kiba/watchdog.ts"],
    },
    {
      id: "gate", title: "Porte lane integrate", tone: refused ? "bad" : delivered ? "ok" : "idle",
      config: ["VERIFY passé, fichiers dans FILES", "tests de base contre le code de la lane", "revue ship si risquée, branche de feature", "une intégration à la fois (flock)"],
      live: `${delivered} livrée${delivered > 1 ? "s" : ""}, ${refused} refusée${refused > 1 ? "s" : ""} (24\u00a0h)`,
      about: "Rien n'entre dans le dépôt sans passer ici. Les tests sont remis à leur version de base et lancés contre le code de la lane, pour qu'un worker ne puisse pas modifier un test afin de passer. Un refus est journalisé et rien ne bouge.",
      sources: ["src/lane.ts (laneIntegrate)", "src/lanes/protect.ts", "src/lanes/lock.ts"],
    },
    {
      id: "develop", title: "Dépôt du projet", tone: delivered ? "ok" : "idle",
      config: ["une branche et une PR par livraison", "la fusion reste à l'opérateur"],
      live: `${plural(delivered, "livraison")} sur 24\u00a0h`,
      about: "Une livraison crée un commit du code vérifié sur une branche neuve, la pousse et ouvre une PR vers la branche de départ. Le checkout de l'opérateur ne bouge pas ; fusionner reste ton choix.",
      sources: ["src/lane.ts", "src/lanes/ledger.ts"],
    },
  ];
  return { at: snap.at, blocks };
}
