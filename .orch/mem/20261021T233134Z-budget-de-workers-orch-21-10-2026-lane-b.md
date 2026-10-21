---
id: 20261021T233134Z-budget-de-workers-orch-21-10-2026-lane-b
scope: project
harness: claude
session: claude-mvinesqt
date: 2026-10-21T23:31:34.981Z
tags: 
---

Budget de workers orch (21-10-2026) : 'lane budget' = max(1, min(plafond du profil, coeurs/2, (RAM dispo - 4 Gio - verify_concurrent x 1,5 Gio) / 0,5 Gio)), recalculé à chaque réservation ; max20 plafond 8 et 2 VERIFY à la fois, lean plafond 2. Le worker ne lance plus le VERIFY complet, lane le lance seul sous son sémaphore. PEAK RSS mesuré : worker Codex ~360 Mo, VERIFY make check ~100 Mo. subagent-cap.sh lit 'lane budget', plafond dur 8 dans settings.json ; Codex et Grok gardent un cap natif fixe à 5. Explorateur Claude : agent lead-explore en sonnet (haiku en lean).
