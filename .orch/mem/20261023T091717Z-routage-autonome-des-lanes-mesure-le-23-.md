---
id: 20261023T091717Z-routage-autonome-des-lanes-mesure-le-23-
scope: project
harness: claude
session: claude-mvkorm5d
date: 2026-10-23T09:17:17.640Z
tags: routage, autonomie, délégation, gate d'intégration, journal des lanes
supersedes: 20261022T215053Z-routage-autonome-des-lanes-22-10-2026-br
---

Routage autonome des lanes (mesuré le 23-10-2026, DEV-ORCH-2 et 3) : lanes.jsonl journalise run, outcome (integrated, dropped, nochange, superseded), gate et review ; 'lane stats' le résume par harness. 'lane route' choisit sans modèle le worker et l'effort : 2 fichiers déclarés ou moins = le lead ; coût par lane intégrée entre harness fiables (10 runs mesurés, Wilson 90 % >= 0,7), sinon taux d'intégration (5 runs couvrant toutes les stacks), sinon l'ordre codex, claude, grok. Effort : REASONING prioritaire ; risque ou nouvel essai d'une spec en échec = high minimum ; 'MECHANICAL: yes' sans risque, 1 stack de code, 4 fichiers max = medium, coupé automatiquement si medium échoue sur 25 % ou plus de 10 runs MECHANICAL. Mesure A/B réelle (3 tâches codex luna) : medium -25 % de tokens, -52 % de temps, 1 échec sur 3 (hors périmètre, arrêté par le gate) ; rentable en tokens seulement sous 25 % d'échec. Plancher d'un appel codex à vide : 7 à 18k tokens, sans effet net de l'effort. Le gate exige VERIFY vert, fichiers dans FILES, une revue enregistrée 'ship' si risque (lane review --lane <id>), jamais main, master ou origin/HEAD. Un perdant d'A/B s'écarte avec 'lane gc --drop <id> --superseded'.
