# orch : analyse, design et plan (livrable 1, à valider)

Statut : proposition. Aucun code écrit, aucune installation réelle.

Révision du 2026-10-19 : KonohaOS est retiré (voir `lead-design.md`). Les
mentions de konohaos et de ses raccourcis ci-dessous sont historiques.

Référence lue : `donvito/codex-astra-luna-orchestrator` @ `f5efba0` (2 oct. 2026),
clonée en lecture dans `.ref/donvito/` (à ignorer dans git).

## 1. Analyse de donvito

Ce que le dépôt contient vraiment :

- 6 profils copiés à la main (`profiles/<p>/codex/config.toml`,
  `codex/agents/{explorer,worker,tester,reviewer,researcher}.toml`,
  `agents/skills/astra-orchestrator/SKILL.md`). Le `diff -r` entre profils ne
  montre que trois axes : modèle, effort, `max_concurrent_threads_per_session`
  (4 ou 2). Le reste est dupliqué.
- `setup.sh` / `setup.ps1` : interactif, copie `.codex/`, `.agents/` et ajoute
  `AGENTS.md` en fin de fichier. Garde-fous corrects (refus des liens
  symboliques, conflits de type, confirmation avant écrasement) mais aucune
  trace de ce qui a été écrit, donc aucune désinstallation possible.
- Le skill `astra-orchestrator` impose la délégation : « The task MUST be
  delegated when at least one of the following is true », « the root MUST
  call `spawn_agent` before performing the delegated work itself ».
- `scripts/token_usage.py` : regroupe les rollouts Codex par `session_id`,
  attribue un rôle par thread, somme les `token_usage_record` (repli sur le
  `token_count` cumulé), exclut les threads guardian, affiche les deltas de
  rate limit 5 h / 7 j et le taux de cache.

| Élément | Décision | Pourquoi |
|---|---|---|
| Découpage explorer / worker / tester / reviewer / researcher | Garder | Rôles bornés, bons prompts de départ |
| Contrat de délégation (objectif, périmètre, contraintes, livrable, critères) | Garder, dans les prompts de rôle | Utile quand la délégation est demandée |
| Règles « un seul écrivain par fichier », escalade vers le lead | Garder | Cohérent avec ton budget de sous-agents |
| Format de retour des workers (conclusions, fichiers, commandes, risques) | Garder | Garde le contexte du lead propre |
| Logique de `token_usage.py` | Porter en TS, étendre à Claude (et Grok) | Elle est juste et testée |
| Gate « MUST call spawn_agent » | Écarter | Contraire à ta règle : délégation sur demande explicite |
| 6 dossiers de profils dupliqués | Écarter, générer | Seuls 3 axes varient |
| Installeur interactif | Écarter | Il faut des flags scriptables et `--dry-run` |
| Ajout dans `AGENTS.md` | Écarter | Modifie un fichier qui ne nous appartient pas, non réversible proprement |
| Écraser / fusionner `config.toml` | Écarter en v1 | Fichier partagé (MCP, projets de confiance) ; voir question Q2 |
| `sandbox_mode = "read-only"` par agent | Écarter | La doc Codex dit que `sandbox_mode`, `approval_policy` et `mcp_servers` dans un fichier d'agent n'écrasent pas la session parente : l'explorer de donvito n'est pas réellement en lecture seule |
| Python stdlib | Écarter | Bun + TS demandé |
| Codex seulement | Étendre | Claude, Codex, Grok |

## 2. Formats natifs vérifiés

Versions locales : Claude Code 2.1.301, codex-cli 0.162.1, grok 1.0.52.

### Claude Code (doc officielle `code.claude.com/docs/en/sub-agents`)

- Emplacements : `~/.claude/agents/` (global), `.claude/agents/` (projet),
  scan récursif, identité = champ `name` (pas le nom de fichier).
- Frontmatter : `name`, `description` (requis) ; `tools`, `disallowedTools`,
  `model` (`sonnet|opus|haiku|fable|<id>|inherit`), `permissionMode`,
  `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`,
  `background`, `omitClaudeMd`, `effort` (`low|medium|high|xhigh|max`),
  `isolation: worktree`, `color`, `initialPrompt`, `experimental.cacheTtl`.
- Le lead n'est pas un fichier d'agent : c'est le modèle de la session.

### Codex (doc officielle `developers.openai.com/codex/subagents`)

