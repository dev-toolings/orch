# orch contributor guide

A native developer, Kiba, on Claude Code only (Codex and Grok are lane
workers and reviewers, as is Claude), with its own memory (`orch mem`) and
switchable model providers (`orch llm`). Kiba is the only lead; the
always-on conductor is `orch serve`. See docs/architecture.md.

- `src/` keeps only the three installed entry points (`orch.ts`, `lane.ts`,
  `lead.ts`, symlinked from `~/.local/bin`); everything else lives in one
  folder per context: `core/`, `harness/`, `lanes/`, `install/`, `mem/`,
  `docs/`, `checks/`, `llm/`, `brain/`, `kiba/`.
- `src/kiba/` owns Kiba, the native lead: one `claude --agent kiba` session
  (`native.ts`, `catalog/kiba-native.md`): direct work, memory hooks, optional
  lanes, no MCP server and no PreToolUse hook (its guards are the settings
  deny rules generated from the hook policy). Its default model/effort come
  from the profile's Claude coordinator role (Opus/medium by default);
  explicit policy and CLI choices still win. Settings are passed inline so an
  older installed copy cannot refuse its tools. The conductor is `orch serve`
  (below); the dispatch-only conductor (`kiba --conductor` with the `kiba`
  MCP server, its wakes and presence) is retired, and `orch serve migrate`
  (also run at every `orch serve` start, once, behind a marker in the task
  journal) imported its live state from `<state dir>/kiba/`, left in place
  read-only. `rules.ts` keeps the task kinds, the ladder (two failures, one
  rung up, never above high) and the profile section; `watchdog.ts` watches
  orch serve workers (stall, loop, drift; kills the group, signals the
  engine); `live.ts` reads running lanes for `lane watch` and the dash.
- `src/core/tasks.ts` is the durable task store of `orch serve`, promoted
  from the durable POC store: events persisted before handling and
  deduplicated by key (`receive`: stored, duplicate or filtered), tasks with a
  fixed mandate (repo, FILES, VERIFY, risk, admitting source and sender,
  policy version), thread, native session, lane and delivered branch,
  evidence, state (working, person/answer, person/review, blocked, idle,
  ended) and next action; jobs with pid and start time; the outbox. One JSON
  state under `<state dir>/tasks/`, changed under a kernel lock with atomic
  replacement. An ended task resumes on a new message on its thread with the
  same session and mandate unless a person stopped it.
  `src/serve/` is `orch serve [--once]` (opt-in unit `orch-serve.service`,
  policy `~/.orch/policy/serve.yaml`) and `orch task
  new|list|show|follow|stop`: a deterministic engine (`engine.ts`) admits
  operator and GitHub events (`src/core/github.ts`, filter
  `src/core/inbound.ts`), routes a follow-up on a thread a task owns
  (`src/core/threads.ts`) straight to that task's session with zero router
  calls, and calls the model router (`router.ts`, `catalog/router.md`,
  classify or forward only, counted) only for an ambiguous event that matches
  no task. Workers are runtime A (`workers.ts`, P3): one `claude -p`
  stream-json process per revision, `--agent worker` (`catalog/worker.md`),
  resumed with `--resume` on the task session, in the task's worktree, with
  `ORCH_HEADLESS=1`; a worker cannot publish because its environment holds
  no credential (own HOME with only Claude's credentials linked, minimal git
  config refusing every transport, unusable push URL, empty gh config, no
  forge token); deny rules and `publish-guard.ts` stay as defense in depth.
  Each step is a detached job (`job.ts`) that records its own identity under
  its lock before any paid work; the engine adopts it after a restart or
  marks it interrupted with a recovery note; PAUSE holds launches and job
  entry. A delivery's completion, thread and follow-up effects are one write,
  and threads are re-applied from the journal every pass; the live state is
  bounded (oldest terminal rows archived, compact dedup index). VERIFY
  goes through `orch task adopt` (lane check path), a risky task needs a
  `ship` review of the same commit, the kiba ladder and watchdog apply, and
  PAUSE holds new steps. Only the outbox publishes (delivery through `lane
  integrate --branch --message-file`, PR comments with a marker, notices),
  each effect reconciled with its destination before a retry.
  `migrate.ts` (`orch serve migrate`) turns the retired conductor's running
  intents into tasks (a dead runner recovered with the recovery note, a live
  one deferred), its conductor lanes left in `delivery-pending` into pending
  delivery effects (the PR is found by branch first), unacknowledged results
  and events into notification effects (at most once) and held threads into
  task threads; cancelled intents stay cancelled. `kiba --conductor` prints
  the engine's status (tasks, workers, pending effects) and exits 0.
