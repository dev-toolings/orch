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

e2e: ## Backend end-to-end scenarios on temp repos (fakes, no model call)
	@bun test tests/e2e

e2e-live: ## Same scenarios with the real claude on the subscription (ORCH_E2E_LIVE=1, model calls)
	@printf "$(C_WARN)[make] e2e-live uses real Claude and makes model calls$(C_RESET)\n"
	@ORCH_E2E_LIVE=1 bun test tests/e2e

test: ## Run backend tests (no model call)
	@bun test

typecheck: ## Type-check sources and tests
	@bunx tsc --noEmit && printf "$(C_OK)[make] typecheck ok$(C_RESET)\n"

parity: ## Emilien parity matrix, free levels 0-2
	@bun src/checks/parity.ts --level 2

check: typecheck test parity ## Typecheck, tests and parity matrix

doctor: ## Can each worker harness run a lane here (no model call)
	@bun src/orch.ts doctor

smoke: ## Real lanes x3 workers: job + confinement probes (BILLABLE, model calls)
	@printf "$(C_WARN)[make] smoke calls codex, grok and claude for real$(C_RESET)\n"
	@bun src/checks/smoke.ts && printf "$(C_OK)[make] smoke ok$(C_RESET)\n" || { printf "$(C_ERR)[make] smoke failed$(C_RESET)\n"; exit 1; }

bench-memoire: ## Memory bench with saved runs; ARGS="--dry-run" previews, --allow-paid authorizes model calls
	@printf "$(C_WARN)[make] bench-memoire requires --allow-paid for model calls; use --dry-run to preview$(C_RESET)\n"
	@bun src/orch.ts bench run memoire $(ARGS)

bench-conso: ## Consumption bench with saved runs; --allow-paid for model calls, ARGS=--live reads usage for free
	@printf "$(C_WARN)[make] bench-conso requires --allow-paid for model calls; --live reads usage only$(C_RESET)\n"
	@bun src/orch.ts bench run conso $(ARGS)

# ─── Lanes ───────────────────────────────────────────────────────────────────

lanes: ## List lane runs and their status
	@bun src/lane.ts status

lanes-gc: ## Remove integrated or empty lane worktrees and branches
	@bun src/lane.ts gc

# ─── Dashboard ────────────────────────────────────────────────────────────────

dash-build: ## Build the Tableau Kiba SPA
	@bun run --cwd ui build
	@printf "$(C_OK)[make] ui build ok$(C_RESET)\n"

dash: dash-build ## Build the SPA and serve it on 127.0.0.1:7894
	@bun src/orch.ts dash

dev: ## Vite HMR on :7894, orch dash API on :7895 (HOST=0.0.0.0 to bind all)
	@bun src/dash/dev.ts

stop: ## Stop dash dev processes on DEV_PORT and DASH_API_PORT
	@bun src/dash/stop.ts


# ─── Help ────────────────────────────────────────────────────────────────────

help: ## List targets by section
	@awk 'BEGIN {FS = ":.*## "} \
		/^# ─── / { s = $$0; gsub(/^# ─── | ─+$$/, "", s); printf "\n$(C_SECTION)%s$(C_RESET)\n", s } \
		/^[a-zA-Z0-9_-]+:.*## / { printf "  $(C_TARGET)%-14s$(C_RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: deps plan-install drift e2e e2e-live test typecheck parity check doctor smoke lanes lanes-gc help dash dash-build dev stop
