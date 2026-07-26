# PRD: `.dev-id` worktree auto-allocation

**Status:** Active

## Summary

Allocate the per-checkout `.dev-id` automatically during `just setup`, so a fresh clone or git worktree gets a unique positive integer identity without manual steps. The id is the single source of truth that `ecosystem.config.js` consumes to derive the app-name tag and port block for the local dev stack (see `docs/prd/1_local-dev-launcher.md`). Without an allocator, every contributor had to hand-pick and write the integer themselves; with one, allocation is idempotent, deterministic for the main clone, and safe under concurrent linked worktrees.

## Scope

Workspace-owned; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/alloc-dev-id.sh` | The allocator (workspace-owned). Idempotent; writes `.dev-id` exactly once per checkout with a unique positive integer, using git's worktree metadata to keep concurrent dev checkouts disjoint. Carries a `PRD:` header pointing back at this file. |
| `justfile` | The `setup` recipe invokes the allocator before installing dependencies, so a first-time contributor running `just setup` ends up with a valid `.dev-id` and a working dev stack in one command. |
| `ecosystem.config.js` | Consumed (unchanged). Reads `.dev-id` fresh on every PM2 evaluation and throws on a missing/invalid value for a non-prod checkout; that fail-fast gate is owned by `docs/prd/1_local-dev-launcher.md` FR3 and is not changed here. |
| `.gitignore` | Consumed (unchanged). Already ignores `.dev-id`, so every clone and worktree keeps its own. |

## Functional requirements

- **FR1** — Running `just setup` (or `scripts/alloc-dev-id.sh` directly) is idempotent: if `.dev-id` already exists at the repository root, the allocator exits successfully without modifying it.
- **FR2** — A prod checkout (repository root under `/opt`) receives no `.dev-id`, because the ecosystem fixes id `0` for prod. The allocator skips allocation entirely for prod, so no untracked file is created there.
- **FR3** — For a non-prod checkout that is git's main worktree (the primary checkout, where the per-worktree git dir equals the common git dir), the allocator assigns the constant id `1`, giving the most common setup stable, predictable ports.
- **FR4** — For a non-prod linked git worktree, the allocator scans every worktree returned by `git worktree list` for an existing `.dev-id`, takes the maximum numeric id, and assigns `max + 1`. The search starts at `1`, so linked worktrees always allocate an id of at least `2` and never collide with the main clone's `1`.
- **FR5** — Non-numeric existing `.dev-id` content encountered during the scan is ignored for the max computation; the allocator never writes a non-positive or non-integer id.
- **FR6** — On a fresh allocation, the allocator prints the allocated id and the ports the ecosystem will derive from it, so the contributor can see what was assigned.
- **FR7** — The allocator only depends on git and POSIX shell; it runs in the foreground (no daemon, no background tasks) and writes nothing outside the checkout's repository root.

## Non-functional requirements

- **NFR1** — No upstream code is modified. Allocation is workspace-owned and lives entirely in `scripts/alloc-dev-id.sh`.
- **NFR2** — No credentials, tokens, or `.dev-id` values are committed. The gitignore entry (owned by PRD 1) keeps `.dev-id` per-checkout.
- **NFR3** — Allocation must be safe for concurrent `just setup` runs across distinct worktrees: because each run reads the global worktree list and writes only its own root's `.dev-id` once (idempotent guard first), two near-simultaneous setups in two different unallocated linked worktrees can still race on `max + 1` and pick the same number. This is acknowledged but not prevented — see Decision points; humans rarely set up two worktrees in the same second, and the cost of a clash is a port collision caught at start.
- **NFR4** — The allocator requires a git that supports `git rev-parse --path-format=absolute --git-common-dir` (git 2.31, 2021) and `--absolute-git-dir`.

## Decision points

- **Allocate-in-setup vs. allocate-in-ecosystem.** Allocation belongs in `just setup`, not in `ecosystem.config.js`. The ecosystem's job is to consume `.dev-id` and fail fast when it is missing or invalid (PRD 1 FR3); it must not silently paper over a missing identity by inventing one. Generating the id at evaluation time would also race across concurrent startups and would not persist on disk, breaking the per-checkout contract.
- **Idempotent-exit over re-allocation.** If `.dev-id` exists the allocator leaves it alone, even if its value differs from what a fresh allocation would produce. Re-allocating would silently change a running instance's ports; the contributor is the authority once an id is assigned.
- **Constant `1` for the main worktree vs. scanning.** The main clone is the overwhelmingly common case; pinning it to `1` gives stable ports and removes any dependency on worktree ordering. Linked worktrees scan, because their ids must differ from the main clone and from each other.
- **`max + 1` vs. fill-in of gaps.** Strictly `max + 1` (never reusing a freed id below the current maximum) means gaps left by deleted worktrees are harmless and ids reflect setup order. The accepted downside, documented in the script and assumed away in NFR3, is that deleting the highest-id worktree frees its number for the next allocation, so a still-running instance from a deleted tree could clash with a newly allocated one.
- **Prod skip vs. always-allocate.** Allocating a `.dev-id` under `/opt` would create an untracked file the ecosystem explicitly ignores (prod id is `0`, file not read). Skipping keeps the prod checkout clean and matches PRD 1's role model.
- **No lock file for the race.** A lock or allocation ledger would prevent the concurrent-`setup` race (NFR3) but adds machinery and a cross-worktree coordination file for a near-zero-probability, cheap-to-recover condition. The fail-fast gate at start is the adequate backstop.

## Assumptions (re-check these first when upstream changes)

- The role-from-path contract (PRD 1 FR2): `/opt` means prod, anywhere else means dev. If that convention changes, the allocator's prod skip (`case "$root" in /opt/*`) must be re-examined.
- The id semantics (PRD 1 FR3/FR4): `.dev-id` is a unique positive integer per non-prod checkout; the ecosystem is the authoritative consumer and validator. The allocator must keep producing positive integers.
- Git continues to expose `--absolute-git-dir` and `--path-format=absolute --git-common-dir` with current semantics: the main worktree has equal git-dir and common-dir, a linked worktree has them differ, and `git worktree list --porcelain` prints a `worktree <path>` line per worktree.
- `.dev-id` remains gitignored (PRD 1 / `.gitignore`); if it were ever tracked, the per-checkout contract this allocator serves would break.

## Upstream divergence

None. No upstream code is modified. Allocation is a workspace-only convenience around the workspace-owned per-checkout id contract; upstream has no `.dev-id` concept to diverge from.

## Conflict resolution notes

Preserve the requirements, not the implementation. If git's worktree metadata commands change shape, re-derive main-vs-linked worktree detection from whatever the new git exposes and keep FR3/FR4's allocation rules intact. If PRD 1's role model changes (e.g. prod is no longer `/opt`), update the prod-skip branch and re-check the assumption. The stable invariants are: idempotent-on-existing-file (FR1), constant `1` for the main worktree (FR3), `max + 1` from a `1`-anchored scan for linked worktrees (FR4), and never writing a non-positive id (FR5). Do not silently add an allocator into `ecosystem.config.js` — consumption and allocation must stay separate concerns, owned by PRD 1 and this PRD respectively.

## Status

Active. Depends on the local-dev launcher (`docs/prd/1_local-dev-launcher.md`) for the role/identity contract it feeds; that PRD references this one back from FR3.
