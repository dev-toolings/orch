---
name: model-refresh
description: Re-evaluate the models orch assigns to leads, lane workers and reviewers (catalog/profiles/*.yaml) after a new LLM release or when the evidence from past lane and review reports says a choice is wrong. Use when the operator says a model came out ("nouveau modele", "sortie de", "GPT-x est sorti", "Opus x"), asks to revisit, refresh or justify the model per role ("revoir les modeles", "quel modele pour la review"), or when a profile names a model id that no longer exists. Not for changing one run's model ad hoc (pass --effort or --risk instead).
---

# model-refresh

## Goal

Keep every model choice in `catalog/profiles/*.yaml` current and justified:
each role (lead, lanes, review normal, review `high`) names a model that
exists today, fits the operator's quotas, and is backed by evidence, not by
the model's own memory of what is new.

## Why

Model names move faster than any knowledge cutoff, and these choices encode
operator decisions (quota per plan, risk-based review). A stale or invented
id fails at launch; a silently upgraded effort burns quota.

## Current rules to respect (re-read before proposing)

- Run `orch mem search review model` and `orch mem search luna sol astra`:
  the operator's standing choices live there (risk-based review: normal
  `gpt-6-luna` xhigh, high `gpt-6.1-sol` medium, as of 2026-10-20). Cite the
  note id. Reversing one needs the operator's explicit go-ahead.
- Global operator rules (`~/.claude/CLAUDE.md`, `operator-delegation`
  skill): Codex orchestrator is GPT-6 Astra medium; never raise an effort or
  escalate to Sol on your own; Grok workers inherit the session model, never
  pass one (`lanes.grok.model` must stay null, `loadProfile` enforces it).
- `lean` is the economy profile: a change there must lower or keep cost.
- `catalog/lead.md` never names a model id (cached prefix, no variables).

## Evidence, in this order

1. **What exists locally** (authoritative for ids):
   - Codex: `python3 -I -c 'import json;print([m["slug"] for m in json.load(open("'$HOME'/.codex/models_cache.json"))["models"]])'`
   - Claude: aliases `opus`, `sonnet`, `haiku` resolve in the CLI; check
     `claude --help` for `--model` and the docs (`orch docs search model
     --stack claude`, or the claude-code-guide agent).
   - Codex and OpenAI docs: `orch docs search model --stack codex` and
     `--stack openai` (check freshness with `orch docs status`).
   - Grok: inherited, nothing to pick.
2. **What was released**: web search including the model name exactly as
   written, official sources first (OpenAI, Anthropic, xAI changelogs and
   model pages). Note date, intended use (coding, review, speed), pricing or
   quota weight. Say plainly when a source is missing.
3. **What orch's own outputs show** (the LLM outputs we already paid for):
   - Reviews: `~/.local/state/orch/reviews/<id>/` holds `prompt.txt`,
     `worker.log`, `last.txt`. Per reviewer: verdict, findings later
     confirmed by the lead vs. false positives, USAGE tokens, timeouts.
   - Lanes: `~/.local/state/orch/lanes/<id>/state.json` (status, usage,
     reason). Count complete / failed / refused per model, and why.
   - Read summaries only (head of `last.txt`, `state.json`); never paste
     whole logs into the context.

## Procedure

1. Snapshot the current table: role x profile x harness -> model, effort.
2. Gather the evidence above. Flag any profile id absent from the local
   lists: that is a defect, fix it first.
3. Propose a diff as a table: role, current, proposed, evidence (source URL
   or report ids), expected quota effect. Include an ASCII diagram only if
   the routing itself changes (operator-diagrams rule).
4. Stop and get the operator's approval. Never apply an upgrade, an effort
   raise or a new tier silently.
5. Apply surgically: the YAML entries, then every test that pins an id
   (`grep -rn "<old id>" src tests catalog`), then `make check`.
6. Record the decision: one `orch mem add --scope operator` note (what,
   why, date). Supersede the old note's wording, do not delete it.

## Boundaries

- No billable calls to compare models (live parity levels 3-4, `make
  smoke`, ad hoc benchmark runs) unless the operator asks in the current
  message; name the cost first.
- Never write under the real HOME and never run `orch install` without the
  operator's go-ahead; say the installed prompts stay stale until then.
- Bun only. No em dash or en dash in anything written.

## Verify

- `make check` passes (typecheck, tests, parity 0-2).
- Every model id in `catalog/profiles/*.yaml` appears in the local lists of
  step 1 (`grep -ho 'model: [^ ,}]*' catalog/profiles/*.yaml | sort -u`).
- The decision note exists: `orch mem search <new id>`.
