# orch

> **Work in progress.** orch is an experimental personal toolkit, published as
> is: interfaces, commands and docs change without notice. Not ready for use.

Kiba, the native agent on Claude Code only (Codex and Grok are lane workers
and reviewers, as is Claude), with its own memory (`orch mem`) and
switchable model providers (`orch llm`). `kiba` starts the native agent
named Kiba: direct work, memory and optional lanes. The always-on conductor
is `orch serve` (durable tasks, resumable `claude -p` workers, the delivery
gate and an outbox that alone publishes); `kiba --conductor` prints its
status. Voir `docs/architecture.md`.

```text
.------------------------------------.      .----------------------------.
| kiba (Claude Code, bypass)         |      | orch serve (opt-in unit)   |
| native agent, memory hooks,        |      | events persisted, dedup,   |
| optional lanes, orch task adopt    |      | one worker per task,       |
'-----------------+------------------'      | watchdog, ladder, outbox   |
                  |                         '-------------+--------------'
                  v                                       v
.-----------------+---------------------------------------+--------------.
| lanes and gate: worktrees, VERIFY, FILES, ship review, delivery PR     |
'------------------------------------------------------------------------'
```

Kiba est le seul lead. Sur Claude, il travaille directement en opus/medium
par défaut (rôle coordinator du profil `catalog/profiles/kiba.yaml`) ;
`lead.claude: { model: sonnet, effort: medium }` dans `catalog/policy.yaml` le
change sur un hôte. `kiba codex` and `kiba grok` exit 2: Kiba runs on Claude
only. The retired dispatch-only conductor left its state in `<state>/kiba/`:
`orch serve migrate` (also run at every `orch serve` start) imports it once.
`orch lane watch` montre les lanes en cours.

## Commandes

