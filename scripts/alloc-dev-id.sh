#!/usr/bin/env bash
#
# alloc-dev-id.sh — allocate a per-checkout `.dev-id` for the dev stack.
#
# PRD: docs/prd/5_devid-worktree-allocation.md
#
# Idempotent: if `.dev-id` already exists at the repo root, do nothing.
# Otherwise allocate a unique positive integer so concurrent dev checkouts
# (including git worktrees) get distinct app-name tags and port blocks
# (consumed by ecosystem.config.js; see docs/prd/1_local-dev-launcher.md FR3).
#
# Allocation rules (see the PRD's functional requirements for the rationale):
#   - Prod checkout (repo under /opt): .dev-id is not needed (the ecosystem
#     fixes id 0 for prod). Skip without writing.
#   - Main worktree of a non-prod checkout: id 1 (deterministic, stable ports).
#   - Linked git worktree: id = max(.dev-id across all worktrees) + 1, starting
#     the search at 1 so linked worktrees always allocate at >= 2.
#
# Properties: ids are handed out in setup order; the main clone is
# deterministic; gaps left by deleted worktrees are harmless because allocation
# is strictly max+1 (never fill-in). Deleting the highest-id worktree frees its
# number for the next allocation, so a still-running instance from a deleted
# tree could clash with a newly allocated one — see the PRD's caveats.
#
# Usage: scripts/alloc-dev-id.sh   (run by `just setup`, also runnable directly)

set -euo pipefail

root="$(git rev-parse --show-toplevel)"

# Prod checkouts do not carry a .dev-id (role is prod, id 0). See FR2/FR3 of
# PRD 1 (role from path; .dev-id only for non-prod).
case "$root" in
  /opt/*) exit 0 ;;
esac

# Already allocated — nothing to do. The ecosystem validates the contents;
# this script only ensures a value exists.
[ -f "$root/.dev-id" ] && exit 0

git_dir=$(git rev-parse --absolute-git-dir)
common=$(git rev-parse --path-format=absolute --git-common-dir)

if [ "$git_dir" = "$common" ]; then
  # Main worktree (the primary checkout, not a linked worktree): id 1.
  id=1
else
  # Linked worktree: scan every worktree's .dev-id, allocate max+1.
  max=1 # start at 1 so linked worktrees begin at 2 (main holds 1)
  while read -r _ wt_path; do
    [ -f "$wt_path/.dev-id" ] || continue
    n=$(cat "$wt_path/.dev-id")
    # Only honour numeric values; ignore stray non-numeric content.
    case "$n" in
      ''|*[!0-9]*) continue ;;
    esac
    [ "$n" -gt "$max" ] && max=$n
  done < <(git worktree list --porcelain | grep '^worktree ')

  id=$((max + 1))
fi

printf '%s\n' "$id" > "$root/.dev-id"
echo "dev-id $id -> backend :$((18000 + id * 10)), frontend :$((3000 + id * 10)), ingress :$((9000 + id * 10))"
