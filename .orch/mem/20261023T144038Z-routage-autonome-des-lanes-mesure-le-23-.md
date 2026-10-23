---
id: 20261023T144038Z-routage-autonome-des-lanes-mesure-le-23-
scope: project
harness: claude
session: claude-mvkorm5d
date: 2026-10-23T14:40:38.992Z
tags: routage, bench, effort, délégation, mesure
supersedes: 20261023T091717Z-routage-autonome-des-lanes-mesure-le-23-
---

Routage autonome des lanes (mesuré le 23-10-2026, DEV-ORCH-2 et 3, bench refait l'après-midi) : lanes.jsonl journalise run, outcome (integrated, dropped, nochange, superseded), gate et review ; 'lane stats' le résume par harness. 'lane route' choisit sans modèle le worker et l'effort : 2 fichiers déclarés ou moins = le lead ; coût par lane intégrée entre harness fiables (10 runs mesurés, Wilson 90 % >= 0,7), sinon taux d'intégration (5 runs couvrant toutes les stacks), sinon l'ordre codex, claude, grok. Effort : REASONING prioritaire ; risque ou nouvel essai d'une spec en échec = high minimum ; 'MECHANICAL: yes' sans risque, 1 stack de code, 4 fichiers max = medium, coupé automatiquement si medium échoue sur 25 % ou plus de 10 runs MECHANICAL. A/B du matin (3 tâches codex luna) : medium -25 % de tokens, -52 % de temps, 1 échec sur 3. Bench de l'après-midi (mêmes 3 specs sur un clone figé à a28b472, 12 lanes, tests livrés rejoués comme référence) : codex luna medium 3/3, ~28k tokens, ~42 s ; codex xhigh 2/3 (lecture littérale d'un format ambigu), ~48k, ~102 s ; claude sonnet high 3/3, ~42 s, ~4k tokens de sortie ; grok 4.7 build-fast high 3/3, ~160 s, ~600k tokens dont 20k de sortie. Donc medium est le bon défaut des specs MECHANICAL, xhigh n'apporte rien. Les lanes de bench sont fermées en superseded (neutres pour le routage). Plancher d'un appel codex à vide : 7 à 18k tokens. Le gate exige VERIFY vert, fichiers dans FILES, une revue enregistrée 'ship' si risque (lane review --lane <id>), jamais main, master ou origin/HEAD.
