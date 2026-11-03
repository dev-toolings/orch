# Architecture d'orch

Cible : Kiba, agent généraliste sur le modèle d'Émilien, hébergé
chez l'opérateur (kev-homelab, Mac mini 48 Go en secours). Remplace
`design.md` et `lead-design.md`, retirés le 2026-10-24.

Référence : fil de migration d'Émilien du 2026-10-24,
https://x.com/powlisher/status/2113926146089680954 ;
les cas vérifiables sont dans
`tests/parity/emilien.yaml`.

## Modes de lancement

`kiba` lance Claude avec l'agent natif nommé `kiba`, son rôle coordinator
(opus/medium par défaut) et les hooks mémoire. Les petites tâches restent
sur la session native. Les lanes et leur porte d'intégration servent aux
besoins d'isolation, de parallélisme ou de travail en fond.

Kiba runs on Claude only (operator decision): `kiba codex` and `kiba grok`
exit 2, Codex and Grok are lane workers and reviewers. The dispatch-only
conductor (`kiba --conductor`, its `kiba` MCP server, wakes and presence
lead) is retired; the conductor is `orch serve` (section below), and
`kiba --conductor` now prints its status. Les mesures et leur périmètre
sont dans `docs/benchmark.md`.

## Vue d'ensemble

Le dépôt fournit tout ; les données vivent hors du dépôt.

```
            iPhone · MacBook
                   │
             tailnet privé
                   │
                   v
 ┌──────────────────────────── kev-homelab ─────────────────────────────────┐
 │                                                                          │
 │   orch serve (opt-in)         routines (quand dues)      ops (Hublot)    │
 │  ┌────────────────────┐     ┌─────────────────────┐    ┌──────────────┐  │
 │  │ tâches durables    │     │ 6 routines,         │    │ quotas,      │  │
 │  │ workers claude -p  │     │ une à la fois       │    │ routines,    │  │
 │  │ gate + outbox      │     │ (flock)             │    │ lanes,       │  │
 │  │ kiba natif à part  │     │ ingestion, brief,   │    │ souvenirs,   │  │
 │  │ notify Telegram    │     │ contrôles socle     │    │ contrôles    │  │
 │  └─────────┬──────────┘     └──────────┬──────────┘    └──────┬───────┘  │
 │            │                           │                      │          │
 │            └─────────────┬─────────────┘                      │          │
 │                          v                                    │          │
 │                ┌───────────────────┐       ┌──────────────┐   │          │
 │                │ brain             │ ────> │ llm          │   │          │
 │                │ orch mem (CLI)    │       │ embed: openai│   │          │
 │                │ store, ingest,    │       │ decide:      │   │          │
 │                │ parity, backup    │       │ claude       │   │          │
 │                └─────────┬─────────┘       └──────────────┘   │          │
 │                          │                                    │          │
 │                          v                                    │          │
 │   ┌──────────────────────────────────────────────┐            │          │
 │   │ brain-postgres + pgvector (Docker)           │ <──────────┘          │
 │   │ brain_projets  brain_mails  brain_clients    │                       │
 │   │ brain_voyages  brain_compta                  │                       │
 │   │ un rôle Postgres par base                    │                       │
 │   └──────────────────────┬───────────────────────┘                       │
 │                          │                                               │
 │   lanes : workers codex · claude · grok dans des worktrees               │
 │                                                                          │
 └──────────────────────────┼───────────────────────────────────────────────┘
                            │
                 pg_dump chiffré, chaque nuit
                            │
                            v
                Mac mini 48 Go (secours)
```

Un seul point d'entrée vers la mémoire (`brain`, exposé par `orch mem`), un
seul vers les modèles (`llm`). La base est la source de vérité de la mémoire ;
le Markdown ne sert plus qu'à l'import et à l'export lisible.

## Modules

