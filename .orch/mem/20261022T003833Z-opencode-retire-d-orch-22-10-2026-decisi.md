---
id: 20261022T003833Z-opencode-retire-d-orch-22-10-2026-decisi
scope: project
harness: claude
session: claude-mvinesqt
date: 2026-10-22T00:38:33.927Z
tags: 
status: superseded
superseded_by: 20261022T130743Z-opencode-retire-d-orch-22-10-2026-decisi
---

OpenCode retiré d'orch (22-10-2026, décision de l'opérateur) : pas de sandbox (SECURITY.md), v2.0.27 n'a ni OPENCODE_PERMISSION ni OPENCODE_DISABLE_DEFAULT_PLUGINS ni OPENCODE_DISABLE_CLAUDE_CODE (la doc indexée, branche dev, est en avance), et ses plugins se découvrent depuis les dossiers parents et HOME. Isolation par config jugée non fiable par deux reviews gpt-6.1-sol. Piste pour plus tard : relecteur seulement, sous bwrap (HOME factice, copie du dépôt et auth.json en lecture seule, réseau gardé). La doc OpenCode reste indexée dans catalog/docs.yaml.
