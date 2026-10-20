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
| `lane run --to codex --spec f` | Délègue une tâche ; affiche un rapport borné |
| `lane review --base <ref> --goal "..."` | Revue croisée lecture seule (sur risque) |
| `lane status`, `lane gc` | Liste les lanes ; retire celles intégrées ou vides |
| `orch install [--dry-run]`, `orch diff`, `orch uninstall` | Installe ou retire les fichiers du lead, avec manifeste |
| `orch mem add\|search\|recent\|show` | Mémoire du lead : notes Markdown, rappel à la demande |
| `orch docs update\|status\|search` | Corpus local de docs officielles, indexé par `ctx`, consulté à la demande |
| `make check` | Typecheck, tests, matrice d'équivalence niveaux 0 à 2 |
| `scripts/orca-run-teardown.sh --run <id> --into <ref>` | Ferme un Run Orca intégré : worktrees, terminaux, branches fusionnées |

## Fichiers installés (`orch install`)

`~/.claude/agents/lead.md`, `~/.grok/agents/lead.md`,
`~/.grok/agents/lead-explore.md`, `~/.local/bin/lane`, `~/.local/bin/lead`,
`~/.local/bin/orch`.
Codex ne reçoit aucun fichier : `lead codex` passe le prompt lead en
`developer_instructions` au lancement.

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
