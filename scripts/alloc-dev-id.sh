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
#   - Main worktree (independent checkout): id = sha256(path) % 999 + 1 (range 1-999),
#     stable per checkout, low collision (~4.4% at 10 checkouts).
#   - Linked git worktree: id = max(.dev-id across all worktrees) + 1, starting
#     the search at 1 so linked worktrees always allocate at >= 2.
#   - No /opt skip: every checkout — production included — carries a `.dev-id`,
#     because the launcher embeds the id in the tag and port block regardless of
#     mode (PRD 1 FR3: production is no longer exempt; PRD 5 FR2).
#
# Properties: main worktree ids are deterministic from path hash; linked
# worktree ids reflect setup order (strict max+1, never fill-in). Gaps left by
# deleted worktrees are harmless. Deleting the highest-id worktree frees its
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
  # Main worktree (independent checkout): allocate stable ID from path hash.
  # Range 1-999 keeps ports well under 65535 (backend max ~27990) and
  # gives ~4.4% collision probability at 10 checkouts (fail-fast at startup).
  abs_path=$(realpath "$root")
  if command -v sha256sum >/dev/null; then
    # sha256 gives better bit distribution than cksum
    hash_val=$(echo -n "$abs_path" | sha256sum | cut -d' ' -f1 | head -c 8)
    id=$(( (0x$hash_val % 999) + 1 ))
  else
    # Fallback: cksum (POSIX, always available)
    id=$(( ($(echo -n "$abs_path" | cksum | cut -d' ' -f1) % 999) + 1 ))
  fi
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
