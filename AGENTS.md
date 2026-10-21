# orch contributor guide

A token-lean lead developer for Claude Code, Codex and Grok Build, with its
own file-based memory (`orch mem`). No external memory system or launcher.

- `src/` keeps only the three installed entry points (`orch.ts`, `lane.ts`,
  `lead.ts`, symlinked from `~/.local/bin`); everything else lives in one
  folder per context: `core/`, `harness/`, `lanes/`, `install/`, `mem/`,
  `docs/`, `checks/`.
- `catalog/lead.md` is the single lead prompt for all three harnesses. Keep it
  short, stable (no dates or variables) and in English: it is a cached prefix.
- `src/lane.ts` runs one task headless in a git worktree and prints a bounded
  report. In a local Orca workspace it creates a child worktree and an OSC
  status observer terminal; the worker still uses `src/harness/proc.ts`, never an
  Orca launcher. It must never call a model itself or forward the caller's
  environment beyond that allowlist. A finished lane cuts its clean worktree
  (and its Orca terminals) at once and keeps only its branch; GC drops the
  branch once integrated and retries any cleanup Orca did not confirm.
- `src/orch.ts` installs only what `src/install/render.ts` lists and records it in a
  manifest; uninstall removes exactly that and keeps edited files.
- `src/lead.ts` starts the harness binary directly with the lead profile:
  `--agent lead` for Claude and Grok, one `developer_instructions` for Codex.
  It sets `ORCH_LEAD=1` and `ORCH_HARNESS`; that is how `orch mem` tells a
  lead session from a plain one.
- `src/hooks/` serves lead lifecycle hooks for bash input, edit counting,
  prompt resets and lane integration reminders across Claude, Codex and Grok.
- `src/mem/mem.ts` stores one Markdown note per durable decision in three scopes
  (project in `.orch/mem` of the main worktree, versioned; operator and lead
  under the state dir); notes are superseded or forgotten, never deleted.
  Recall is on demand only: nothing is injected at launch. Workers
  (`ORCH_LANE=1`) never write.
- Project skills live once in `.agents/skills/<name>/` (read by Codex);
  `.claude/skills/<name>` and `.grok/skills/<name>` are relative symlinks to
  it. Grok loads them only once the folder is trusted: `grok --trust -p
  '/workflow list'` in the repo records it with no model turn.
- `scripts/mem-bench.ts` is a billable memory benchmark (20 private facts, 4
  corrected, orch mem against an empty store, in Claude, Codex and Grok):
  run it only on the operator's request.
- `src/mem/similar.ts` backs `orch mem review`: close active notes, checked
  after the fact (lexical, no model; the lead judges). A check at write time
  was benched on 2026-10-21: no gain, more tokens. `tests/fixtures/mem-dedup`
  pins its recall; `scripts/mem-dedup-replay.ts` replays it read-only on
  real stores before any threshold change.
- `scripts/orca-run-teardown.sh` closes an Orca Run (worktrees, setup
  terminals, merged branches); the `operator-delegation` skill points here.
- `src/docs/docs.ts` keeps a local docs corpus declared in `catalog/docs.yaml`
  (sparse git clones or llms.txt), indexed by the external `ctx` CLI and
  searched on demand. Tests use file:// sources and a fake `ctx` on PATH.
- Bun only. `make check` (typecheck, tests, parity levels 0-2) must pass. Tests
  use fake harness binaries and temporary homes; they never call a model.
- Live parity levels 3-4 are billable: run only on the operator's request.
- Never write under the operator's real HOME from tests; real installs need
  the operator's explicit go-ahead.