| Module | Rôle | État au 2026-10-24 |
|---|---|---|
| `src/llm/` | Fournisseurs `embed` (OpenAI, Qwen local plus tard) et `decide` (Claude, Qwen plus tard), commutables ; refus d'un changement d'espace d'embedding sans `--force` | livré |
| `src/mem/` | `orch mem` : trois portées, `review` ; backend fichiers ou `brain` | livré, bascule à faire |
| `src/lanes/`, `src/lane.ts` | Délégation dans des worktrees, gate d'intégration, revue croisée ; route fixe (lead si 2 fichiers ou moins, sinon premier harness installé ; `max20` : Claude puis Codex puis Grok, Codex reste reviewer) ; `lane contest` : la même question à Codex, Grok et Claude, un juge Fable sur les réponses anonymisées (2026-10-25). `lane batch --mission` : DAG de specs, même `laneRun` + gate, budget réservé, pause entre les nœuds. Gate chronométré (wait / setup / run), cache bun partagé, VERIFY `bun test` limité aux tests affectés (`lane pre-push` en local ; suite complète = banc nightly). Sous Orca, les lanes apparaissent comme worktrees enfants avec statut et terminal de suivi ; leur worktree est créé dans le dossier de workspaces d'Orca et retiré par `orca worktree rm`, seule suppression qui fait oublier la carte à Orca (git en repli, routine `orca-prune` pour les restes). | livré |
| `src/lead.ts` | Starts Kiba, the only lead, natively on Claude Code (`bypassPermissions`, operator choice reaffirmed 2026-11-01); `kiba codex` and `kiba grok` exit 2 (Claude only); `kiba --conductor` prints the orch serve status | livré |
| `src/hooks/` | Hooks des sessions lead Claude (no PreToolUse hook for native Kiba) ; journal de mission (STATE, DECISIONS, ERRORS, PATHS, NEXT, EVIDENCE) écrit en continu ; une session trop grosse relance un `kiba` frais depuis le log, pas une compaction | livré |
| `src/docs/` | Corpus de docs officielles indexé par `ctx` | livré |
| `src/install/` | Manifeste : fichiers sous HOME, liens, bientôt units systemd et compose | livré, à étendre |
| `src/brain/` | Postgres + pgvector : store (hash unique, supersede, forget), recherche par le vecteur seul (texte hors ligne), notes vectorisées à l'écriture, `orch brain eval`, import des notes, provisionnement des rôles, sauvegarde chiffrée et contrôle de restauration | en service, `mem: brain` (255 notes des 15 dépôts, toutes vectorisées) |
| `src/memory/` | Mémoire vivante : client Hindsight (retain à chaque tour, recall synchrone avant chaque prompt, deux banks : `kiba` et `kiba-<projet>`), branché par les hooks du lead Claude ; USER.md et MEMORY.md plafonnés injectés au démarrage ; auto-memory native de Claude Code désactivée | en service (2026-10-28) |
| `src/presence/` | Notification channels only (Telegram, Discord) for orch serve, routines, improve and reflect; the persistent presence lead is retired (orch serve replaced it); `orch kill` / `orch resume` write and clear PAUSE | en service |
| `src/routines/` | Sept routines lancées quand elles sont dues (intervalle `every`, nouvel essai `retry`, compté depuis le début du passage, 2 min de tolérance), une tick au démarrage puis toutes les 15 min, une à la fois sous verrou, journal, alertes dédoublonnées | en service (7 actives) |
| `src/improve/` | Amélioration continue : relevé quotidien sans modèle (routines, lanes, messages de l'opérateur et erreurs d'outils des sessions interactives), puis au plus 3 propositions d'un Claude en lecture seule, envoyées au téléphone ; appliquées seulement sur « valide N » | livré le 2026-10-25 |
| `src/rules/` | Règles candidates (refus de gate, revues, corrections) ; banc nightly de 3 missions de référence (bug, feature, contrat API+client) ; une règle n'est gardée que si le score s'améliore ; refus seulement si pause | livré |
| `src/bus/` | Boîte aux lettres entre projets déclarés dans `orch.yaml` : messages signés HMAC (clé locale, pas le dossier partagé), jamais un ordre ; le destinataire en fait éventuellement une spec qui passe par sa gate | livré |
| `infra/` | `compose.yml` (brain-postgres), migrations SQL | livré |

## Règles

- **Secrets** : uniquement dans `.env` (git-ignoré, `chmod 600`) ou
  l'environnement ; jamais dans les logs, rapports ou notes.
- **Compartiments** : une base par domaine, un rôle Postgres par base ; Kiba
  lit, l'ingestion écrit, la compta a son propre outil d'accès.
- **Idempotence** : un hash unique par souvenir ; chaque souvenir garde sa
  source (mail, fichier).
- **Sauvegarde** : validée seulement par une restauration qui retrouve le même
  nombre de souvenirs et les mêmes résultats sur les 5 requêtes de contrôle.
- **Pas de repli silencieux** entre fournisseurs de modèles.
- **Tests** : jamais d'appel de modèle ; les bancs payants sont archivés dans
  la branche `archive/benches`.
