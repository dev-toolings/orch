# Benchmark runs

The benchmark store gives repeated model or system evaluations a durable run identity, a sealed output directory, and a comparison contract. Each run records the suite and feature, source revision and dirty tree hash, paid status, and fingerprints for its corpus, settings, models, and protocol. Results keep individual attempts so quality, cost, latency, and errors retain their denominators.

## Why this module exists

Existing checks own their runner logic and can keep their current reports. This module supplies the shared run lifecycle and comparison data so changes can be compared against a named baseline without rewriting historical reports. It does not start models, prepare snapshots, or check out a requested Git ref. The runner supplies the source metadata and is responsible for isolating execution at that revision.

```text
.--------------------.
|    suite adapter   |
'---------+----------'
          |
          v
.---------+----------.       .----------------------.
|    allocateRun     +------>| exclusive run folder |
'---------+----------'       '----------------------'
          |
          v
.---------+----------.
| runner writes data |
'---------+----------'
          |
          v
.---------+----------.
| finalize metrics   |
'---------+----------'
          |
          v
.--------------------.       .--------------------.
| immutable run data +------>| named baseline and |
'--------------------'       | comparisons        |
                             '--------------------'
```

## API

`allocateRun(options)` creates a versioned run manifest and returns the UUID, output path, run-specific session namespace, bank name helper, per-config `ORCH_STATE` path helper, artifact writers, and finalizer. `root` is the benchmark root and defaults to `<orch state>/bench`. The optional `dryRun` returns planned identifiers and paths without creating files. The API does not accept a caller-selected run ID or output directory, so a completed run cannot be reopened as a new run.

Runners pass a `SourceSnapshot` with `revision`, `dirtyHash` (or `null` for a clean tree), and optional `ref`. The module fingerprints the structured `corpus`, `settings`, `models`, and `protocol` inputs with canonical JSON and SHA-256. It stores fingerprints rather than the raw inputs. A runner can put source snapshots, seed manifests, or other context in the run using `writeArtifact` or `writeJsonArtifact`.

Finalization writes `metrics.json`, hashes every output file into `manifest.json`, then makes the run tree read-only. Each metrics row represents one attempt:

```text
{ caseId, config, attempt, quality?, cost?, latencyMs?, error? }
```

Quality, cost, and latency summaries include an `n` count for observed values. Error counts and rates use every recorded attempt as their denominator. A missing measurement stays missing instead of being silently treated as zero.

`setBaseline(suite, runId, name)` moves a named pointer, defaulting to `default`. It verifies every recorded artifact hash before accepting the run. `compareRuns(baselineId, candidateId)` requires completed runs with the same suite, feature, corpus fingerprint, model fingerprint, and protocol fingerprint, then verifies the artifact hashes again before reading metrics. Settings may differ because settings are commonly the variable under evaluation. The comparison reports that difference as a warning.

Comparison returns per-config, per-case means, observed denominators, attempt and error counts, and candidate-minus-baseline deltas. A missing measurement has a null delta when either side lacks an observation. The candidate run may supply a `regressionPolicy`. By default, any observed quality decrease or error-rate increase is flagged. Cost and latency changes remain descriptive unless `maxCostIncrease` or `maxLatencyIncreaseMs` is set. `minQualityDelta` and `maxErrorRateIncrease` adjust the default gates. `history(suite)` returns manifests newest first.

## CLI entry

`bench(args)` in `src/bench/cli.ts` is the lazy CLI entry for `orch bench`. It dispatches `memoire` and `conso` runner scripts, requiring `--allow-paid` for normal runs and accepting `--dry-run` as a preview. Runner-specific arguments, including `--ref`, pass through. Custom `--out` paths are rejected because runs must own fresh directories.

The non-paid `memory-contract` suite calls the hook and reflection source modules directly with synthetic memory hits and strings. It checks that recall skips an oversized first hit, that explicit no-op reflection preserves memory, and that reflection refuses more than three removals. It does not invoke shell test commands or call models. A current-source run records `HEAD` and the dirty tree hash. With `--ref`, it resolves a commit, requires the ref's `bun.lock` to match the current dependency lock, creates a temporary detached worktree, imports the modules from that tree, then removes the worktree. No source snapshot is claimed when the requested ref cannot be resolved or the dependency locks differ.

For example, compare current code with a previous commit using the same fixture corpus:

```text
orch bench run memory-contract --ref HEAD~1
orch bench run memory-contract
orch bench compare <previous-run-id> <current-run-id>
```

The CLI also implements:

