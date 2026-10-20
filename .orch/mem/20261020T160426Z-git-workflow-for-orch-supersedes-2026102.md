---
id: 20261020T160426Z-git-workflow-for-orch-supersedes-2026102
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T16:04:26.883Z
tags: 
---

Git workflow for orch, supersedes 20261020T155719Z (operator, 2026-10-20): develop and main must keep the same history. After squash-merging develop into main, reset develop to main (git branch -f develop main, after git diff --quiet main develop) and push it with --force-with-lease; then delete the merged fix/ and feat/ branches.