- **Permissions du lead** : Claude en `bypassPermissions` par défaut
  (choix de l'opérateur, réaffirmé le 2026-11-01). En bypass, le hook
  PreToolUse ne renvoie plus `ask` (un `ask` forcerait une confirmation
  malgré bypass) sauf pour un `rm` hors worktree ou récursif.   Secrets
  (untracked `.env*`, `*.pem`, `id_rsa*`, credentials, `~/.ssh`, `~/.aws`, tokens) et
  fichiers de garde orch (hooks, `lead-settings.json`, `policy.yaml`)
  sont un `deny` dur dans tous les modes, y compris bypass, aussi dans
  `permissions.deny` de `lead-settings.json`. Les modèles `.env.example` /
  `.dist` / `.sample` / `.template` / `.dev` / `.test` et un `.env` suivi
  par git restent lisibles. Les autres modes
  (`default`, `auto`, `acceptEdits`, `plan`) et un `permission_mode`
  absent gardent le jeu d'ask complet. L'opérateur peut encore passer
  `--permission-mode` ou `--dangerously-skip-permissions` à la main.
- **Coût estimé (jour)** : orch suit un coût estimé (tokens x tarifs publics)
  à titre informatif. `spend.daily_usd` reste accepté dans une policy locale
  pour compatibilité, mais est ignoré (déprécié) et ne bloque rien.
- **Famille du reviewer** : un `ORCH_HARNESS` changé dans le shell du lead peut
  choisir une autre famille de reviewer ; même statut de garde-fou.

## Kiba, the native lead (Claude only)

Kiba is the only lead (operator decisions of 2026-11-02 and 2026-11-03):
`kiba` (or `orch kiba`, `lead`) starts one native `claude --agent kiba`
session with the profile's coordinator role, memory hooks and the settings
deny rules of the hook policy, and no PreToolUse hook. Codex and Grok are
lane workers and reviewers only.

The dispatch-only conductor (P5 of the redesign) is retired: its `kiba` MCP
server, `orch kiba run|wait|status|event|github|watchdog`, the wake hooks,
its conductor prompt and the presence lead are gone. `orch serve migrate`
imports what it left in `<state dir>/kiba/` into the task store once (also run
at every `orch serve` start, behind a marker in the journal): running intents
become tasks (a dead runner is recovered with the recovery note, a live one
defers the import), conductor lanes in `delivery-pending` become delivery
effects the outbox resumes (the PR found by branch first), unacknowledged
results and events become notifications sent at most once, held threads
become task threads, and cancelled intents stay cancelled. The old files are
left in place, read-only.

Noms : USER.md et MEMORY.md vivent dans `<state dir>/kiba-memory/`, les banks
Hindsight sont `kiba` et `kiba-<projet>` (déplacées par `orch brain
hindsight-rename`, clone sans LLM).

## orch serve (conductor v2)

`orch serve` is the event-driven facade of the shared orch core, opt in
(`orch-serve.service` is written by `orch install`, never enabled by it). It
makes no model call of its own except the router, and only for an ambiguous
event.

```text
 operator CLI (orch task)      GitHub CI failures and reviews (gh poll)
          |                                  |
          v                                  v
.---------+----------------------------------+---------.
| src/core/tasks.ts  events (persisted, dedup by key)  |
|                    tasks, jobs, outbox               |
'---------+--------------------------------------------'
          |
          v
.---------+---------------------------------------------.
| src/serve/engine.ts (deterministic pass)              |
|  admit: rules, thread owner (direct, no router),      |
|         router only for an ambiguous event            |
|  jobs:  adopt live, mark dead interrupted + note      |
|  plan:  execute -> verify -> (review) -> deliver      |
|  outbox: the only publisher, reconcile before retry   |
'---------+-------------------------+-------------------'
          |                         |
          v                         v
.---------+---------------.  .------+------------------------.
| job.ts (detached)       |  | lane integrate --branch       |
|  claude -p --resume     |  |  commit, push, PR (gh),       |
|  --agent worker         |  |  existing PR found by branch  |
|  orch task adopt VERIFY |  | PR comment found by marker    |
'-------------------------'  '-------------------------------'
```

- A task keeps one mandate (repo, FILES, VERIFY, risk, base branch, admitting
  source and sender, policy version), one thread, one native session and one
  worktree (`<state dir>/tasks/wt/<id>`, branch `orch/task-<id>`). Each
  revision is delivered on its own branch `orch/<id>-r<n>`; the engine then
  owns that branch's thread, so a review on the PR reaches the same session.
- GitHub admission per kind in `~/.orch/policy/serve.yaml`: `admit` (work;
  a new task by rule), `route` (work for an owner; otherwise the router
  decides), `context` (attached to an owner's next revision), `ignore`. A
  repository's first poll only records its backlog.
- Workers cannot publish because they hold no credential: an own HOME per
  task (only Claude's credentials file linked), a git config that refuses
  every transport and has no credential helper, an unusable push URL in the
  task worktree, an empty gh config and no forge token. Deny rules
  (`Bash(git push *)`, `Bash(gh pr *)`, `Bash(gh api *)`, `Bash(gh issue *)`,
  WebFetch to github.com) and a PreToolUse hook remain as defense in depth,
  with `ORCH_HEADLESS=1` so any ask becomes a deny. The outbox publishes from
  the engine with the operator's environment.
- The live journal is bounded: past fixed limits the oldest terminal tasks,
  jobs, effects and events go to `<state dir>/tasks/archive/` (rotated); a
  compact key index keeps deduplication, and an archived ended task comes
  back on a new message.
- Crash recovery: a job outlives the engine (own process group, unit
  `KillMode=process`); a restarted engine adopts it by pid and start time, or
  replans the same step with "check the worktree, git history and the
  destination before repeating any outside action". A dead VERIFY never
  relaunches the worker. Pending outbox effects replay through their
  reconciliation; a notice is sent at most once.
- `orch task stop` ends a task for good (running jobs killed, pending effects
  withdrawn); PAUSE holds every new step and publication.

## Étapes

1. `llm` : livré (2026-10-24).
2. Ménage : bancs archivés, `mem outcome`/`graph`, canal Orca, routage par les
   coûts et leads Codex/Grok retirés, parité réduite (2026-10-24).
3. Chargeur `.env` commun dans `core/env.ts` (livré). Le déplacement des points
   d'entrée sous `src/cli/` est abandonné : il casserait les liens installés.
4. `infra/` et `brain/` : Postgres + pgvector, migrations, store, import des
   notes existantes, sauvegarde ; EM10 vérifié, EM11 attend les 5 requêtes de
   contrôle sur des données réelles (livré le 2026-10-24, à démarrer).
5. `orch mem` branché sur `brain` derrière `mem: brain` (livré le 2026-10-24) ;
   la bascule attend le démarrage du conteneur et un `orch brain import-notes`.
6. `presence` (EM20, EM21), `routines` (EM30) et `ops` (EM40) : livrés le
   2026-10-24, en attente d'installation ; EM41 (vue en direct depuis le
   téléphone) reste à faire.
7. `lane contest` et `improve` (repris d'Émilien) : livrés le 2026-10-25.
   Reprise après coupure et récapitulatif à l'extinction : DEV-ORCH-15 et
   DEV-ORCH-14, urgents.
8. Mémoire vivante, phase A (2026-10-28) : Hindsight en service sur
   `127.0.0.1:8899`, hooks SessionStart / UserPromptSubmit / PostToolUse / Stop,
   USER.md et MEMORY.md tenus par le lead. Décision fondée sur 8 recherches
   Codex (`~/.orch/orch/asks/memoire-vivante/SYNTHESE.md`). Phase B (28-10 au
   soir) : routine `reflect` (`orch reflect run`, un Claude en lecture seule
   par nuit) : MEMORY.md réécrit sous garde (plafond, moitié, 3 lignes
   perdues au plus), règles USER.md en candidats (`orch reflect accept|reject
   <n>`), brouillons de skills sous `<state>/reflect/skills/`. Phase C
   (28-10 au soir) : routine `hindsight-seed` (`orch brain hindsight-seed`,
   incrémental) copie notes `orch mem` et exhaust dans les banks. Banc
   `tests/parity/memoire.yaml` joué le 28-10 (`make bench-memoire`, 171 runs,
   juge Codex) : rappel 11/12 avec Hindsight contre 9/12 (le lead sans Hindsight) et
   8/12 (Claude seul), 250 ms par prompt, pas de surcoût en sortie ;
   compte rendu archivé (voir `docs/archive/README.md`).

## Mise en service (feu vert de l'opérateur à chaque ligne)

Fait le 2026-10-24 : `orch brain init`, `up`, `provision`, `import-notes` ;
`orch install --enable` (cycle install, uninstall complet vérifié,
réinstallation). Reste :

1. Clés dans `.env` : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` ; tester avec
   `orch presence notify bonjour`.
2. Activer `brain-embed` (payant) puis `orch brain embed` ; basculer
   `mem: brain` dans `catalog/brain.yaml`.
3. Les 5 requêtes de contrôle dans `catalog/brain.yaml`, puis
   `orch brain backup` et `orch brain restore-check` (EM11).
4. Socle : `sudo infra/host/harden.sh apply` (SSH par clé seule, root
   refusé, `ufw`), puis revue des ports publiés par Docker ; `orch ops check`
   doit être vert (EM40). Voir `docs/host-hardening.md`.

`orch uninstall` arrête et désactive les unités, termine la session (arbre
de processus du panneau tmux) puis retire tout ce que liste le manifeste.

Compte rendu détaillé de la journée de mise en place : archivé, voir `docs/archive/README.md`.

Pas de seconde agente (« Juliette ») pour l'instant : décision de
l'opérateur du 2026-10-24.