- Emplacements : `~/.codex/agents/*.toml`, `.codex/agents/*.toml` (projet
  de confiance seulement). Identité = `name`.
- Requis : `name`, `description`, `developer_instructions`. Optionnels :
  `model`, `model_reasoning_effort`, `model_reasoning_summary`,
  `model_verbosity`, `features.<x> = false` (`shell_tool`, `apps`, `plugins`,
  `memories`, `request_permissions_tool`), `[[skills.config]]`.
- Ignorés dans un fichier d'agent : `sandbox_mode`, `approval_policy`,
  `model_provider`, `mcp_servers`, service tier.
- Un agent nommé `explorer` ou `worker` remplace le built-in du même nom.
- Ton `~/.codex/config.toml` : `model = "gpt-6-astra"`, effort `medium`,
  `[agents] default_subagent_model = "gpt-5.6-luna"`, effort `xhigh`,
  `max_concurrent_threads_per_session = 5`, `max_depth = 1`.
  `~/.codex/agents/` est vide.

### Grok Build (doc embarquée `~/.grok/docs/user-guide/16-subagents.md` + `grok inspect`)

- Agents : fichiers `.md` à frontmatter YAML dans `~/.grok/agents/` ou
  `.grok/agents/`. Champs attestés : `name`, `description`, `tools`,
  `disallowedTools`, `mcpServers`, `mcpInheritance`, `hooks`,
  `permissionMode`, `model`. Ils apparaissent dans l'enum `subagent_type`
  de `spawn_subagent`.
- Autres mécanismes : roles (`.grok/roles/*.toml` : `description`,
  `default_capability_mode`, `model`, `prompt_file`) et personas
  (`instructions`, `reasoning_effort`, `default_isolation`...). Un persona
  n'est pas choisi au spawn, il s'applique par résolution : pas adapté à un
  catalogue de rôles choisis par le lead.
- Non attesté : un champ `effort` dans le frontmatter d'agent, et un
  répertoire `~/.grok/roles/` au niveau utilisateur. v1 n'écrit donc pas
  d'effort côté Grok.
- Compatibilité Claude : `grok inspect` liste `project-auditor` (de
  `~/.claude/agents/`, sans `model`) comme agent `user`, mais pas
  `proxmox-ops` (qui a `model: opus`). Déduction, non prouvée : Grok importe
  les agents Claude et écarte ceux dont le modèle lui est inconnu.
  Conséquence de design : l'adaptateur Claude écrit toujours un `model`
  (évite les doublons dans Grok) et l'adaptateur Grok écrit ses propres
  fichiers sans `model` (les workers héritent de grok-4.6). À vérifier par
  `grok inspect` sur un `--home` jetable à l'étape 4.

## 3. Design

### Arborescence

```text
konoha-personal/            (nom du depot : Q1)
+-- package.json  bun.lock  tsconfig.json  Makefile  README.md
+-- AGENTS.md               (CLAUDE.md -> AGENTS.md)
+-- catalog/
|   +-- roles/              explorer.yaml worker.yaml tester.yaml
|   |                       reviewer.yaml researcher.yaml
|   +-- profiles/           max20.yaml lean.yaml
+-- src/
|   +-- cli.ts              parseArgs natif de Bun, sous-commandes
|   +-- catalog/            schema.ts (validation) load.ts
|   +-- resolve.ts          role + profil + harness -> ResolvedRole
|   +-- adapters/           claude.ts codex.ts grok.ts (rendu pur, sans IO)
|   +-- install/            paths.ts plan.ts apply.ts manifest.ts
|   +-- usage/              claude.ts codex.ts grok.ts report.ts
+-- tests/
|   +-- fixtures/           jsonl Claude, rollouts Codex, usage.json Grok
|   +-- *.test.ts           bun test (backend uniquement)
+-- docs/design.md
```

Dépendances : `yaml`, `smol-toml`. Pas de framework CLI.

### Schéma du catalogue

`catalog/roles/<name>.yaml` :

```yaml
name: explorer                 # identité native, [a-z0-9-]
description: >                 # lu par le lead pour choisir le rôle
  Read-only repository explorer. Use only when the user asked to delegate.
tier: scout                    # lead | worker | scout
effort: high                   # optionnel, sinon effort du tier dans le profil
access: read-only              # read-only | edit | execute | all
tools:                         # optionnel, surcharge par harness
  claude: [Read, Grep, Glob, Bash]
harnesses: [claude, codex, grok]   # défaut : les trois
prompt: |
  You are a leaf worker. Never spawn subagents.
  ...
```

