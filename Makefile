.DEFAULT_GOAL := help

C_SECTION := \033[1;33m
C_TARGET  := \033[36m
C_OK      := \033[32m
C_WARN    := \033[33m
C_ERR     := \033[31m
C_RESET   := \033[0m

# ─── Install / Setup ─────────────────────────────────────────────────────────

deps: ## Install dependencies with Bun
	@bun install
	@printf "$(C_OK)[make] dependencies installed$(C_RESET)\n"

plan-install: ## Show what orch install would write under HOME (no write)
	@bun src/orch.ts install --dry-run

drift: ## Compare installed files with the manifest
	@bun src/orch.ts diff

# ─── Check ───────────────────────────────────────────────────────────────────

test: ## Run backend tests (no model call)
	@bun test

typecheck: ## Type-check sources and tests
	@bunx tsc --noEmit && printf "$(C_OK)[make] typecheck ok$(C_RESET)\n"

parity: ## Powlisher parity matrix, free levels 0-2
	@bun src/parity.ts --level 2

check: typecheck test parity ## Typecheck, tests and parity matrix

doctor: ## Can each worker harness run a lane here (no model call)
	@bun src/orch.ts doctor

smoke: ## Real lanes x3 workers: job + confinement probes (BILLABLE, model calls)
	@printf "$(C_WARN)[make] smoke calls codex, grok and claude for real$(C_RESET)\n"
	@bun src/smoke.ts && printf "$(C_OK)[make] smoke ok$(C_RESET)\n" || { printf "$(C_ERR)[make] smoke failed$(C_RESET)\n"; exit 1; }

# ─── Lanes ───────────────────────────────────────────────────────────────────

lanes: ## List lane runs and their status
	@bun src/lane.ts status

lanes-gc: ## Remove integrated or empty lane worktrees and branches
	@bun src/lane.ts gc

# ─── Help ────────────────────────────────────────────────────────────────────

help: ## List targets by section
	@awk 'BEGIN {FS = ":.*## "} \
		/^# ─── / { s = $$0; gsub(/^# ─── | ─+$$/, "", s); printf "\n$(C_SECTION)%s$(C_RESET)\n", s } \
		/^[a-zA-Z_-]+:.*## / { printf "  $(C_TARGET)%-14s$(C_RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: deps plan-install drift test typecheck parity check doctor smoke lanes lanes-gc help
