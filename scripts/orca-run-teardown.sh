#!/usr/bin/env bash
# Close an Orca orchestration Run once its results are integrated.
#
# For every worktree a Run's dispatches used: stop what still runs inside it
# (setup terminals, agent processes), remove the worktree from Orca and git,
# then delete its branch when that branch is merged into --into. A worktree
# that is dirty, or whose branch is not merged into --into, is kept and
# reported: nothing unmerged is ever deleted. Ends with a residue check and a
# non-zero exit when anything of the Run is still alive.
#
# Usage: orca-run-teardown.sh --run <run_id> --into <git-ref> [--dry-run]
#   --into   the ref that carries the integrated result (an integration
#            branch or the feature branch), checked with merge-base.
#   --dry-run print the plan, change nothing.
#
# Orca's worker-release closes the agent terminal only; setup terminals and
# worktrees survive it. This script is the missing end of the Run lifecycle.
set -euo pipefail

RUN="" INTO="" DRY=0
while (($#)); do
    case "$1" in
        --run) RUN="${2:-}"; shift 2 ;;
        --into) INTO="${2:-}"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done
[[ "$RUN" =~ ^run_[a-z0-9]+$ ]] || { printf 'usage: --run run_<id> --into <ref> [--dry-run]\n' >&2; exit 2; }
[[ -n "$INTO" && "$INTO" != -* ]] || { printf -- '--into <git-ref> is required\n' >&2; exit 2; }
command -v orca >/dev/null || { printf 'orca CLI not found\n' >&2; exit 2; }
command -v jq >/dev/null || { printf 'jq not found\n' >&2; exit 2; }

say() { printf '[teardown] %s\n' "$*"; }
run() { if ((DRY)); then say "dry-run: $*"; else "$@" 2> >(grep -v '^\[relay-connect\]' >&2); fi; }
orca_json() { orca "$@" --json 2>/dev/null | grep -v '^\[relay-connect\]'; }

# Processes whose working directory is inside a path (agents, shells, servers).
procs_in() {
    local root="$1" pid cwd
    for pid in $(ls /proc | grep -E '^[0-9]+$'); do
        cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$root" || "$cwd" == "$root/"* ]] && [[ "$pid" != "$$" ]] && printf '%s\n' "$pid"
    done
}

workers="$(orca_json orchestration worker-list --run "$RUN")"
[[ "$(jq -r '.ok' <<<"$workers")" == "true" ]] || { printf 'worker-list failed for %s\n' "$RUN" >&2; exit 1; }

# 1. Every dispatch must be settled: a live worker still owns its worktree.
live="$(jq -r '.result.workers[] | select(.dispatchStatus as $s | ["completed","failed","cancelled"] | index($s) | not) | .dispatchId' <<<"$workers")"
if [[ -n "$live" ]]; then
    printf 'Run %s still has unsettled dispatches, settle or stop them first:\n%s\n' "$RUN" "$live" >&2
    exit 1
fi
# Settled but unreleased agent terminals are released first (accepted settlement only).
for dispatch in $(jq -r '.result.workers[] | select(.terminalState == "reclaimable") | .dispatchId' <<<"$workers"); do
    run orca orchestration worker-release --dispatch "$dispatch" --json >/dev/null
    say "released agent terminal of $dispatch"
done

mapfile -t paths < <(jq -r '[.result.workers[].resource.worktreeId // empty | split("::")[1]] | unique[]' <<<"$workers")
((${#paths[@]})) || { say "no worktree recorded for $RUN"; exit 0; }

kept=() removed=()
for path in "${paths[@]}"; do
    if [[ ! -d "$path" ]]; then say "already gone: $path"; removed+=("$path"); continue; fi
    branch="$(git -C "$path" branch --show-current)"
    common="$(git -C "$path" rev-parse --path-format=absolute --git-common-dir)"
    if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
        say "KEEP (uncommitted changes): $path"; kept+=("$path"); continue
    fi
    if [[ -n "$branch" ]] && ! git -C "$path" merge-base --is-ancestor "$branch" "$INTO" 2>/dev/null; then
        say "KEEP (branch $branch not merged into $INTO): $path"; kept+=("$path"); continue
    fi

    # 2. Stop everything that still lives in the worktree.
    run orca terminal close --worktree "path:$path" --all --json >/dev/null || true
    mapfile -t pids < <(procs_in "$path")
    if ((${#pids[@]})); then
        say "terminating ${#pids[@]} process(es) in $path: ${pids[*]}"
        run kill -TERM "${pids[@]}" 2>/dev/null || true
        ((DRY)) || sleep 3
        mapfile -t pids < <(procs_in "$path")
        ((${#pids[@]})) && run kill -KILL "${pids[@]}" 2>/dev/null || true
    fi

    # 3. Remove the worktree, then its merged branch (Orca keeps branches it
    #    cannot prove merged into its base; --into is the proof here).
    if ! run orca worktree rm --worktree "path:$path" --json >/dev/null; then
        say "orca worktree rm failed, falling back to git: $path"
        run git --git-dir="$common" worktree remove "$path"
    fi
    if [[ -n "$branch" ]] && git --git-dir="$common" show-ref --verify --quiet "refs/heads/$branch"; then
        run git --git-dir="$common" branch -D "$branch" >/dev/null
        say "deleted merged branch $branch"
    fi
    run git --git-dir="$common" worktree prune
    removed+=("$path")
done

# 4. Residue check: no directory, terminal or process of a removed worktree.
residue=0
((DRY)) && { say "dry-run: residue check skipped"; exit 0; }
terminals="$(orca_json terminal list)"
for path in "${removed[@]}"; do
    [[ -d "$path" ]] && { say "RESIDUE directory: $path"; residue=1; }
    left="$(jq -r --arg p "$path" '.result.terminals[]? | select((.cwd // "") | startswith($p)) | .handle' <<<"$terminals")"
    [[ -n "$left" ]] && { say "RESIDUE terminal(s) in $path: $left"; residue=1; }
    [[ -n "$(procs_in "$path")" ]] && { say "RESIDUE process(es) in $path"; residue=1; }
done
say "run $RUN: ${#removed[@]} worktree(s) closed, ${#kept[@]} kept${kept:+ (${kept[*]})}"
exit "$residue"
