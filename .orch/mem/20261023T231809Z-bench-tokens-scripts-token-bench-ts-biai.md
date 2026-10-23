---
id: 20261023T231809Z-bench-tokens-scripts-token-bench-ts-biai
scope: project
harness: claude
session: claude-mvkorm5d
date: 2026-10-23T23:18:09.412Z
tags: benchmark, biais, méthode, mesure, isolation
supersedes: 20261023T214846Z-bench-tokens-scripts-token-bench-ts-biai
---

Bench tokens (scripts/token-bench.ts), biais trouvés le 23-10-2026 : 1) un nonce en tête de prompt (Run xxxx) est lu par Codex comme une commande ou un nom à chercher, plus souvent dans le bras hook (17/73 contre 5/73) ; la référence est maintenant en fin de prompt, « (ref xxxx) », et plus aucun run ne la suit (0/150) ; elle reste utile : sans elle, les runs identiques partagent le cache et le coût pondéré n'est plus comparable entre lots (BENCH_NONCE=0 la retire) ; 2) le nom du bras dans le prompt ou le chemin du worktree pousse le modèle à le chercher : worktrees nommés par hash ; 3) un .ctxignore non suivi dans git status fait inspecter le fichier par Codex : .ctxignore et .ctx/ dans info/exclude. Rapporter deux ratios : entrée brute (tokens) et entrée pondérée par le prix du cache (coût) ; ne comparer le coût qu'entre lots lancés avec le même réglage de référence. Codex gpt-6-luna abandonne parfois sans aucun appel d'outil (3 à 4 runs sur 32 dans chaque bras) : ce n'est pas l'effet du bras. 4) depuis 'ctx hook install', ~/.claude/settings.json porte les hooks ctx : hors bras full, Claude tourne avec --setting-sources project,local, et Grok refuse de tourner tant que ~/.grok/hooks/ctx.json existe (désinstaller d'abord). 5) les specs d'édition sont versionnées dans scripts/token-bench-specs (celles de /tmp ont disparu). 6) Une consigne SessionStart 'grouper les appels indépendants' a été rejetée : Claude edit +18% tokens bruts, +22% coût.