```text
orch bench baseline set <suite> <run-id> [name]
orch bench compare <baseline-run-id> <candidate-run-id>
orch bench history <suite>
orch bench invalidate <run-id> --reason "answer-key leakage"
```

Invalidation writes a separate, immutable reason record without changing sealed evidence. Invalidated runs remain visible in history and cannot become a baseline or participate in a comparison.

The CLI does not silently pick a baseline for comparisons. The operator chooses the two run IDs, while the named baseline pointer supports workflows that want to resolve a stable reference later. A comparison with detected regressions exits with status 1; a run still records failing case scores so it can be inspected or compared.

Claude benchmark processes exclude inherited `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; they use the native harness login instead of silently billing a repository API key. Hindsight keeps its own server-side extraction credentials. The memory suite also pins its blind judge to the Claude harness so a review profile cannot silently route the judge to another subscription.

## Memory comparison protocol

Preview the recall cohort without model calls:

```text
make bench-memoire ARGS="--dry-run --family rappel --config C,D"
make bench-conso ARGS="--dry-run --config C,D"
```

Configurations B, C and D of both benches start the same Kiba as `kiba` on Claude: the flags come from `kibaFlags` in `src/kiba/conductor.ts`, the helper `kibaArgv` uses, applied to the source snapshot (its rendered lead settings, its `catalog/kiba.md` through `--append-system-prompt-file`, its profile's `kiba.lead_disallowed_tools` through `--disallowedTools`, and its `src/orch.ts` as the `kiba` MCP). Each bench keeps its own settings file per configuration and its opus/high pins. The memory recall family keeps `--tools ""`, `--strict-mcp-config` and an empty MCP configuration, so the `kiba` MCP is not added there; the prompt and denied tools still are. Configuration A stays plain Claude. The protocol records `leadLaunch: "kiba-conductor-v1"`: runs from the former `--agent kiba` launch (the full lead prompt, no tool restriction, no `kiba` MCP) have another protocol fingerprint and are never compared with new ones.

A paid C/D run requires `--allow-paid`, a clean committed source (or an explicit supported `--ref`), and `--brain-snapshot <file>`. Use the same snapshot, model, corpus, and repetition protocol for baseline and candidate runs. C/D recall disables retain. A shared system instruction bounds replies to three sentences and requires an explicit unknown when the context lacks a past decision; user queries stay unchanged for hook retrieval. Recall-family sessions disable built-in tools and all MCP servers: source files, fixtures, and prior benchmark reports must not supply answers. This changes the protocol fingerprint, so old tool-enabled runs cannot serve as equivalent recall baselines. Native session and prompt hooks emit run-scoped receipts without recalled text; scoring requires receipts for every C/D session and the selected provider. Generated hook commands are rewritten after parsing JSON and tested from an empty HOME. Cloud connectors are explicitly disabled because strict MCP configuration alone does not cover account connectors. A judge must report `EXIT: 0` and exactly one score per answer; authentication failures, missing scores, and duplicates fail the suite. Learning (`apprentissage`) must run separately from other cohorts; C/D learning is currently refused because isolated learning and its accounting are not implemented. The default whole-corpus memory invocation therefore refuses mixed learning cohorts; choose a family explicitly.

## Frozen memory providers

`orch brain snapshot --out <new-file>` exports active notes and transcript evidence from the current project and the shared operator/lead scopes. This is a read-only database operation with no model call. Rows without a vector in the selected embedding space remain in the corpus with `embedding: null`; they are not silently dropped from the C/D comparison. The snapshot is private and an existing output file is refused.

The D hook adapter selects `ORCH_MEMORY_PROVIDER=brain`. With `ORCH_BRAIN_SNAPSHOT`, it searches only that snapshot and never falls back to production. The same snapshot supplies on-demand `orch mem` reads in all benchmark configurations; writes stay in the run's sandbox. Production brain recall uses the read-only database role and a bounded query/embedding deadline. Query embeddings remain billable; an unmeasured embedding cost must stay missing in benchmark metrics.

Transcript ingestion is separate from prompt recall. `orch brain ingest-transcripts --allow-paid` deterministically chunks interactive Claude user messages (assistant turns are dropped), rejects secret-bearing chunks fail-closed, embeds changed chunks in batches, and checkpoints only after durable work. An `ingest_projects` allowlist (deny by default) decides which project keys may enter `projets`. Replaying a file adds no duplicate memories; edited chunks supersede prior revisions. Partial final JSONL records wait for completion. Ingestion is refused in workers and benchmark environments. `--max-usd`, `--max-chunks` and `--dry-run` bound a run. Secret filtering is a safeguard, not proof that arbitrary prose is anonymous.

The transcript routine stays disabled until D is accepted. Hindsight remains the default recall provider. Compose disables both observation generation and automatic consolidation. The paid consolidate command and routine were removed. Recall requests only raw world/experience facts. Applying Compose or database migrations is a separate deployment action; editing the files does not prove the live container has changed.

Seed manifests use version 2 and separate server/base-bank namespaces under a lock. A legacy flat manifest is not trusted for deletion or skip decisions; the first approved seed after migration may resend existing documents. Benchmark seeding uses a run-local manifest and frozen input, with no daily exhaust added to the snapshot corpus. This keeps a reference run independent of subsequent production memory changes.

## Verification

Run the focused offline suite with `bun test tests/bench.test.ts`. It uses temporary directories and deterministic observations. It does not call models, access the network, alter real benchmark history, or start services. `bun run typecheck` checks the API and CLI types.

## History

Before `native-parity`, a series of POC benches (all of 2026-11-03) shaped
the current design: an orchestration pilot (native Claude Code versus the Kiba
conductor and its lanes), `poc-v0.0.1` (concurrent tasks, follow-ups and CI
events), `poc-v0.0.2` (delivery, restart and late continuation, then durable
task supervision under real process faults and a matched native control), a
worker runtime comparison for `orch serve` (A, one resumable `claude -p`
process per revision, versus B, `claude --bg` background sessions), and a
mock architecture bench with a warm worktree and worker pool. Conclusions: at
equal quality, the production conductor cost more than native delegation to
subagents (native was 30.7 and 31.7 percent cheaper in the two paired
controls), so the dispatch-only conductor was retired; runtime A met all 7
continuity checks of `durable-1` with no extra model call while B needed a
per-workspace trust acceptance, lost a job and leaked a process, so `orch
serve` workers use A; native Kiba with its living memory is at parity with
plain Claude Code (below). The suites, their tests, the sealed result
summaries (`poc-v0.0.1.json`, `poc-v0.0.2.json`) and the full write-ups live on
the local `archive/benches` branch.

## Native parity: plain Claude Code versus native Kiba, memory off and on

`orch bench run native-parity` is the native non-regression bench: plain
Claude Code against native Kiba under protocol `native-parity-1`. Its acceptance criterion is the same
quality, no higher estimated cost, and no slower response than the plain arm.
Results of 2026-11-03 are in the subsection at the end of this section.

The three arms are `plain`, `kiba-mem-off`, and `kiba-mem-on`. All use
Opus/medium, `acceptEdits`, the same Claude sandbox, empty setting sources,
strict empty MCP configuration, disabled Agent delegation, and a 2 USD CLI
budget per revision. Plain Claude gets only sandbox settings, with no named
agent, Kiba prompt, orch hooks, or lead environment. Both Kiba arms use
`nativeKibaArgv` and production lifecycle hooks. Their isolated state contains
generic synthetic USER.md (1375 characters) and MEMORY.md (2200 characters),
so their injected context is counted without copying personal data.

Each case uses the same workload: the CSV request, clarification, and late
document-parsing comment from `controlInputs`
(`src/bench/suites/native-parity-fixture.ts`). A fresh
stream-json process resumes the same session for revisions two and three.
The driver runs the same public tests and hidden acceptance after each
revision, then publishes its verified source identity to the same local
receiver. Quality is verified revisions divided by three. The default is two
repetitions: plain, memory off, memory on, then memory on, memory off, plain.
`--one-pair` runs the first three-arm repetition only.

```sh
orch bench run native-parity --dry-run
orch bench run native-parity --allow-paid --one-pair
orch bench run native-parity --allow-paid
orch bench history native-parity
```

The dry run prints the protocol, credential-free argv and environment key
differences for all arms. It starts no Claude process or Hindsight request
and writes no run artifacts. Execution requires Linux, the normal native
Claude login, and a healthy Hindsight server at the URL in `catalog/brain.yaml`.
The runner derives each owned configuration from that catalog, ignoring an
inherited `ORCH_BRAIN_CONFIG`. An unhealthy server refuses the experiment
before any Claude spending.

Memory off sets `ORCH_MEMORY=off`. Memory on leaves it unset and writes a
run-owned configuration through `benchBrainYaml`, preserving catalog recall
limits (including the default session-start limit) and enabling retain.
Fresh `bench-parity-<uuid>` operator and project banks are provisioned before
that case. Each arm retains `ORCH_MEM_SANDBOX`. The memory-on queues are
drained after the case; exact owned-bank usage and the existing conso pricing
produce `hindsightTokens` and `hindsightUsd`. Both banks are dropped at the end,
including after a failed case. There is no access to the operator's banks.

Total estimated cost adds per-result CLI cost deltas and Hindsight estimated
USD. Evidence also records execution, verification and residual coordination
milliseconds, raw result receipts, output tokens and cache counters when
available, verified revisions, publication receipts, and hook context bytes
summed by event. The hook JSONL receipts, source snapshots, verification logs,
and final sources are sealed with `evidence.json` and per-arm observations
under `<orch state>/bench/superagent-parity/<run-id>/`. Runs and baselines
keep that suite key, the one the sealed baseline was recorded with, because
`orch bench compare` refuses runs of different suites; `orch bench history`
and `orch bench baseline set` map `native-parity` to it.
`orch bench run superagent-parity` still works as a deprecated alias.

These are consumption estimates, not subscription invoices. Provider latency
and cache state vary. Response timing covers the case through local delivery;
bank provisioning, asynchronous queue drain and cleanup are outside that
timer, while their Hindsight usage remains in cost. The synthetic profile
matches production sizes, not real personal memory. Fresh banks measure
within-case learning, not recall against a historical corpus. One small CSV
task and two repetitions cannot establish universal quality, cost, or latency
parity, and the fixture's resumed transport is not the continuously open
interactive CLI. Earlier native-control and memory-off exploration results
(archived) are incompatible with this protocol.

### Results of 2026-11-03

Two sealed runs on this host, Claude Code 2.1.317, model `claude-opus-5-5`
observed in every case, Hindsight 1.1.0-slim: run
`65d68374-d439-44c4-9ef4-c291b8e24327` (`--one-pair`) and run
`dd2f6d2e-6c59-4ed2-83d7-ec5ec2bde588` (two pairs, reversed order). Every
case verified and published its three revisions (quality 3/3), every owned
bank was dropped. Cost is the CLI estimate plus Hindsight's own usage at the
conso pricing; seconds cover the case through local delivery.

| Case | Arm | Cost USD | Hindsight USD | Seconds | Output tokens |
| --- | --- | --- | --- | --- | --- |
| one-pair 1 | plain | 0.416 | 0 | 71.6 | 6674 |
| one-pair 1 | kiba-mem-off | 0.357 | 0 | 57.4 | 4708 |
| one-pair 1 | kiba-mem-on | 0.282 | 0.0073 | 74.8 | 5014 |
| pairs 1 | plain | 0.256 | 0 | 85.1 | 5305 |
| pairs 1 | kiba-mem-off | 0.288 | 0 | 68.8 | 6375 |
| pairs 1 | kiba-mem-on | 0.252 | 0.0066 | 63.9 | 4769 |
| pairs 2 | kiba-mem-on | 0.258 | 0.0066 | 59.8 | 4772 |
| pairs 2 | kiba-mem-off | 0.278 | 0 | 69.5 | 6010 |
| pairs 2 | plain | 0.259 | 0 | 63.7 | 5569 |

Means of the two-pair run:

| Arm | Cost USD | Seconds | Output tokens |
| --- | --- | --- | --- |
| plain | 0.258 | 74.4 | 5437 |
| kiba-mem-off | 0.283 | 69.1 | 6193 |
| kiba-mem-on | 0.255 | 61.8 | 4771 |

On this corpus native Kiba with its living memory meets the acceptance
criterion against plain Claude Code: same quality, 1 percent lower estimated
cost (Hindsight included) and 17 percent shorter response in the two-pair
run, and lower cost in the one-pair run too. Memory off is 10 percent more
expensive than plain in the two-pair run and 14 percent cheaper in the
one-pair run: output length (4.7k to 6.7k tokens per case) dominates the
cost, and three repetitions do not separate the arms on that axis. The hooks
injected 4587 bytes at session start and 1610 to 2099 bytes of recall per
prompt in the memory-on cases; Hindsight extracted the three turns of each
case with 6 model calls (about 31k input and 12k output tokens) and 14
embeddings, 0.0066 to 0.0073 USD per case, on the Anthropic and OpenAI API
keys rather than the Claude subscription. Hook wall time per tool call is
25 ms for the guards and 27 ms for an Edit or Write count after the change
of the same day (background summary for every other tool), down from 76 and
174 ms. Limits: one small CSV task, nine cases, fresh banks (within-case
learning only), provider latency and cache state uncontrolled. The two-pair
run is the named baseline `native-parity-1` (stored under the suite key
`superagent-parity`); `bench/superagent/native-parity-1.json` keeps the
sealed summary.
