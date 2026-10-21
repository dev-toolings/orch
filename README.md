# orch

Un lead développeur unique pour Claude Code, Codex et Grok Build, optimisé
en tokens, avec sa propre mémoire en fichiers (`orch mem`). Aucune
dépendance externe. Plan :
`~/.claude/plans/keen-knitting-pudding.md`.

```text
.------------------------------------.
| lead claude|codex|grok             |
| (harness natif + profil lead)      |
'-----------------+------------------'
                  |  petites modifs : le lead les fait
                  |  volume mecanique : spec + lane run
                  v
.-----------------+------------------.
| lane run --to codex|grok|claude    |
| worktree, worker headless, VERIFY, |
| rapport <= 4 Ko                    |
'-----------------+------------------'
                  |
                  v
.-----------------+------------------.
| git merge --squash lane/<id>       |
| puis lane gc                       |
'------------------------------------'
```

## Commandes

| Commande | Effet |
|---|---|
| `lead claude\|codex\|grok` | Ouvre une session lead (harness lancé directement) |
| `lane run --to codex --spec f` | Délègue une tâche ; worktree enfant et état visible dans Orca local si disponible ; rapport borné |
| `lane run --to codex --spec f --channel headless` | Force le canal sans Orca |
| `lane run --to codex --spec f --channel orca` | Demande le canal Orca ; repli headless si Orca ou son relais est indisponible |
| `lane review --base <ref> --goal "..."` | Revue croisée lecture seule (sur risque) |
| `lane status`, `lane gc` | Liste aussi les lanes en cours ; supprime les branches intégrées ou vides et termine les nettoyages Orca restés en attente |
| `orch install [--dry-run] [--no-system-deps]`, `orch diff`, `orch uninstall` | Installe ou retire les fichiers du lead, avec manifeste ; installe aussi `bubblewrap` et `socat` si absents (sandbox du worker Claude) |
| `orch doctor` | Dit si chaque worker (codex, grok, claude) et le lead Codex peuvent tourner ici, et ce qui manque |
| `orch mem add\|search\|recent\|review\|show` | Mémoire du lead : notes Markdown, rappel à la demande ; `review` liste les notes proches |
| `orch docs update\|status\|search` | Corpus local de docs officielles, indexé par `ctx`, consulté à la demande |
| `make check` | Typecheck, tests, matrice d'équivalence niveaux 0 à 2 |
| `make smoke` | Lanes réelles vers codex, grok et claude : tâche complète + sondes de confinement (écriture `$HOME`, réseau, lane imbriquée) + décisions de la règle du lead Codex. Payant (~450k tokens, surtout en cache) : à lancer après tout changement de la façon dont les workers démarrent |
| `scripts/orca-run-teardown.sh --run <id> --into <ref>` | Ferme un Run Orca intégré : worktrees, terminaux, branches fusionnées |

Le terminal Orca observe la lane et affiche `working` ; ce n'est pas une
session interactive du worker. Une lane terminée est coupée aussitôt : son
worktree propre et ses terminaux Orca sont retirés, seule sa branche reste
jusqu'à l'intégration. Un worktree sale (commit refusé) reste pour `lane gc`. Le worker conserve
son environnement filtré, ses sandboxes et son timeout headless. Aucun Run
d'orchestration ni message `worker_done` n'est nécessaire. Une création dont
la réponse est perdue est recherchée par son nom unique ; si son résultat
reste inconnu, la lane s'arrête et conserve son état pour `lane gc --drop <id>`.
GC conserve aussi cet état si Orca ne confirme pas le nettoyage, ou si sa
suppression asynchrone est encore en cours : relancer `lane gc` après sa fin.

## Fichiers installés (`orch install`)

`~/.claude/agents/lead.md`, `~/.grok/agents/lead.md`,
`~/.grok/agents/lead-explore.md`, `~/.local/bin/lane`, `~/.local/bin/lead`,
`~/.local/bin/orch`, `~/.codex/rules/orch.rules`.
Codex ne reçoit pas de fichier d'agent : `lead codex` passe le prompt lead en
`developer_instructions` au lancement. La règle `orch.rules` laisse un lead
Codex lancer `lane` et `orch mem|docs` hors de son sandbox (sinon `.git` et le
dossier personnel y sont en lecture seule, sans réseau), à condition de les
appeler en commande simple.

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
`ctx`. Marius cherche avec `orch docs search <mots> [--stack s]` : sortie
bornée, fichiers cités. `orch docs update` rafraîchit (à la main ou en
cron). Sans source canonique pour l'instant : pratiques DevOps, SecOps hors
OWASP, MLOps. Ajoute une entrée au manifeste quand tu as une référence.

## Mémoire (`orch mem`)

Trois portées, une note Markdown par décision, avec provenance (harness,
session, date) :

| Portée | Emplacement | Qui écrit | Qui lit |
|---|---|---|---|
| `project` (défaut) | `<repo>/.orch/mem/` | toute session | toute session |
| `operator` | `~/.local/state/orch/mem/operator/` | toute session | toute session |
| `lead` | `~/.local/state/orch/mem/lead/` | sessions `lead` seulement | sessions `lead` seulement |

Les workers de `lane` ne peuvent pas écrire (`ORCH_LANE=1`). Rien n'est
injecté au lancement : le lead cherche (`search`, `recent`) quand il en a
besoin, ce qui garde son prompt en cache.

`orch mem review` liste après coup les paires de notes actives proches
(similarité lexicale, sans modèle) ; le lead oublie la note périmée ou laisse
deux faits différents. Rien n'est fusionné ni supprimé automatiquement. Un
contrôle bloquant à l'écriture a été mesuré le 2026-10-21 (A/B réel, 3
harness) : aucun doublon évité, 11 à 74 % de tokens en plus par session
d'écriture ; il a été retiré. `bun scripts/mem-dedup-replay.ts` rejoue la
détection en lecture seule sur les vraies notes ; le corpus étiqueté de
`tests/fixtures/mem-dedup/` en fixe le rappel dans `make check`.