- `catalog/lead.md` is the shared lead prompt. Keep it
  short, stable (no dates or variables) and in English: it is a cached prefix.
- `src/lane.ts` runs one task headless in a git worktree and prints a bounded
  report; `orch task adopt` brings native work into the same verification, review and delivery gate while preserving its worktree unless `--take-worktree` is passed.
  The worker runs through `src/harness/proc.ts`. It must never call
  a model itself or forward the caller's environment beyond that allowlist. A
  worker's file tools write only its worktree (`src/lanes/guard.ts`; Bash keeps
  its sandbox): a Claude worker's PreToolUse hook denies file tools aimed elsewhere, and a write the
  worker log shows outside fails the lane, which `lane integrate` refuses. Every
  lane worker gets its own TMPDIR (`/tmp/orch-lane-*`, short for the 107-byte
  socket limit), the one extra path a Claude worker's sandbox may write; it
  goes with the lane. A Claude write worker streams `stream-json` events to `worker.log` (the report still
  reads the final `result` event); `src/lanes/progress.ts` keeps a small
  `progress.json` in the lane dir (phase, turns, last tool and file, files
  touched, a 200-character snippet) that the dash reads for running lanes.
  Every way out of a lane (end, error, PAUSE, a stop signal, which `onLaneStop`
  awaits before exit) runs one finalizer: work of a lane cut short is
  committed on its branch, the worktree is cut and the Orca terminal closed
  (its handle is kept in state.json). A lane killed with no record is finalized
  the same way by `reapDeadLanes` (dash, `lane status`, `orch serve
  migrate`). GC drops the branch once
  integrated. Under Orca (ORCA_WORKTREE_ID set), a lane
  shows as a child of the lead's worktree with a status comment and a log-following
  terminal; git creates its worktree in Orca's workspace directory
  (`~/orca/workspaces/<repo>/orch-lanes/<id>`) and `orca worktree rm` removes
  it, the only removal that makes Orca forget the card (git as fallback;
  `lane gc --orca`, routine `orca-prune`, drops leftover records while Orca is
  quit). `src/lanes/orca.ts` lists the allowed calls.
