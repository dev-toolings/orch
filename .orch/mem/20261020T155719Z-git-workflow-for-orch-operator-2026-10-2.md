---
id: 20261020T155719Z-git-workflow-for-orch-operator-2026-10-2
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T15:57:19.057Z
tags: 
status: forgotten
reason: superseded by 20261020T160426Z-git-workflow-for-orch-supersedes-2026102 (written before orch mem supersede existed)
---

Git workflow for orch (operator, 2026-10-20): work on fix/... or feat/... branches, merge them into develop (fast-forward), then squash-merge develop into main, push main and develop, and delete every fix/ and feat/ branch afterwards (git branch -D once merge-base --is-ancestor <branch> develop holds, since main only holds the squash).
