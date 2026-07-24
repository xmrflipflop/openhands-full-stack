# PRD: Workspace task runner

**Status:** Active

## Summary

A single, memorable entry point for workspace-level tasks. Contributors and coding agents should not need to know which script implements which task: `just` lists what the workspace can do and runs it. Recipes either wrap workspace scripts or capture short, repeatable command sequences worth memorising (such as upstream subtree syncs) — they name and record tasks rather than implement logic.

## Scope

Workspace-owned only; no upstream files are modified.

| Path | Role |
| --- | --- |
| `justfile` | Task definitions (repository root) |
| `scripts/` | Where the wrapped implementations live |

## Functional requirements

- **FR1** — Running the task runner with no arguments lists the available tasks; the listing is the authoritative catalogue (documentation points to it rather than duplicating it).
- **FR2** — `dev` starts the local stack, passing all trailing flags through to the launcher unchanged.
- **FR3** — `lint` runs the workspace linters, including the PRD reference check; `test` runs workspace tests; `check` runs both and is the pre-completion gate.
- **FR4** — Every script a recipe wraps remains directly runnable without the task runner; the runner is a convenience, never a dependency.
- **FR5** — Recipes may inline shortcuts: short, linear command sequences for repeatable workflows (e.g. `git subtree` syncs against the upstream remotes). The recipe body itself then serves as the canonical, executable record of that workflow.

## Non-functional requirements

- **NFR1** — Recipes contain invocations or linear command sequences, no logic; anything with branching, parsing, or error handling belongs in `scripts/`.
- **NFR2** — Recipes run from the repository root regardless of the caller's working directory (the runner's default behavior).
- **NFR3** — Workspace-level tasks only: package-level commands stay inside their packages as documented by each package.

## Decision points

- **just vs. make vs. bare scripts.** `just` chosen: recipes take pass-through arguments cleanly (FR2), the tool self-lists (FR1), and there is no build-system semantics to fight (no phony targets, no dependency graph beyond simple recipe chaining like `check: lint test`).
- **Wrappers plus inline shortcuts.** Originally recipes were restricted to thin wrappers over `scripts/`. Relaxed: forcing a linear two-command workflow (like a subtree sync) into a script adds indirection without value, and the recipe body doubles as executable documentation of the workflow. The boundary is logic, not length — the moment a task needs branching, parsing, or error handling, it moves to `scripts/`.

## Assumptions (re-check these first when tasks misbehave)

- `just` is installed on contributor machines and in CI.
- The wrapped scripts keep their command-line interfaces stable, or recipes are updated in the same change (the PRD reference check catches path drift; interface drift is caught by running `check`).

## Upstream divergence

None. The justfile is workspace-owned and wraps only workspace scripts.

## Conflict resolution notes

The stable interface is the task names — `dev`, `lint`, `test`, `check` — and their pass-through behavior, not the justfile text. If the runner or the file format changes, keep those names working and update AGENTS.md and README.md in the same change.