- `src/lanes/ledger.ts` appends one line per finished lane run and per closed
  lane (integrated, dropped, no change) to `lanes.jsonl` under the state dir.
  `src/lanes/route.ts` backs `lane route` and `lane auto`: a fixed rule on
  the spec (FILES, stacks, risk) picks the lead itself (2 files or fewer) or
  the first installed harness of the profile order, with no model call; the
  ledger only tunes the effort. `lane batch --mission` runs a DAG of
  specs; each node is a normal `laneAuto` (same `laneRun` + gate), with an
  informational estimated-cost reserve before the first node, `ORCH_PAUSE`
  between nodes, and a stop at the first blockage. A blocked node exits
  non-zero. `lane integrate` is the
  gate: VERIFY passed, every touched file in FILES, a recorded `ship` review
  for a risky spec (`lane review --lane <id>`), a feature branch (the default
  branch only when the calling lead's live permission mode, kept in its
  pulse by its hooks, is `bypassPermissions` or `auto`, and never for a lane
  whose worker ended `LANE: blocked`); else nothing
  moves and the refusal is logged. `lane integrate <id> --branch <b>
  --message-file <f>` delivers instead: the same gate (minus the caller
  branch checks), then one commit of the verified tree on the lane's base,
  on a new branch (never a shared one, never overwritten), pushed with a PR
  (`gh`) to the branch the lane started from (`baseBranch`); the caller's
  checkout is never touched, so parallel tickets never mix, and merging stays
  the operator's. The orch serve outbox delivers with an explicit branch and
  message. A delivery checkpoints
  its local commit, push and PR separately: `delivery-pending` keeps the lane,
  and repeating the same branch/message resumes without another worker or
  commit. GC runs only after every requested stage succeeds; the ledger keeps
  the delivered commit, push and PR, so a completed delivery is replayable.
  A VERIFY that enters an already running
  container (`docker compose exec`, `docker exec`, `kubectl exec`, also behind
  make targets through `make -n` and package.json or composer.json scripts)
  tests another checkout: `src/lanes/reach.ts` fails it unrun in the lane,
  `lane check`, `orch task adopt` (orch serve's VERIFY) and the gate.
  `$LANE_WORKTREE` or a mount of the worktree
  path marks a deliberate container. A containerized project makes its
  checks lane-aware in its own Makefile (`ifdef LANE_WORKTREE`: `compose run
  --rm` of the worktree instead of `exec`) and provisions the worktree in
  `~/.orch/<project>/lane-setup` (core: vendor/ copy, `.env` from `.env.test`,
  never the real `.env`). Every VERIFY run (lane, `lane check`, base commit)
  has the same budget, `VERIFY_TIMEOUT_MS` (600 s). Integrations run one at a time under a
  kernel `flock` (`src/lanes/lock.ts`, through `bun:ffi`), released when its
  holder dies: no stale lock exists, so there is no takeover protocol.
  A lane or consultation that finds the lane budget full waits for a slot
  (`limits.slot_wait_seconds`, default 600; PAUSE ends the wait) before it
  reports unavailable. Paid calls estimate and reserve spend for tracking
  before the harness starts. `spend.daily_usd` is accepted for compatibility but ignored
  (deprecated), so no call is blocked on this estimate.
- `src/orch.ts` installs only what `src/install/render.ts` lists and records it in a
  manifest; it renders targets only for detected harnesses. Uninstall removes
  exactly that and keeps edited files. Claude permission rules use only the
  tool names of `src/install/claude-rules.ts` (file writes are `Edit(<path>)`,
  never `Write(<path>)` or `MultiEdit`); `orch doctor` flags stale installed
  lead settings (`orch install` re-renders an unedited copy) and warns once
  about leftover files of the retired leads (presence unit, Grok lead agent
  and hooks); `orch install` removes the unedited ones its manifest recorded.
- `src/bus/` is the mailbox between projects declared in `orch.yaml`. A
  message is a request, never an order: HMAC-verified with a local pair
  key (`~/.orch/bus-keys/`, never the shared bus folder), at most two
  round-trips, then escalate. A project writes only in its repo and in
  declared neighbors' inboxes. `orch bus key init|export|import` copies
  the key to a neighbor.
- `src/lead.ts` starts Kiba on Claude Code (`kiba [claude]`, `lead` as an
  alias). Kiba runs on Claude only: `kiba codex` and `kiba grok` exit 2 with
  "Kiba runs on Claude only; Codex and Grok are lane workers and reviewers".
  `kiba --conductor` prints the orch serve status. It sets `ORCH_LEAD=1`,
  `ORCH_HARNESS`, `ORCH_CONDUCTOR` (`native`) and `ORCH_LEAD_PID`; that is
  how `orch mem` tells a lead session from a plain one. It records each
  launch (code revision, model, effort) under `<state dir>/leads/`
  (`src/core/lead-pulse.ts`), where the lead's hooks keep its busy/idle
  pulse; `orch install` and `orch doctor` list the running leads to restart
  (a Codex, Grok, conductor or presence lead from an older launcher is told
  to quit), never restart them.
- `src/hooks/` uses the cooperative operator policy `~/.orch/policy/hooks.yaml` (`orch policy show|edit|reset`) for lead guards and nudges, with live hook reloads and settings denies refreshed at launch.
  Async Claude SubagentStart/SubagentStop hooks append session records under `<state dir>/subagents/`, exposed as running and recent finished subagents in the atelier.
  It serves lead lifecycle hooks for bash input, edit counting,
  prompt resets and lane integration reminders in Claude lead sessions (a
  leftover Codex or Grok lead hook does nothing). In a Claude lead session they also carry the living memory:
  `session-start` injects `<state dir>/kiba-memory/USER.md` (1375 characters) and
  `MEMORY.md` (2200) plus a project recall, `prompt-submit` injects a
  synchronous provider recall (1500 tokens, both scopes, hits under
  `recall_min_semantic` dropped), `post-tool` queues a one-line summary per
  tool call (one PostToolUse process: synchronous for Edit|Write, which it
  also counts, background for every other tool; the command runs
  `src/hooks/hook.ts` directly through the `orch` symlink, never the `orch`
  CLI, and its heavy imports load lazily, with `src/hooks/log.ts` as the light
  log store imported by the per-tool hook, so a per-tool hook costs about 20 ms
  instead of 80) and `stop` retains the turn
  into the project bank only after an accepted Stop. `ORCH_MEMORY_PROVIDER=brain` selects the
  embedding-only provider; benchmarks require `ORCH_BRAIN_SNAPSHOT` and never
  fall back to the live brain. Memory failures are logged to `hooks/hindsight.log`,
  never prompt text; the hook always stays fail-open.
  The lead settings set no statusLine: a lead keeps the operator's own,
  untouched. `orch hook statusline --harness claude`, wired by hand as a
  statusLine, saves `rate_limits` to `<state dir>/quota-claude.json` for the
  dash quotas (`src/dash/quota.ts`) and chains the operator's own once.
- `src/memory/hindsight.ts` is the client of Hindsight (Vectorize, MIT,
  pinned `hindsight-api:1.1.0-slim`), run by `infra/compose.yml` on
  `127.0.0.1:8899` against its own `hindsight` database and role on
  brain-postgres (`orch brain provision` creates them, the pgvector extension
  and the operator bank `kiba`; project banks `kiba-<project>` appear at the
  first retain; `orch brain hindsight-rename <from> <to>` moves banks by
  clone, no LLM call).
  Extraction: Anthropic (`ANTHROPIC_API_KEY`); embeddings: OpenAI
  `text-embedding-3-small`; reranking: RRF. Automatic consolidation stays
  disabled in Compose (`ENABLE_OBSERVATIONS` / `ENABLE_AUTO_CONSOLIDATION=false`);
  the paid consolidate path was removed. Recall excludes observations by
  default (`facts_only: true`); retain still
  extracts facts. Config in `catalog/brain.yaml`
  under `hindsight:` (optional, localhost defaults). `health` requires a JSON
  `status`: another service on the port must not pass. Tests run against a
  fake `Bun.serve`; a synchronous retain is a paid extraction.
  `src/memory/seed.ts` (`orch brain hindsight-seed`, routine `hindsight-seed`)
  copies the active `orch mem` notes and the daily exhaust (lane ledger, asks,
  routines journal, improve briefs, docs/cr, ask syntheses) into the banks,
  one `document_id` per item in replace mode, skipping what
  `<state dir>/hindsight-seed.json` already holds, namespaced by server and base
  bank; `--full` resends all. Pruning needs complete source coverage, and a
  benchmark uses its own manifest state.
- `src/bench/` owns versioned, immutable run artifacts, named baselines and
  per-case comparisons. `orch bench` supplies the CLI; the existing memory and
  consumption runners are suite adapters. Corpus, model and protocol changes
  make runs incompatible. Paid suites need an explicit `--allow-paid`.
  `native-parity` (`src/bench/suites/native-parity.ts`, fixture in
  `native-parity-fixture.ts`) compares plain Claude Code with native Kiba,
  memory off and on: the native non-regression gate, baseline
  `native-parity-1`, and the only paid bench besides memoire and conso. Its
  runs and baselines stay under the suite key `superagent-parity`, the one
  the sealed baseline was recorded with (`orch bench run superagent-parity`
  is a deprecated alias). The POC suites (conductor, durable runtime A versus
  B, architecture mock) and their sealed results live on the `archive/benches`
  branch.
- `src/memory/transcripts.ts` imports interactive Claude transcript evidence
  with deterministic bounded chunks, replay-safe identities and checkpoints.
  Embeddings are the only provider call; worker and benchmark ingestion is
  refused. `orch brain ingest-transcripts --allow-paid` is explicit and the
  periodic routine stays off until D is accepted. Migration 004 reserves
  transcript revision identities. `orch brain snapshot --out <file>` exports
  frozen vectors for D without a model call.
- `src/mem/mem.ts` stores one Markdown note per durable decision in three scopes
  (project in `~/.orch/<project>/mem`, outside the repository, keyed by the
  main worktree's folder name; operator and lead under the state dir); notes are superseded or forgotten, never deleted.
  `orch mem` recall is on demand; what a session gets without asking is the
  bounded hook injection above. Workers (`ORCH_LANE=1`) never write.
  `ORCH_MEM_SANDBOX=<dir>` (`src/mem/sandbox.ts`, set by the benches for every
  configuration) keeps the real notes readable but sends every write to
  `<dir>`; a real note it supersedes or forgets is only masked there.
- Project skills live once in `.agents/skills/<name>/` (read by Codex);
  `.claude/skills/<name>` and `.grok/skills/<name>` are relative symlinks to
  it. Grok loads them only once the folder is trusted: `grok --trust -p
  '/workflow list'` in the repo records it with no model turn.
- `src/mem/similar.ts` backs `orch mem review`: close active notes, checked
  after the fact (lexical, no model; the lead judges). A check at write time
  was benched on 2026-10-21: no gain, more tokens. `tests/fixtures/mem-dedup`
  pins its recall. The benchmarks that justified these choices live on the
  `archive/benches` branch.
- `src/docs/docs.ts` keeps a local docs corpus declared in `catalog/docs.yaml`
  (sparse git clones or llms.txt), indexed by the external `ctx` CLI and
  searched on demand. Tests use file:// sources and a fake `ctx` on PATH.
- `src/improve/` turns the last 24 hours of operator messages, tool errors,
  failed routines and lanes into evidence backed proposals. Its Claude run is
  read only and sends proposals to the phone for the operator to review.
- `src/reflect/` uses that same daily evidence with USER.md and MEMORY.md:
  the model returns a line delta for MEMORY.md (`+` add, `~` replace, `x`
  drop by exact line start), applied mechanically under guards (2200
  characters, never below half, at most 3 lines dropped or replaced; an
  oversized result is refused whole, never truncated, and the room left is
  shown in the prompt). USER.md rules, additions and removals alike, are
  candidates: only `orch reflect accept <n>` changes the file, a removed
  line goes to `reflect/USER.history.md`. Skills are drafted only on an
  explicit request in the digest (research of 2026-10-28:
  `~/.orch/orch/asks/memoire-tri/answer.md`). Every result is journaled under
  the state directory.
- `src/llm/llm.ts` backs `orch llm`: the `embed` and `decide` providers of the
  memory brain, declared in `catalog/llm.yaml` and switched at run time
  (selection in `llm.json` under the state dir). Keys come from the
  environment, else the git-ignored `.env` (`.env.example`). A switch to
  another embedding `space` is refused without `--force`: stored vectors
  must be re-embedded. Loaded lazily so the Anthropic SDK stays out of other
  commands. Tests use a fake HTTP server; `orch llm test` is billable.
- `src/brain/` backs `orch brain`: the Postgres + pgvector memory, one
  database and two roles (`ro`, `rw`, no DELETE) per domain of
  `catalog/brain.yaml`, run by `infra/compose.yml` on localhost only, schema in
  `infra/migrations/` (append a new numbered file, never edit an applied one).
  Memories are unique by content hash, superseded or forgotten, never
  deleted. `src/core/env.ts` is the one `.env` reader. Tests run on PGlite
  (in-process Postgres with pgvector) and a recorder for provisioning; they
  never start a container. `orch brain up` pulls and starts a container and
  `orch brain embed` calls a paid provider: operator's go-ahead first.
- `orch mem` goes through `src/mem/backend.ts`: Markdown files, or the brain
  (`src/brain/notes.ts`) when `catalog/brain.yaml` says `mem: brain`. Both keep
  the same note ids and scope rules; project notes in the brain belong to one
  repository (`projectKey`). Only a failing query embedder degrades, to text
  recall with a warning on stderr; there is no fallback between backends.
- `src/presence/` keeps only the notification channels
  (`catalog/presence.yaml` `notify:`, `notify.ts`: none, telegram or
  discord), used by orch serve, routines, improve and reflect; the persistent
  presence lead is retired and `orch presence start|stop|ensure|run` print
  that orch serve (opt-in unit `orch-serve.service`) replaced it.
  `orch kill [--all|<lane>]` kills worker process groups and writes `PAUSE`,
  which orch serve honors; `orch resume` clears it. Running lanes re-check
  `PAUSE` between setup, continue and verify. `src/routines/` runs `catalog/routines.yaml`
  when due (every/retry, the host is not always on), one tick after start-up
  then every 15 minutes, one at a time under a pid lock, journaled. `src/ops/` holds read-only host
  controls as pure functions over collected text. `orch install` writes the
  systemd user units but never enables them: `systemctl --user enable` is the
  operator's. Tests use fakes and temp dirs: no tmux, systemd or network.
- `src/dash/` serves the Tableau Kiba (`orch dash`, SPA in `ui/`). One hub
  builds the snapshot once per change for every open page: `/api/stream`
  sends the snapshot, `/api/flow` Kiba's product architecture of `flow.ts`
  (each block with its real settings from the `kiba` profile, the policy,
  the machine budget and engine health, plus a 24-hour counter; sent only
  when it changed), which the `/flux` page draws as a fixed line map in
  `ui/src/pages/Flux.tsx` (orch serve's journal, outbox and ladder). The
  snapshot carries the orch serve tasks (`tasks`: objective, state, next
  action, worker session and step, lane, delivery) where Kiba intents were;
  its lane budget comes from the `kiba` profile. The
  hub watches the Kiba, lanes and leads state recursively, and every stream
  gets a heartbeat so Bun's idle timeout never cuts a quiet page.
- `tests/e2e/kiba/incidents.e2e.test.ts` replays real incidents end to end through
  the lane, gate and orch serve verify (`orch task adopt`) paths with fake
  binaries: add one case per incident that reached the operator.
  `tests/e2e/kiba/migration.e2e.test.ts` covers `orch serve migrate`.
- Bun only. `make check` (typecheck, tests, parity levels 0-2) must pass. Tests
  use fake harness binaries and temporary homes; they never call a model.
- Live parity levels 3-4 are billable: run only on the operator's request.
  `make bench-memoire` (src/checks/memoire.ts) is the memory bench of
  tests/parity/memoire.yaml: A (Claude alone), B (`ORCH_MEMORY=off`),
  C (Hindsight), D (brain recall), from pinned throwaway worktrees. C/D
  require the same frozen snapshot. Recall disables tools and MCP so answers
  cannot come from fixtures or old reports; retain stays off. A blind Claude
  judge must exit successfully and return every score. Runs use UUID banks,
  sessions and state, with results under `<state dir>/bench/memoire/<run>/`.
  Both benches sandbox every memory write. `orch bench` requires
  `--allow-paid` for model runs and keeps sealed history, named baselines,
  comparisons and immutable invalidation records (see docs/benchmark.md).
  `make bench-conso` (src/checks/conso.ts) measures what those four cost on
  the multi-prompt sessions of tests/parity/conso.yaml: Claude Code tokens and
  dollar estimate per prompt, plus Hindsight's own model calls read from its
  per-bank `llm-requests/stats` once its queue drains; `ARGS=--live` prints
  Hindsight's real usage per bank and day, with no model call.
- Never write under the operator's real HOME from tests; real installs need
  the operator's explicit go-ahead.