`access` est traduit par harness : `tools`/`disallowedTools` pour Claude et
Grok ; pour Codex, seulement `features.*` et le prompt (pas de sandbox par
agent, signalé dans la sortie de `install`).

`catalog/profiles/<name>.yaml` (axes de quota) :

```yaml
name: max20
models:                        # tier -> modèle, par harness
  claude: { lead: opus, worker: sonnet, scout: haiku }
  codex:  { lead: gpt-6-astra, worker: gpt-5.6-luna, scout: gpt-5.6-luna }
  grok:   {}                   # vide = hériter, jamais de modèle écrit
effort:                        # tier -> effort, par harness
  claude: { worker: high, scout: medium }
  codex:  { lead: medium, worker: xhigh, scout: xhigh }
limits: { max_concurrent: 5, max_depth: 1 }   # vérifiés, pas écrits (Q2)
roles: [explorer, worker, tester, reviewer, researcher]
```

Axes de profil : modèle par tier, effort par tier, rôles actifs, limites de
concurrence et de profondeur. Résolution de l'effort : `role.effort` puis
`profile.effort[harness][tier]` puis rien (le harness décide).

### Manifeste

Un fichier par couple harness + scope, hors des dossiers scannés par les
harness :

- global : `~/.local/state/orch/manifests/<harness>-global.json`
- projet : `<projet>/.orch/manifest-<harness>.json`

```json
{
  "schema": 1,
  "orch": "0.1.0",
  "harness": "claude",
  "scope": "global",
  "root": "/home/kev/.claude",
  "profile": "max20",
  "catalog_sha256": "…",
  "installed_at": "2026-10-15T20:00:00Z",
  "created_dirs": [],
  "files": [
    { "path": "agents/orch-explorer.md", "role": "explorer",
      "sha256": "…", "bytes": 1234 }
  ]
}
```

Règles :

- `install` refuse d'écraser un fichier absent du manifeste, ou un agent
  existant de même `name` (collision détectée en lisant le dossier).
- Fichiers nommés `orch-<role>.<ext>` à plat (Codex et Grok ne documentent
  pas le scan récursif). L'identité reste `name: <role>`.
- Écriture atomique (fichier temporaire puis `rename`), manifeste écrit en
  dernier.
- `uninstall` supprime un fichier seulement si son hash courant égale celui
  du manifeste ; sinon il le signale et le garde (sauf `--force`). Il ne
  supprime que les dossiers de `created_dirs` restés vides.
- `--home <dir>` (et `ORCH_HOME`) remplace `~` : tests et dry-runs ne
  touchent jamais le vrai home.

### Commandes

```text
orch list [--profile p]                       roles et modeles resolus
orch install --harness claude|codex|grok --profile p
             --scope global|project [--dry-run] [--home dir]
orch diff    --harness h --scope s            disque vs manifeste (derive)
                                              et manifeste vs catalogue (a jour ?)
orch uninstall --harness h --scope s [--dry-run] [--force]
orch doctor  --harness h --profile p          compare config native du lead et
                                              limites au profil, n ecrit rien
orch usage   [--harness claude|codex|grok|all] [--since 7d] [--session id]
             [--by role|session|model] [--format table|json]
```

`--dry-run` affiche le plan (créer / mettre à jour / refuser) et le diff
unifié de chaque fichier. Il n'écrit ni fichier ni manifeste.

### `orch usage`

- Claude : `~/.claude/projects/<cwd>/<session>.jsonl` (lead) et
  `<session>/subagents/agent-*.jsonl` + `agent-*.meta.json` (rôle =
  `agentType`, modèle, `spawnDepth`). Tokens dans `message.usage` :
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens` (dont `output_tokens_details.thinking_tokens`). Piège
  vérifié : un même `message.id` revient sur plusieurs lignes (13 sur 14 dans
  la session courante), il faut dédupliquer par `message.id`.
- Codex : portage de `token_usage.py`. Rôle = `agent_role`, sinon dernier
  segment de `agent_path` (vu : `agent_role: null`,
  `agent_path: /root/dns_unknown_reviewer`), sinon `nickname`.
- Grok (bonus) : `~/.grok/sessions/<cwd>/<id>/usage.json` donne tokens par
  modèle et `costUsdTicks`. Attribution par rôle à étudier (sessions de
  sous-agents sous `worktrees/.../subagent-*`) : v2.
- Pas de prix en dollars pour Claude et Codex (abonnements) : tokens, taux de
  cache, deltas de rate limit quand le harness les fournit.

### Délégation opt-in

- Aucun skill orchestrateur, aucune consigne dans `CLAUDE.md` / `AGENTS.md`.
- Chaque `description` commence par l'usage et précise « Use only when the
  user explicitly asks to delegate » : Claude délègue d'après la
  description, c'est le seul levier sans toucher aux instructions globales.
- Chaque prompt de rôle se déclare feuille : ne jamais lancer de sous-agent.

## 4. Plan par étapes

```text
.------------------------------------.
|  0. Validation de ce document (toi) |
'-----------------+------------------'
                  |
                  v
