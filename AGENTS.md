# orch contributor guide

A token-lean lead developer for Claude Code, Codex and Grok Build, with its
own file-based memory (`orch mem`). No external memory system or launcher.

- `catalog/lead.md` is the single lead prompt for all three harnesses. Keep it
  short, stable (no dates or variables) and in English: it is a cached prefix.
- `src/lane.ts` runs one task headless in a git worktree and prints a bounded
  report. It must never call a model itself and never forward the caller's
  environment beyond the allowlist in `src/proc.ts`.
- `src/orch.ts` installs only what `src/render.ts` lists and records it in a
  manifest; uninstall removes exactly that and keeps edited files.
- `src/lead.ts` starts the harness binary directly with the lead profile:
  `--agent lead` for Claude and Grok, one `developer_instructions` for Codex.
  It sets `ORCH_LEAD=1` and `ORCH_HARNESS`; that is how `orch mem` tells a
  lead session from a plain one.
- `src/mem.ts` stores one Markdown note per durable decision in three scopes
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
- `scripts/orca-run-teardown.sh` closes an Orca Run (worktrees, setup
  terminals, merged branches); the `operator-delegation` skill points here.
- `src/docs.ts` keeps a local docs corpus declared in `catalog/docs.yaml`
  (sparse git clones or llms.txt), indexed by the external `ctx` CLI and
  searched on demand. Tests use file:// sources and a fake `ctx` on PATH.
- Bun only. `make check` (typecheck, tests, parity levels 0-2) must pass. Tests
  use fake harness binaries and temporary homes; they never call a model.
- Live parity levels 3-4 are billable: run only on the operator's request.
- Never write under the operator's real HOME from tests; real installs need
  the operator's explicit go-ahead.
