# PRD: PRD reference check

**Status:** Active

## Summary

PRDs under `docs/prd/` are long-lived requirements documents, but their Scope sections reference repository paths, and code carries markers pointing back at PRDs. Both kinds of reference rot silently when files move. This functionality makes that rot loud: a checker validates every reference in both directions so a rename fails validation at the moment it happens — the only time anyone will actually fix a reference.

## Scope

Workspace-owned only; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/check-prd-refs.sh` | The checker |
| `docs/prd` | Checked: outgoing path references |

## Functional requirements

- **FR1** — Every repository path referenced by an active PRD must exist; a missing path is reported with the referencing PRD and fails the check.
- **FR2** — Retired and superseded PRDs are exempt from FR1: their references describe history, not the present tree.
- **FR3** — Every PRD file referenced from non-documentation files (headers, patch markers) must exist; a dangling reference fails the check.
- **FR4** — Every `WORKSPACE-PATCH` marker must name its owning PRD on the same line; an anonymous marker fails the check.
- **FR5** — The checker reports all findings, not just the first, and exits non-zero on any finding so it can gate CI and the validation step.
- **FR6** — PRD filenames must follow the `<number>_<slug>.md` convention with a kebab-case slug and a unique, never-reused number; a malformed name or duplicate number fails the check.

## Non-functional requirements

- **NFR1** — Runs on the stock macOS shell (bash 3.2) and current Linux bash with only POSIX tools; no interpreter or package installation.
- **NFR2** — Read-only: never modifies files, never fetches anything.
- **NFR3** — Fast enough to run on every commit (excludes dependency and build directories from scanning).

## Decision points

- **Validate vs. generate.** Generating Scope tables from code markers was considered and rejected: generated docs invite nobody to read them, and the Scope table doubles as a human-curated statement of intent. Validation keeps the human text honest at near-zero cost.
- **Path recognition convention.** PRDs mark repository paths with backticks; the checker treats backticked, slash-containing plain tokens as path claims. This excludes URLs, CLI flags, route prefixes, and placeholders without needing an annotation syntax.
- **Both directions.** Checking only doc→code would let code-side markers dangle after a PRD is superseded; checking only code→doc would let Scope tables rot. Both are cheap; both are checked.

## Assumptions (re-check these first when the check misfires)

- PRDs live flat under `docs/prd/`, named `<number>_<slug>.md`, and declare a Status line.
- Repository paths in PRDs are written in backticks; non-path backticked text does not look like a bare relative path.
- Code references PRDs by their full `docs/prd/<number>_<slug>.md` path, and subtree edits are marked `WORKSPACE-PATCH(docs/prd/<number>_<slug>.md)`.
- PRD numbers and slugs are stable identifiers: PRD files are superseded, never renamed, and numbers are never reused.

## Upstream divergence

None. The checker is workspace-owned and scans upstream packages only for workspace-added markers.

## Conflict resolution notes

If conventions change (PRD location, marker syntax, path-marking style), update the recognition rules to match — the requirement that every cross-reference between `docs/prd` and the tree is mechanically verified in both directions must survive any such change.
