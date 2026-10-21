---
id: 20261021T222411Z-doublons-de-notes-orch-mem-2026-10-21-pa
scope: project
harness: unknown
session: 
date: 2026-10-21T22:24:11.359Z
tags: doublons, déduplication, fusion, nettoyage, mémoire
---

Doublons de notes orch mem (2026-10-21) : pas de contrôle à l'écriture. Un blocage de orch mem add sur note proche a été mesuré en A/B réel (Claude haiku, Codex gpt-6-luna, Grok, 25 questions) : 0 doublon, 0 note périmée, 0 fait perdu dans les deux bras, mais 11 à 74 % de tokens en plus par session d'écriture (campagne ~3,9 USD). Retiré au profit de orch mem review, à la demande et après coup (src/mem/similar.ts, seuil 0,2 : 17 alertes sur 101 ajouts réels, toutes fondées). Limite : une note réécrite dans une autre langue n'est pas détectée.
