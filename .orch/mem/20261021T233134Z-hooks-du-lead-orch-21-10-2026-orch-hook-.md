---
id: 20261021T233134Z-hooks-du-lead-orch-21-10-2026-orch-hook-
scope: project
harness: claude
session: claude-mvinesqt
date: 2026-10-21T23:31:34.919Z
tags: 
---

Hooks du lead orch (21-10-2026) : 'orch hook <event> --harness h', jamais bloquants. pre-bash réécrit un appel de modèle à la main (codex exec, claude -p, grok -p, quel que soit le harnais de la session) en '{ ... } < /dev/null' et conseille 'lane ask' une fois par session ; post-edit avertit une fois par demande au-delà de 2 fichiers / 60 lignes ; stop bloque une fois par lane terminé non intégré de la session (ORCH_SESSION). Claude : --settings ~/.claude/orch/lead-settings.json ; Grok : ~/.grok/hooks/orch-lead.json ; Codex : overrides -c hooks.* (Codex exige permissionDecision allow avec updatedInput, et une validation unique des hooks via /hooks). Test réel Claude OK (stdin /dev/null, PONG, deux conseils reçus, 0,32 USD).
