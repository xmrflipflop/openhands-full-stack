# PRD: `.dev-id` worktree auto-allocation

**Status:** Active

## Summary

Allocate the per-checkout `.dev-id` automatically during `just setup`, so a fresh clone or git worktree gets a unique positive integer identity without manual steps. The id is the single source of truth that `scripts/launch-stack.js` reads to derive the app-name tag (`dev-<id>` / `prod-<id>`) and port block for the local stack, which it hands to `ecosystem.config.js` (see `docs/prd/1_local-dev-launcher.md`). Without an allocator, every contributor had to hand-pick and write the integer themselves; with one, allocation is idempotent and safe under concurrent checkouts and linked worktrees.

## Scope

Workspace-owned; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/alloc-dev-id.sh` | The allocator (workspace-owned). Idempotent; writes `.dev-id` exactly once per checkout with a unique positive integer, using a stable path hash for independent checkouts and git's worktree metadata for linked worktrees. Carries a `PRD:` header pointing back at this file. |
| `justfile` | The `setup` recipe invokes the allocator before installing dependencies, so a first-time contributor running `just setup` ends up with a valid `.dev-id` and a working stack in one command. |
| `scripts/launch-stack.js` | Consumed (unchanged). Reads and validates `.dev-id` and derives the tag and port block from it; the fail-fast gate for a missing/invalid `.dev-id` is owned by `docs/prd/1_local-dev-launcher.md` FR3 and is not changed here. |
| `ecosystem.config.js` | Consumed (unchanged). It no longer reads `.dev-id` directly; it reads the `STACK_*` env vars the launcher sets. Its only identity assumption is that the launcher has already resolved and validated the id. |
| `.gitignore` | Consumed (unchanged). Already ignores `.dev-id`, so every clone and worktree keeps its own. |

## Functional requirements

- **FR1** — Running `just setup` (or `scripts/alloc-dev-id.sh` directly) is idempotent: if `.dev-id` already exists at the repository root, the allocator exits successfully without modifying it.
- **FR2** — Every checkout receives a `.dev-id`, production included. Production is no longer exempt: the launcher embeds the id in the app-name tag (`prod-<id>`) and port block regardless of mode, so a production checkout needs an id just as a development checkout does. The allocator therefore always allocates; it does not skip any checkout path. (Previously a checkout under `/opt` was skipped because the old ecosystem fixed id `0` for production — that path-based role model has been replaced; see `docs/prd/1_local-dev-launcher.md` FR3/FR4/FR13.)
- **FR3** — For a checkout that is git's main worktree (an independent clone, where the per-worktree git dir equals the common git dir), the allocator assigns a stable id in the range 1–999 derived from a cryptographic hash (sha256 when available, else cksum) of the absolute repository path. This ensures the same checkout always gets the same id, while different independent checkouts get different ids with low collision probability (~4.4% at 10 checkouts).
- **FR4** — For a linked git worktree, the allocator scans every worktree returned by `git worktree list` for an existing `.dev-id`, takes the maximum numeric id, and assigns `max + 1`. The search starts at `1`, so linked worktrees always allocate an id of at least `2` and never collide with independently allocated main worktrees (which also occupy 1–999).
- **FR5** — Non-numeric existing `.dev-id` content encountered during the scan is ignored for the max computation; the allocator never writes a non-positive or non-integer id.
- **FR6** — On a fresh allocation, the allocator prints the allocated id. It does not print derived ports (the launcher owns the port-block formula and resolves it; reporting it here would duplicate and could drift).
- **FR7** — The allocator only depends on git and POSIX shell (plus optional `sha256sum` for better distribution); it runs in the foreground (no daemon, no background tasks) and writes nothing outside the checkout's repository root.

## Non-functional requirements

- **NFR1** — No upstream code is modified. Allocation is workspace-owned and lives entirely in `scripts/alloc-dev-id.sh`.
- **NFR2** — No credentials, tokens, or `.dev-id` values are committed. The gitignore entry (owned by PRD 1) keeps `.dev-id` per-checkout.
- **NFR3** — Allocation must be safe for concurrent `just setup` runs across distinct worktrees: because each run reads the global worktree list and writes only its own root's `.dev-id` once (idempotent guard first), two near-simultaneous setups in two different unallocated linked worktrees can still race on `max + 1` and pick the same number. This is acknowledged but not prevented — see Decision points; humans rarely set up two worktrees in the same second, and the cost of a clash is a port collision caught at start.
- **NFR4** — The allocator requires a git that supports `git rev-parse --path-format=absolute --git-common-dir` (git 2.31, 2021) and `--absolute-git-dir`.

## Decision points

- **Allocate-in-setup vs. allocate-at-launch.** Allocation belongs in `just setup`, not at launch time. The launcher's job is to consume `.dev-id` and fail fast when it is missing or invalid (PRD 1 FR3); it must not silently paper over a missing identity by inventing one. Generating the id at launch time would also race across concurrent startups and would not persist on disk, breaking the per-checkout contract.
- **Idempotent-exit over re-allocation.** If `.dev-id` exists the allocator leaves it alone, even if its value differs from what a fresh allocation would produce. Re-allocating would silently change a running instance's ports; the contributor is the authority once an id is assigned.
- **Path-hash for main worktrees vs. constant 1.** The previous version assigned constant `1` to the main worktree for stable, predictable ports. The new version uses a stable path-hash (1–999) for all independent checkouts, giving each a stable but not globally predictable id. This avoids collisions between independent clones (which are not git worktrees of each other) while keeping the same-checkout-stable-id property. The trade-off is that the "first" clone no longer gets a known low port block; users who need predictable ports can manually write `.dev-id`.
- **`max + 1` vs. fill-in of gaps.** Strictly `max + 1` (never reusing a freed id below the current maximum) means gaps left by deleted worktrees are harmless and ids reflect setup order. The accepted downside, documented in the script and assumed away in NFR3, is that deleting the highest-id worktree frees its number for the next allocation, so a still-running instance from a deleted tree could clash with a newly allocated one.
- **Always-allocate vs. prod skip (reversed).** An earlier form skipped allocation for a prod checkout under `/opt` because the old ecosystem fixed id `0` for prod and never read the file. The new launcher embeds the id in the tag (`prod-<id>`) and port block regardless of mode, so a production checkout needs an id too (PRD 1 FR3). Always allocating keeps a single rule for every checkout and removes the path-based role model; the accepted cost is that a prod checkout now carries a gitignored `.dev-id` (already covered by `.gitignore`).
- **No lock file for the race.** A lock or allocation ledger would prevent the concurrent-`setup` race (NFR3) but adds machinery and a cross-worktree coordination file for a near-zero-probability, cheap-to-recover condition. The fail-fast gate at start is the adequate backstop.

## Assumptions (re-check these first when upstream changes)

- The id semantics (PRD 1 FR3/FR4): `.dev-id` is a unique positive integer per checkout — production included — and the launcher is the authoritative consumer and validator. The allocator must keep producing positive integers.
- Git continues to expose `--absolute-git-dir` and `--path-format=absolute --git-common-dir` with current semantics: the main worktree has equal git-dir and common-dir, a linked worktree has them differ, and `git worktree list --porcelain` prints a `worktree <path>` line per worktree.
- `.dev-id` remains gitignored (PRD 1 / `.gitignore`); if it were ever tracked, the per-checkout contract this allocator serves would break.

## Upstream divergence

None. No upstream code is modified. Allocation is a workspace-only convenience around the workspace-owned per-checkout id contract; upstream has no `.dev-id` concept to diverge from.

## Conflict resolution notes

Preserve the requirements, not the implementation. If git's worktree metadata commands change shape, re-derive main-vs-linked worktree detection from whatever the new git exposes and keep FR3/FR4's allocation rules intact. The stable invariants are: idempotent-on-existing-file (FR1), always-allocation for every checkout including production (FR2), path-hash 1–999 for main worktrees (FR3), `max + 1` from a `1`-anchored scan for linked worktrees (FR4), and never writing a non-positive id (FR5). Do not silently add an allocator into the launcher or the ecosystem — allocation and resolution/consumption must stay separate concerns, owned by this PRD and PRD 1 respectively.

## Status

Active. Depends on the local-dev launcher (`docs/prd/1_local-dev-launcher.md`) for the role/identity contract it feeds; that PRD references this one back from FR3.
