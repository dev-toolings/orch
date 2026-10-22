---
id: 20261022T213942Z-routage-autonome-des-lanes-22-10-2026-br
scope: project
harness: claude
session: claude-mvjoayre
date: 2026-10-22T21:39:42.233Z
tags: routage, autonomie, délégation, gate d'intégration, journal des lanes
status: superseded
superseded_by: 20261022T215053Z-routage-autonome-des-lanes-22-10-2026-br
---

Routage autonome des lanes (22-10-2026, branche feat/lane-route) : chaque lane écrit une ligne run et une ligne outcome (integrated, dropped, nochange) dans lanes.jsonl du state dir. 'lane route' choisit sans modèle : 2 fichiers déclarés ou moins = le lead le fait lui-même ; sinon le harness au meilleur historique (lissage de Laplace, min_samples 5 runs clos par stack), à défaut l'ordre du profil codex, claude, grok. 'lane integrate <id>' est le gate : VERIFY vert, tout fichier touché dans FILES, risque (migration, sécurité, API publique) revu avec --reviewed, jamais sur main, master ou origin/HEAD ; il applique sans commit. 'lane auto' enchaîne route, run et gate. Restent toujours soumis à l'opérateur : push, merge sur la branche par défaut, deploy, migrations, runs facturables.
