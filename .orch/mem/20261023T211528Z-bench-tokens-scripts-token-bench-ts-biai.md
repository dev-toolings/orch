---
id: 20261023T211528Z-bench-tokens-scripts-token-bench-ts-biai
scope: project
harness: claude
session: claude-mvkorm5d
date: 2026-10-23T21:15:28.972Z
tags: benchmark, biais, méthode, mesure, tokens
---

Bench tokens (scripts/token-bench.ts), biais trouvés le 23-10-2026 : 1) un nonce dans le prompt (Run xxxx) est lu par Codex comme une commande ou un nom à chercher, et plus souvent dans le bras hook (17/73 contre 5/73) : désactivé par défaut (BENCH_NONCE=1 pour le remettre), inutile puisque le ratio d'entrée brute ignore le cache ; 2) le nom du bras dans le prompt ou le chemin du worktree pousse le modèle à le chercher : worktrees nommés par hash ; 3) un .ctxignore non suivi dans git status fait inspecter le fichier par Codex : .ctxignore et .ctx/ dans info/exclude. Ratio principal : entrée brute (non caché + écriture + lecture cache), pas le coût pondéré. Toujours comparer à une base fraîche lancée avec le même script.
