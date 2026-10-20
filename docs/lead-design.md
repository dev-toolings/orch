# Lead dev : design v2 (à valider)

> **Révision du 2026-10-19 : KonohaOS retiré.** KonohaOS est fermé pour une
> refonte ; ce dépôt n'en dépend plus. `lead` lance le harness directement
> (`--agent lead` pour Claude et Grok, `developer_instructions` pour Codex).
> Le lead n'a plus de mémoire persistante : les décisions durables vont dans
> le dépôt. Les sections « Second cerveau », la colonne mémoire de
> l'architecture, les raccourcis `cla`/`cod` et les étapes 4-5 du plan
> ci-dessous sont caducs ; les cas du corpus qui en dépendaient sont passés
> en `gate: memory`.

Remplace la partie « produit » de `design.md`. Le catalogue, les adaptateurs et
le manifeste de `design.md` restent valables ; `orch usage` est retiré
(konohaos collecte déjà les tokens, `docs/token-usage.md` de konohaos).

## Décisions prises

| Sujet | Décision | Source |
|---|---|---|
| Où vit le lead | Ce dépôt. konohaos reste mémoire seule | Ta réponse ; décision konohaos du 2026-10-07 |
| Harness | Claude Code, Codex, Grok Build, même prompt | Ta réponse |
| Délégation | Sur ta demande explicite, comme `~/.claude/CLAUDE.md` (« même réponse qu'avant », lu ainsi) | Ta réponse |
| Second cerveau | Voir ci-dessous | Analyse |

## Second cerveau : ce qu'on retient

Ce que disent les références :

- Powlisher (posts X relevés par un worker Grok le 2026-10-16, rapport brut
  dans `.ref/tasks/grok-powlisher.out.json`, recoupés en partie par recherche
  web) : Emilien, agent PM/PO qui ne code pas, lance des sessions Orchestria
  qui lancent à leur tour des spécialistes (deux niveaux). Mémoire, 24 mars :
  « Chaque agent a sa propre mémoire, ses propres sources et ses propres
  liaisons », alimentée par une « gazette interne » commune ; 22 mai :
  « Emilien partage notre système de mémoire persistante avec Juliette ».
  Hublot est son interface maison : un seul orchestrateur visible, une vue
  en direct de chaque sous-agent. Emilien tourne 24/7 sur Mac mini (Orca côté
  serveur pour les sous-agents), une copie locale sur le MacBook.
- Hermes Agent : une mémoire isolée par profil d'agent, avec l'avertissement
  de ne pas faire partager un même home à deux agents. Critique publiée : le
  savoir reste piégé dans ce profil.
- OpenClaw : mémoire par agent en Markdown, rappel sur ses propres conversations.
- Letta, Hindsight : pools partagés avec « banks » séparées, au prix d'un
  design anti-contamination.

Ton cas : un seul opérateur, un seul lead, des workers jetables. Une mémoire
isolée par agent n'apporte rien ici et coupe le lead de ce que tes autres
sessions apprennent. Décision proposée, sans toucher konohaos :

```text
.----------------------------------------------------------.
|                 Second cerveau du lead                   |
'----+-------------------+--------------------+------------'
     |                   |                    |
     v                   v                    v
.----+---------.   .-----+--------.    .------+--------.
| operator     |   | project:<id> |    | skills lead-* |
| preferences, |   | decisions,   |    | (operator)    |
| methodes,    |   | stack pack,  |    | delegation,   |
| core memory  |   | episodes     |    | revue, lanes  |
'--------------'   '--------------'    '---------------'
   toujours          selon le cwd         versionnes,
   charge            (Powlisher)          annulables
```

- Ce qui distingue le lead : sa doctrine (comment il planifie, délègue,
  vérifie) en skills `lead-*` de portée operator, versionnés dans le catalogue
  konohaos, plus son prompt dans ce dépôt. Pas une portée mémoire à lui.
- Workers : ils lisent la mémoire du projet, ce qu'ils écrivent est capturé
  avec la provenance de leur session ; pas de mémoire propre.
- Langages : pas de liste en dur. Le lead charge le stack pack du projet et
  les skills operator correspondants au démarrage.

## Architecture

```text
             .--------------------------------------.
             | Toi : Claude Desktop, Orca, SSH      |
             '------------------+-------------------'
                                |  cla / cod / grok + lead
                                v
             .------------------+-------------------.
             |      Lead dev (un seul prompt)       |
             '-----+------------+--------------+----'
                   |            |              :
          memoire  |            | sur demande  : sur demande
                   v            v              v
         .---------+----. .-----+--------. .---+-------------.
        (  KonohaOS MCP )| Roles natifs  | | Lanes : codex   |
        ( operator +    )| explorer,     | | exec, grok      |
        ( projet, skills)| worker, revue | | --prompt-file,  |
         '--------------' '--------------' | claude -p, Orca |
                                           '-----------------'
```

| Pièce | Livraison | Vérifié |
|---|---|---|
| Prompt lead | `catalog/lead.yaml`, rendu par harness | - |
| Claude | `~/.claude/agents/lead.md`, `cla --agent lead` | `--agent` : doc officielle |
| Grok | `~/.grok/agents/lead.md`, `grok --agent lead` | `--agent` : `grok --help` |
| Codex | instructions passées par `-c` au lancement, `config.toml` intact | clé exacte à vérifier (étape 3) |
| Raccourcis | `cla`, `cod`, `grok` transmettent `"$@"` : la mémoire reste injectée | à tester |
| Rôles natifs | catalogue + manifeste de `design.md` | formats vérifiés |
| Lanes | agents qui lancent un autre harness dans un worktree via les raccourcis konoha (sessions liées, usage compté), terminal Orca d'abord pour Codex | à écrire |
| Skills `lead-*` | écrits dans konohaos par `konoha_skill_write`, portée operator | outil existant |

## Plan

```text
.-----------------------------------.
| 0. Validation de ce document      |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 1. Squelette Bun/TS + catalogue   |
|    (lead, roles, lanes, profils)  |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 2. Adaptateurs + manifeste,       |
|    install --dry-run, uninstall   |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 3. Verifs reelles en --home tmp : |
|    --agent claude/grok, cle Codex |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 4. Lanes : codex / grok / claude  |
|    via raccourcis konoha + Orca   |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 5. Skills lead-* dans konohaos    |
|    (sur ton feu vert : ecriture)  |
'----------------+------------------'
                 |
                 v
.----------------+------------------.
| 6. Install reel (ton feu vert),   |
|    premiere session lead          |
'-----------------------------------'
```
