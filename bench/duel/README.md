# Duel bench: plain `claude -p` versus native Kiba versus orch serve

Which system costs more, which is faster, which delivers better code, on the
same features in the same order.

| Arm | What runs | Model by default |
| --- | --- | --- |
| `claude` | plain `claude -p`, one session resumed from feature to feature | Opus/medium (`--model`) |
| `kiba` | native Kiba (`claude --agent kiba`, production hooks, memory off), may delegate to subagents or lanes | Opus/medium (`--model`) |
| `serve` | orch serve: one operator task per feature, worker runtime A, VERIFY through `orch task adopt`, ladder and watchdog, outbox delivery (local: no push, no PR), then the bench merges the delivered branch | the `kiba` profile ladder (Sonnet/medium for these features), or `--serve-rung` |

Every arm gets the same objective, the same Claude sandbox and scope guard,
Agent allowed, a 3 USD budget per process, a 20 minute timeout per feature,
and one nudge when a feature ends with no change (a question, for `serve`).
Arms run one after another, reversed on even repetitions.

## Judging (same for every arm)

After each feature: the hidden acceptance test of the workload
(`bench/versus/workload.json`, never shown to the model), the full suite,
files touched outside the feature's FILES and `tests/`, then an operator
commit. At the end, every hidden test is rerun on the final tree
(regressions).

- **Cost**: Claude Code's estimate per result (`model_usage_since_last_result`,
  subagents included), plus lane costs from the run's ledger for Kiba. A cost
  marked `(min.)` is incomplete (a lane or review without a cost record).
- **Time**: from the prompt to the end of the work, judging excluded.
- **Quality**: hidden acceptance, final acceptance, green suite, out of scope
  files.

## Run

```sh
bun bench/duel/run.ts --dry-run                       # argv, env, ladder, no model call
bun bench/duel/run.ts --yes --tasks T2 --reps 1       # cheapest wiring check
bun bench/duel/run.ts --yes --reps 3                  # 5 features x 3 arms x 3
bun bench/duel/run.ts --yes --serve-rung opus/medium  # same model in every arm
bun bench/duel/run.ts --report <run dir>              # re-render report.md
```

Paid (Claude Code quota): nothing starts without `--yes`. Results:
`<orch state>/bench/duel/<run>/results.json` and `report.md`, logs per
repetition and arm. Toy repositories, orch state, orch home and temp live
under `/tmp/orch-duel-<run>/`; API keys and forge tokens are removed from
every arm's environment (subscription login, nothing can push).

## Limits

- Default features are mechanical and normal: a risky one sends `serve`
  through a ship review by another harness (Codex) whose cost is not in the
  Claude estimate.
- Kiba's memory is off (no Hindsight bank); `native-parity` measures memory.
- By default `serve` runs on its profile ladder (Sonnet) while the sessions run
  Opus: the product as configured. `--serve-rung opus/medium` isolates the
  system from the model choice.
- Small toy features and few repetitions: per-pair cost varied by up to 30
  percent in earlier benches, so read a gap under that as noise unless
  several repetitions agree.
- `tests/bench-duel.test.ts` runs the `serve` arm end to end with a fake
  `claude`; the session arms are only covered by the paid run.