| Commande | Effet |
|---|---|
| `kiba [claude] [args]`, `orch kiba` | Starts Kiba, the native agent on Claude Code (`lead` is an alias); `kiba codex` and `kiba grok` exit 2 (Claude only); `kiba --conductor` prints the orch serve status (tasks, workers, pending effects) |
| `orch serve [--once]\|migrate`, `orch task new\|list\|show\|follow\|stop\|adopt` | The conductor: durable tasks, one resumable worker per task, the gate and the outbox; `migrate` imports the retired conductor state once |
| `lane run --to codex --spec f` | Délègue une tâche dans un worktree dédié, en headless ; rapport borné |
| `lane route --spec f` | Dit qui fait la spec (le lead si 2 fichiers ou moins ; sinon le premier harness installé dans l'ordre du profil), avec quel effort (`medium` par défaut, `low` pour une spec `MECHANICAL: yes` sans risque, `high` si risque ou nouvel essai d'une spec déjà en échec, `ACTION: escalate` sans rien lancer après deux échecs de la même spec ; `xhigh`/`max` seulement via `REASONING`) et si une revue `--risk high` est due ; termine par la ligne `NEXT` avec la commande à lancer ; aucun appel de modèle |
| `lane auto --spec f` | Route, lance la lane, puis passe le gate d'intégration ; s'arrête au premier point qui demande le lead. Une spec à risque (champ RISK ou chemin à risque) passe d'abord en concours : la lane ne part que sur un GO du juge sans point laissé à l'opérateur |
| `lane batch --mission f`, `orch lane batch --mission f` | Exécute un graphe (DAG) de specs. Chaque nœud est une lane normale (`laneRun` + gate). Coût estimé réservé avant le départ (info seulement) ; `ORCH_PAUSE` relu entre les nœuds ; arrêt au premier blocage. Concurrence bornée (défaut 3). Code non nul si un nœud est bloqué |
| `orch bus list\|send\|ack\|status\|draft\|notice\|test\|key` | Bus entre projets voisins déclarés dans `orch.yaml` : messages JSON signés (HMAC, clé locale `~/.orch/bus-keys/`, `orch bus key init\|export\|import`), jamais un ordre ; le destinataire en fait une spec dans SON dépôt |
| `lane integrate <id>` | Gate : VERIFY vert, fichiers touchés tous dans FILES, dernière revue enregistrée `ship` si la spec est risquée, branche de feature ; applique sans commit puis nettoie la lane, sinon refuse avec la raison (journalisée) |
| `lane review --lane <id>` | Revue de la branche d'une lane dans un checkout jetable ; le verdict (`ship`, `fix-first`, `rethink`) est journalisé pour le gate |
| `lane contest --file q.md`, `lane contest --spec s` | La même question à Codex, Grok et Claude en parallèle (lecture seule, aucun ne voit les autres), puis un juge sur un autre modèle (Fable, `contest.judge` du profil) compare les réponses anonymisées : consensus, contradictions (qui a raison et pourquoi, ou à trancher par l'opérateur), décision. `--spec` : la spec doit-elle être faite telle quelle, verdict GO ou CHANGE. `--to codex,grok` choisit les candidats, `--model` et `--effort` épinglent le juge ; code 3 sans décision. Les revues vont au reviewer de l'autre famille, selon le harness du lead ; Fable relit seulement à la demande (`lane review --to claude --model fable`) |
| `--model m`, `--effort e` | Sur `run`, `auto`, `review` et `ask` : épinglent le modèle et l'effort pour cet appel, sans toucher au profil |
| `lane review --base <ref> --goal "..."` | Revue croisée lecture seule (sur risque) |
| `lane status`, `lane gc` | Liste aussi les lanes en cours et les lanes orphelines (dossier sans `state.json`) ; supprime les branches intégrées ou vides, les orphelines sans worktree. Une orpheline avec worktree reste jusqu'à `lane gc --drop <id>`. `--drop <id> --superseded` écarte une version perdante d'un A/B ou d'un nouvel essai : le routage l'ignore au lieu de la compter en échec |
| `lane stats` | Résume les runs, intégrations, échecs, tokens, durées et refus du gate par harness |
| `orch install [--dry-run] [--no-system-deps] [--enable]`, `orch diff`, `orch uninstall` | Installe ou retire les fichiers du lead et les unités systemd utilisateur, avec manifeste ; `--enable` active les timers des routines et du ménage des logs, jamais la présence Kiba (opt-in), `uninstall` les arrête et les désactive d'abord ; installe aussi `bubblewrap` et `socat` si absents (sandbox du worker Claude) |
| `orch doctor` | Dit si un harness de lead et chaque worker (codex, grok, claude) peuvent tourner ici, et ce qui manque |
| `orch bench run memory-contract [--ref <commit>]` | Banc gratuit des contrats de mémoire sur une révision ou le code courant ; résultats conservés par run |
| `orch bench baseline set <suite> <run> [nom]`, `compare <avant> <après>`, `history <suite>` | Références nommées, comparaison par cas et historique ; [protocole](docs/benchmark.md) |
| `orch mem add\|search\|recent\|review\|show` | Mémoire du lead, rappel à la demande ; `review` liste les notes proches. Notes Markdown par défaut, ou base `projets` du cerveau avec `mem: brain` dans `catalog/brain.yaml` (mêmes commandes, mêmes identifiants, rappel texte + vecteurs) |
| `orch improve digest\|run\|show` | Amélioration continue : `digest` relève sans modèle les dernières 24 h (routines en échec, lanes, et dans chaque session interactive les messages de l'opérateur et les erreurs d'outils) ; `run` (routine `improve`, une fois par jour) en tire au plus 3 propositions par un Claude en lecture seule et les envoie au téléphone ; `show` les affiche. Rien n'est appliqué sans « valide N » de l'opérateur |
| `orch docs update\|status\|search` | Corpus local de docs officielles, indexé par `ctx`, consulté à la demande; `status` affiche la taille de chaque source et le total sur disque |
| `orch llm status\|use embed\|decide <provider> [--force]\|test embed\|decide <texte>` | Fournisseurs du cerveau mémoire (`catalog/llm.yaml`, clés dans `.env`) : embeddings (OpenAI, local plus tard) et modèle de décision (Claude, Qwen local plus tard), commutables ; un changement d'espace d'embedding exige `--force` et un ré-embedding. `test` appelle le modèle (payant) |
| `orch brain init\|up\|provision\|status` | Cerveau mémoire Postgres + pgvector (`catalog/brain.yaml`, `infra/compose.yml`) : `init` génère dans `.env` les mots de passe manquants, `up` démarre `brain-postgres` sur `127.0.0.1:5433`, `provision` crée une base et deux rôles par domaine (`ro` lit, `rw` insère et met à jour, personne ne supprime) puis applique les migrations |
| `orch brain import-notes\|embed\|search <requête> [--domain d] [--text]\|eval` | Importe les notes `orch mem` (rejouable), calcule les vecteurs manquants (appelle le fournisseur d'embedding, payant), recherche par le sens (vecteurs seuls) ; `compta` n'est cherchée que si on la nomme ; `--text` cherche les mots, sans appel de modèle ; `eval` rejoue les cas `recall` de `catalog/brain.yaml` sur la base réelle (payant) |
| `orch presence status\|notify` | Notification channels (`catalog/presence.yaml` `notify:`); the persistent presence lead is retired and `start\|stop\|ensure\|run` say that orch serve (`orch-serve.service`, opt-in) replaced it |
| `orch kill [--all\|<lane>]` | Tue les process groups des workers (`workerPgid` dans `state.json`) et écrit `<state>/PAUSE`, que orch serve respecte. `--all` (défaut) ou un id de lane |
| `orch resume` | Efface `<state>/PAUSE`. `ORCH_PAUSE` dans l'environnement reste à l'opérateur |
| `orch dash [--port 7894] [--host 127.0.0.1]` | Tableau web en lecture seule des leads actifs (Kiba) : API JSON/SSE + SPA (`ui/`). Défaut `127.0.0.1:7894`. Voir [Tableau Kiba](#tableau-kiba-orch-dash) |
| `make dash`, `bun run dash` | Construit la SPA puis lance `orch dash` |
| `make dev` | Vite + HMR sur `http://127.0.0.1:7894`, API `orch dash` proxifiée depuis `:7895`. `HOST=0.0.0.0` pour écouter partout. Ctrl-C arrête les deux |
| `orch routine list\|tick\|run <id>\|status\|journal` | Routines (`catalog/routines.yaml`) pour un PC qui n'est pas allumé en permanence : pas d'heure fixe, chaque routine a un intervalle (`every`) et tourne dès qu'elle est due, à la tick qui suit le démarrage puis toutes les 15 min (`orch-routines.timer`) ; une à la fois sous verrou, délai maximal par commande, journal JSONL ; alerte au premier échec, rappel au plus quotidien, message au rétablissement |
| `sudo infra/host/harden.sh check\|apply\|rollback` | Durcit l'hôte pour `orch ops check` : SSH par clé seule, root refusé, `ufw` avec SSH ouvert au réseau local seulement ; refuse s'il risque de te verrouiller dehors ; voir `docs/host-hardening.md` |
| `orch ops check\|usage [--days n]` | Contrôles du socle en lecture seule (SSH par clé, root refusé, pare-feu, exposition, cerveau sur localhost, sauvegardes fraîches et restaurées, routines, `.env` privé) ; tokens Claude Code par jour et par modèle |
| `orch brain backup\|restore-check` | Dump chiffré par domaine (AES-256, passphrase du `.env`) ; une sauvegarde ne compte qu'une fois restaurée dans une base temporaire avec le même nombre de souvenirs et les 5 requêtes de contrôle |
| `make check` | Typecheck, tests, matrice d'équivalence niveaux 0 à 2 |
| `make smoke` | Lanes réelles vers codex, grok et claude : tâche complète + sondes de confinement (écriture `$HOME`, réseau, lane imbriquée). Payant (~450k tokens, surtout en cache) : à lancer après tout changement de la façon dont les workers démarrent |

Une lane terminée est coupée aussitôt : son worktree propre est retiré, seule
sa branche reste jusqu'à l'intégration. Un worktree sale (commit refusé) reste
pour `lane gc`. Le worker conserve son environnement filtré, ses sandboxes et
son timeout headless.

## Tableau Kiba (`orch dash`)

Vue en lecture seule des leads actifs (Kiba), par projet, servie en HTTP sur
le serveur où orch tourne (kev). Aucune action en v1 : pas de start/stop, pas
d'envoi sur le bus.

```bash
make dash
# ou
bun run dash
# équivalent : bun run --cwd ui build && bun src/orch.ts dash --port 7894 --host 127.0.0.1

make dev
# Vite + HMR : http://127.0.0.1:7894 ; /api/* proxifié vers orch dash :7895
# HOST=0.0.0.0 make dev   # écoute sur toutes les interfaces
# DEV_PORT=7894 DASH_API_PORT=7895 make dev
```

Ouvre `http://127.0.0.1:7894`. `--host` (ou `HOST` pour `make dev`) pour
écouter ailleurs ; le défaut reste localhost. `--fixture tests/fixtures/dash/snapshot.json`
sert un instantané figé (démo, captures). `make dev` relance la SPA à
chaque édition ; Ctrl-C coupe Vite et l'API.

Données reprises des sources déjà utilisées par `orch top`, `orch presence`,
l'état des lanes, le journal de dépense et le bus : pid, harness, modèle,
effort, mode d'approbation, démarrage / uptime, Remote Control (booléen),
cwd, lanes (statut, modèle, coût), bus (comptes, voisins), coût estimé du jour,
capacité lanes. Jamais de secrets, de clés, de prompts ni de
contenu de fichiers. Mise à jour toutes les ~2 s (SSE, repli polling).

Routes : `/` aperçu, `/runs` file des lanes, `/runs/:id` trace, `/approvals`,
`/agents`, `/tools`, `/providers`, `/spend`, `/activity`, `/skills`,
`/atelier` (casier 3D, plan 2D si `prefers-reduced-motion` ou machine faible).

## Fichiers installés (`orch install`)

`~/.claude/agents/kiba.md`, `~/.claude/agents/lead-explore.md`,
`~/.claude/orch/lead-settings.json`,
`~/.grok/sandbox.toml` (profil des workers Grok), `~/.local/bin/lane`,
`~/.local/bin/lead`, `~/.local/bin/kiba`, `~/.local/bin/orch`. Une
réinstallation retire l'ancien `~/.codex/rules/orch.rules` s'il est dans le
manifest, and the retired lead files (Grok lead agent and hooks, the presence
unit `orch-kiba.service`) when unedited; `orch doctor` warns about any left.

Paquets système (Linux) : `bubblewrap` et `socat`, requis par le sandbox OS
du worker Claude, qui refuse de démarrer sans. `orch install` les installe via
`sudo apt-get` en terminal interactif, sinon affiche la commande ;
`--no-system-deps` saute cette étape.

Ubuntu 24.04 et suivants : AppArmor empêche le sandbox de Claude d'imbriquer
un user namespace dans bwrap (`orch doctor` le teste). Le script
`scripts/claude-sandbox-apparmor.sh --install` remplace le profil Ubuntu
`bwrap-userns-restrict` par celui de la doc Claude Code (bwrap non confiné,
autorisé à créer des user namespaces) ; `--uninstall` restaure le profil
Ubuntu, `--status` affiche l'état. Coût : tout process local peut obtenir un
user namespace via bwrap, comme avant Ubuntu 24.04.

## Docs (`orch docs`)

`catalog/docs.yaml` déclare une source par stack (clone git sparse ou
`llms.txt`), rangée sous `~/.local/share/orch/docs/<id>` et indexée par
`ctx`. Kiba cherche avec `orch docs search <mots> [--stack s]` : sortie
bornée, fichiers cités. Les mots sont les termes de l'API, en anglais : la
question telle qu'on la pose en français trouve rarement la page
(`bun scripts/docs-eval.ts`, éval gratuite sur 40 questions). `orch docs update` rafraîchit (à la main ou en
cron). Sans source canonique pour l'instant : pratiques DevOps, SecOps hors
OWASP, MLOps. Ajoute une entrée au manifeste quand tu as une référence.

## Mémoire (`orch mem`)

Trois portées, une note Markdown par décision, avec provenance (harness,
session, date) :

| Portée | Emplacement | Qui écrit | Qui lit |
|---|---|---|---|
| `project` (défaut) | `~/.orch/<projet>/mem/` | toute session | toute session |
| `operator` | `~/.local/state/orch/mem/operator/` | toute session | toute session |
| `lead` | `~/.local/state/orch/mem/lead/` | sessions `lead` seulement | sessions `lead` seulement |

Tout ce qu'orch garde d'un dépôt vit hors du dépôt, dans
`~/.orch/<projet>/` (`<projet>` : nom du dossier du worktree principal) :
`mem/`, `specs/`, `lane-setup`. `orch dir` affiche ce dossier. Un ancien
`<repo>/.orch/` n'est plus lu : `orch migrate [--dry-run]` le déplace,
fichier par fichier, sans écraser un fichier différent. Tant qu'il reste,
`kiba` le signale au lancement, `orch mem` aussi, et `orch doctor` échoue.

Les workers de `lane` ne peuvent pas écrire (`ORCH_LANE=1`). Rien n'est
injecté au lancement : le lead cherche (`search`, `recent`) quand il en a
besoin, ce qui garde son prompt en cache.

`orch mem review` liste après coup les paires de notes actives proches
(similarité lexicale, sans modèle) ; le lead oublie la note périmée ou laisse
deux faits différents. Rien n'est fusionné ni supprimé automatiquement. Un
contrôle bloquant à l'écriture a été mesuré le 2026-10-21 (A/B réel, 3
harness) : aucun doublon évité, 11 à 74 % de tokens en plus par session
d'écriture ; il a été retiré. Le corpus étiqueté de `tests/fixtures/mem-dedup/`
en fixe le rappel dans `make check` ; les bancs de mesure sont archivés dans la
branche `archive/benches`.
