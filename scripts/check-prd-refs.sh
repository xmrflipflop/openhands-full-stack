#!/usr/bin/env bash
#
# check-prd-refs.sh — fail on drift between docs/prd/ and the repository.
#
# PRD: docs/prd/2_prd-reference-check.md
#
# Checks, in both directions:
#   1. doc -> code: every repository path referenced in a docs/prd/*.md file
#      (backtick-quoted, slash-containing tokens) exists. Retired PRDs are
#      skipped.
#   2. code -> doc: every docs/prd/<slug>.md referenced from a non-doc file
#      exists.
#   3. every WORKSPACE-PATCH marker names its owning PRD on the same line.
#   4. PRD filenames follow <number>_<slug>.md with unique numbers.
#
# Exit 0 when clean, 1 when any reference has drifted. No dependencies
# beyond POSIX tools; compatible with macOS bash 3.2.
#
# Usage: scripts/check-prd-refs.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRD_DIR="$REPO_ROOT/docs/prd"

FAIL=0

note_fail() {
  echo "DRIFT: $1" >&2
  FAIL=1
}

# ── 1. doc -> code ───────────────────────────────────────────────────────────
# A candidate path is a backtick-quoted token (first word), containing at
# least one interior slash, made of plain path characters. This naturally
# excludes URLs (colon), placeholders (<slug>), flags (no slash), route
# prefixes (leading slash), and home paths (~).
if [ -d "$PRD_DIR" ]; then
  for prd in "$PRD_DIR"/*.md; do
    [ -e "$prd" ] || continue
    rel_prd="${prd#"$REPO_ROOT"/}"

    if grep -qiE '\*\*Status:\*\*[[:space:]]*(retired|superseded)' "$prd"; then
      continue
    fi

    candidates="$(grep -o '`[^`]*`' "$prd" | tr -d '\`' | awk '{print $1}' \
      | grep -E '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+/?$' | sort -u)"

    for path in $candidates; do
      [ -e "$REPO_ROOT/$path" ] \
        || note_fail "$rel_prd references missing path: $path"
    done
  done
else
  echo "note: $PRD_DIR does not exist; nothing to check" >&2
fi

# ── 2. code -> doc ───────────────────────────────────────────────────────────
prd_refs="$(grep -rEoh 'docs/prd/[A-Za-z0-9._-]+\.md' "$REPO_ROOT" \
  --exclude-dir=docs --exclude-dir=.git --exclude-dir=node_modules \
  --exclude-dir=build --exclude-dir=dist --exclude='*.md' \
  2>/dev/null | sort -u)"

for ref in $prd_refs; do
  [ -f "$REPO_ROOT/$ref" ] \
    || note_fail "code references missing PRD: $ref"
done

# ── 3. markers must name their PRD ───────────────────────────────────────────
orphan_markers="$(grep -rn 'WORKSPACE-PATCH' "$REPO_ROOT" \
  --exclude-dir=docs --exclude-dir=.git --exclude-dir=node_modules \
  --exclude-dir=build --exclude-dir=dist --exclude='*.md' \
  --exclude='check-prd-refs.sh' 2>/dev/null | grep -v 'docs/prd/' || true)"

if [ -n "$orphan_markers" ]; then
  echo "$orphan_markers" | while IFS= read -r line; do
    echo "DRIFT: WORKSPACE-PATCH marker without a docs/prd/ reference: $line" >&2
  done
  FAIL=1
fi

# ── 4. PRD naming convention: <number>_<slug>.md, unique numbers ────────────
if [ -d "$PRD_DIR" ]; then
  seen_numbers=" "
  for prd in "$PRD_DIR"/*.md; do
    [ -e "$prd" ] || continue
    base="$(basename "$prd")"
    if ! echo "$base" | grep -qE '^[0-9]+_[a-z0-9][a-z0-9-]*\.md$'; then
      note_fail "PRD filename must be <number>_<slug>.md (kebab-case slug): $base"
      continue
    fi
    num="${base%%_*}"
    case "$seen_numbers" in
      *" $num "*) note_fail "duplicate PRD number $num: $base" ;;
    esac
    seen_numbers="$seen_numbers$num "
  done
fi

if [ "$FAIL" = 0 ]; then
  echo "PRD references OK"
fi
exit "$FAIL"