.-----------------+------------------.
| 1. Squelette : git init, Bun, TS,  |
|    Makefile, AGENTS.md, .gitignore |
'-----------------+------------------'
                  |
                  v
.-----------------+------------------.
| 2. Catalogue : schema, chargement, |
|    5 roles + 2 profils, resolve.ts |
'-----------------+------------------'
                  |
     +------------+-------------+
     |                          |
     v                          v
.----+-----------------.  .-----+----------------.
| 3. Adaptateurs purs  |  | 5. orch usage        |
|  claude, codex, grok |  |  claude + codex      |
|  tests de rendu      |  |  (grok total seul)   |
'----+-----------------'  |  tests sur fixtures  |
     |                    '-----+----------------'
     v                          |
.----+-----------------.        |
| 4. Manifeste, plan,  |        |
|  install --dry-run,  |        |
|  diff, uninstall,    |        |
|  tests en --home tmp |        |
'----+-----------------'        |
     |                          |
     +------------+-------------+
                  |
                  v
.-----------------+------------------.
| 6. doctor, README, dry-run reels   |
|    sur ~/.claude ~/.codex ~/.grok  |
'-----------------+------------------'
                  |
                  v
.-----------------+------------------.
| 7. Feu vert ? install reel, puis   |
|    grok inspect / /agents verifies |
'------------------------------------'
```

Les étapes 3 et 5 sont indépendantes. Je les fais en séquence moi-même
(pas de délégation sans ta demande). Validation de chaque étape :
`bunx tsc --noEmit` et `bun test`. Pas de `bun build` : le CLI s'exécute
par `bun src/cli.ts` et s'expose via `bin` + `bun link`.

## 5. Problèmes vus en route (signalés, non corrigés)

- La fonction shell `grok` échoue : `grok:1: command not found:
  _konoha_shortcut`. Elle vient de ta configuration shell / konohaos, donc
  d'un autre dépôt : je ne la touche pas. `~/.grok/bin/grok` marche.
- donvito : `sandbox_mode` par agent est sans effet selon la doc Codex
  (dépôt tiers, rien à faire chez nous hormis ne pas reproduire l'erreur).

## Lane Orca channel decision (implemented)

Root cause: lane registered neither its Git worktree nor its worker with
Orca. The same implementation affected development and installed lanes.
Evidence is pinned to [stablyai/orca v1.4.229](https://github.com/stablyai/orca/tree/v1.4.229),
commit `a0cd1644f320f1327f7495650a816111b495f3cd`, matching the installed CLI.

- **Hierarchy:** [CLI parent resolution, src/cli/handlers/worktree.ts:140-175](https://github.com/stablyai/orca/blob/v1.4.229/src/cli/handlers/worktree.ts#L140-L175)
  considers an explicit parent, `ORCA_TERMINAL_HANDLE`, environment workspace
  and cwd. [Runtime resolution:123-163](https://github.com/stablyai/orca/blob/v1.4.229/src/main/runtime/runtime-worktree-lineage-resolution.ts#L123-L163)
  records explicit lineage. Worktree nesting and pane-level agent children
  are separate: [agent row orchestration context:143-154](https://github.com/stablyai/orca/blob/v1.4.229/src/shared/agent-status-types.ts#L143-L154),
  [sidebar agent count:354-358](https://github.com/stablyai/orca/blob/v1.4.229/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L354-L358).
- **Identity/state:** [published-pane-agent-identity.ts:28-62](https://github.com/stablyai/orca/blob/v1.4.229/src/shared/published-pane-agent-identity.ts#L28-L62)
  resolves hook, process, launch and title evidence; `ORCA_*` alone is not
  an agent registration. [agent-headless-command.ts:18-39](https://github.com/stablyai/orca/blob/v1.4.229/src/shared/agent-headless-command.ts#L18-L39)
  filters Claude print mode. Calling the tag's recognizer locally returned
  null for `claude -p`, but codex/grok for `codex exec`/`grok --prompt-file`.
  Process recognition alone cannot supply trustworthy task completion.
  [OSC 9999 parser:5-63](https://github.com/stablyai/orca/blob/v1.4.229/src/shared/agent-status-osc.ts#L5-L63)
  and [PTY status attribution:89-176](https://github.com/stablyai/orca/blob/v1.4.229/src/main/runtime/terminal/output/terminal-derived-agent-facts.ts#L89-L176)
  accept explicit state and attribute it to the pane/worktree, without a TUI.
- **Runs/relay:** [orchestration docs:23-87](https://github.com/stablyai/orca/blob/v1.4.229/docs/site/content/docs/cli/orchestration.mdx#L23-L87)
  define Run namespaces, worker-start, bounded worker-read, mailbox check,
  dispatch-scoped `send --type worker_done --outcome`, and archive/release.
  [CLI transport:31-107](https://github.com/stablyai/orca/blob/v1.4.229/src/cli/runtime/transport.ts#L31-L107)
  requires a reachable runtime socket. The historical missing relay report
  is consistent with transport failure, not evidence of worker completion.
- **Alternatives/cleanup:** [repo visibility API:23-33](https://github.com/stablyai/orca/blob/v1.4.229/src/cli/specs/repo.ts#L23-L33)
  can show external worktrees, but does not register an agent/status. No
  dedicated public external-agent registration verb was found in CLI help.
  OSC is an implementation protocol, not a promised public API.
  [Setup/default tabs:64-119](https://github.com/stablyai/orca/blob/v1.4.229/src/main/effective-hook-config.ts#L64-L119)
  honor `skip`; [removal:283-296](https://github.com/stablyai/orca/blob/v1.4.229/src/main/runtime/rpc/methods/worktree.ts#L283-L296)
  can acknowledge asynchronous deletion.

| Option | Assessment |
|---|---|
| (a) Orca child + headless worker in PTY | Preserves output formats, but needs an environment reset and a second timeout/process supervisor; Claude identity is not automatic. |
| (b) `worktree create --agent --prompt` | Visible interactive agent, but Orca owns launch/settings; existing confinement flags, JSON usage and bounded completion are not preserved by this API. |
| (c) Run + `worker-start` | Adds durable mail and dispatch lifecycle; still uses Orca launch policy and requires worker completion mail through the relay. |
| (d) Orca child + status-only observer PTY | Chosen: visibility with the unchanged headless worker execution contract. |

Create with explicit caller parent, snapshot SHA and `--setup skip`, then
rename the branch to `lane/<id>`. Close the newly created idle terminals and
start one observer with `env -i` and the existing allowlist. It publishes
`working` while setup/worker/VERIFY run, then `done` plus the bounded report;
failure remains explicit in the report. The real worker still uses
`workerArgv`, `workerEnv`, `runLogged`, `ORCH_LANE=1`, and the original
sandbox, timeout, usage, VERIFY and ACCEPT spec handling.

Auto and explicit `orca` fall back headless when local parent/runtime
discovery fails, including absent CLI/relay; explicit `headless` never calls
Orca. Observer failure also leaves exactly one headless worker. A lost create
reply is reconciled by unique name, or fails closed with a durable cleanup
record. GC never replaces Orca removal with raw Git removal, never drops an
active lane, and retains records on unconfirmed/asynchronous cleanup.

Losses: no interactive worker input, Run mailbox, per-tool state or remote
Orca support. OSC compatibility must be rechecked after Orca upgrades.
The terminal represents lane execution, not a resumable provider session.

Verification: CLI help and worktree list/current/ps probes; one throwaway
child with two terminals, no model. `terminal show` returned
`agentIdentity: claude`; `worktree ps` returned the exact parent and an agent
transition from `working` to `done`, retained after script exit. Both
terminals, worktree and branch were removed. Fake-Orca tests exercise the
protocol, dirty snapshot, environment isolation, fallback, timeout, lost
create reply and GC failures without touching real HOME. `make check` is
the regression gate; billable `make smoke` remains to run separately.
