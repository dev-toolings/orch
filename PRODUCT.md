# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: React + Vite + TypeScript + Tailwind + React Router in `ui/`, three.js via react-three-fiber + drei for the floor, Bun.serve for the read-only API. Chosen by the operator brief (not inferred).

## Users

Primary user: Kevin, the operator of orch on his Ubuntu server (kev), where Kiba leads already run. He opens a local HTTP page (default `127.0.0.1:7894`, optionally bound elsewhere with `--host`) to see, at a glance, which projects have an active Kiba and what those leads and their lanes are doing.

Assumption (no interview tool in this unattended run; inferred from the brief): he glances often, for seconds, not minutes; French UI copy; no other audience in v1.

## Product Purpose

A live, read-only dashboard of the active Kiba leads per project, served by `orch dash`. Success is: Kevin can tell in one look who is working, idle or blocked, on which project, with today's spend against the cap, without starting a terminal or reading `orch top`.

## Positioning

It reuses orch's own sources (`presence`, `orch top`, lane state, spend ledger, bus) and exposes them as a small JSON/SSE API plus a built SPA. A neighboring status page could not truthfully copy that without running on the same host and reading the same state. v1 has no actions: it never starts, stops, or messages a lead.

## Operating Context

- Host: Kevin's Ubuntu server where orch is installed (`orch presence`, lanes, spend, bus).
- Entry: `make dash` or `bun run dash` (build SPA, then `orch dash` on port 7894).
- Live refresh about every 2 seconds (SSE or polling).
- Routes: `/` overview, `/runs` lane queue, `/runs/:id` traces, `/approvals`, `/agents`, `/tools`, `/providers`, `/spend`, `/activity`, `/skills`, `/atelier` (3D/2D secondary).
- Empty when no Kiba is running; graceful when the API is unreachable.
- 3D atelier with a 2D toggle and automatic fallback for low-power or `prefers-reduced-motion`.

## Capabilities and Constraints

- Read-only. No start/stop, no bus send, no lane actions.
- Never expose secrets, env vars, keys, prompts, or file contents. Remote Control is a boolean, not the display name. Bus keys and HMAC stay off the wire. Ledger lines are id/at/status/model/effort/cost/channel only.
- Default bind `127.0.0.1`; `--host` override; port default 7894.
- Per project: active leads (pid, harness, model, effort, permission mode, start/uptime, remote-control flag, cwd), lanes (status, model, cost), bus counts if any, today's spend vs cap, budget.
- Assumption: one presence session is the usual live lead; extra leads are injectable for tests and future multi-session hosts. Project name is the workdir / repo folder basename, same as `orch top`.
- Assumption: lead activity is `working` if a lane is running on that project, `blocked` if a lane is blocked (and none running), else `idle`.
- UI copy is French. No mention of third-party product names outside orch/Kiba.
- Bundle stays reasonable: the 3D route is lazy-loaded. No runtime downloads of 3D assets.

## Brand Commitments

- Name: Tableau Kiba (UI); command: `orch dash`.
- Voice: French, sentence case, operator-facing, no marketing.
- Binding from the brief: distinctive non-generic UI (impeccable Operate + frontend-design), procedural avatars per harness (claude / codex / grok), no external asset downloads at runtime.

## Evidence on Hand

- Live data from orch state on kev; tests use injected fixtures, never the ambient home or a model.
- No photography, no logo file, no customer quotes. Screenshots in this run are of fixture data and must be labeled as such.

## Product Principles

- Glance first: the project board is the product; the atelier is a second look; tables and panels explain a selection.
- Same facts as the CLI: the dashboard is another view of `top` / presence / ledger / bus, not a second source of truth.
- Fail open and quiet: empty and unreachable are usable states, never a crash or a leaked error with secrets.
- Watch, do not steer: v1 is a window, not a remote control.
- Least data: if a field could leak a key, a prompt, or a file, it stays off the API.

## Accessibility & Inclusion

- `prefers-reduced-motion` forces the 2D floor; a visible toggle does the same.
- Contrast at the craft floor (body ≥ 4.5:1, large text ≥ 3:1).
- Keyboard: routes, table sort, panel close, 2D/3D toggle.
- Assumption: one operator, desktop viewport first; usable down to a laptop, not a phone-first product.
