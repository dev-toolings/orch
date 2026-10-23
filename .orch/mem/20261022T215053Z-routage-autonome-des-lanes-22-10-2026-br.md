---
id: 20261022T215053Z-routage-autonome-des-lanes-22-10-2026-br
scope: project
harness: claude
session: claude-mvjoayre
date: 2026-10-22T21:50:53.651Z
tags: routage, autonomie, délégation, gate d'intégration, journal des lanes
status: superseded
supersedes: 20261022T213942Z-routage-autonome-des-lanes-22-10-2026-br
superseded_by: 20261023T091717Z-routage-autonome-des-lanes-mesure-le-23-
---

Routage autonome des lanes (22-10-2026, branche feat/lane-route) : lanes.jsonl dans le state dir journalise run, outcome, gate (refus) et review (verdict). 'lane route' choisit sans modèle le worker ET l'effort : 2 fichiers déclarés ou moins = le lead ; coût par lane intégrée seulement entre harness fiables (10 runs clos mesurés, borne de Wilson 90 % >= 0,7), sinon taux d'intégration (5 runs, historique couvrant toutes les stacks), sinon l'ordre du profil codex, claude, grok. Effort : REASONING de la spec prioritaire ; risque ou nouvel essai d'une spec en échec = high minimum ; 'MECHANICAL: yes' sans risque, 1 stack de code, 4 fichiers max = medium. Le gate 'lane integrate' exige VERIFY vert, fichiers dans FILES, une revue enregistrée 'ship' (lane review --lane <id>) si risque, jamais main, master ou origin/HEAD ; --reviewed n'existe plus. --model et --effort épinglent run, auto, review et ask. Restent à l'opérateur : push, merge sur la branche par défaut, deploy, migrations, runs facturables.
