#!/usr/bin/env bash
#
# alloc-dev-id.sh — allocate a per-checkout `.dev-id` for the local stack.
#
# PRD: docs/prd/5_devid-worktree-allocation.md
#
# Idempotent: if `.dev-id` already exists at the repo root, do nothing.
# Otherwise allocate a unique positive integer so concurrent checkouts
# (including git worktrees) get distinct app-name tags and port blocks
# (consumed by scripts/launch-stack.js → ecosystem.config.js; see
# docs/prd/1_local-dev-launcher.md FR3/FR5).
#
# Allocation rules (see the PRD's functional requirements for the rationale):
#   - Main worktree: id 1 (deterministic, stable ports).
#   - Linked git worktree: id = max(.dev-id across all worktrees) + 1, starting
#     the search at 1 so linked worktrees always allocate at >= 2.
#   - No /opt skip: every checkout — production included — carries a `.dev-id`,
#     because the launcher embeds the id in the tag and port block regardless of
#     mode (PRD 1 FR3: production is no longer exempt; PRD 5 FR2).
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

# Already allocated — nothing to do. The launcher validates the contents;
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
echo "dev-id $id allocated (the launcher derives ports and tag from it; see docs/prd/1_local-dev-launcher.md)"
