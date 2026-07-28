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
- **FR2** — `serve` starts the local stack, passing all trailing flags through to the launcher (`scripts/launch-stack.js`) unchanged. `just serve` is a thin wrapper over the launcher; it is not a supervisor and exposes no process-management verbs of its own. (Replaced an earlier `dev` recipe, removed — not aliased.)
- **FR2a** — `setup` bootstraps the dependencies the stack expects (allocates the per-checkout `.dev-id` for every checkout — production included — runs `uv sync` for the SDK and `npm install` for the frontend). It additionally accepts a `--production` flag (`[arg("production", value="true")] setup production="false"`) that, when set, builds the Agent Canvas production bundle (the artifact the production launcher serves); without it the build is skipped so dev-mode checkouts pay no build cost. This is the one workspace task that is aware of mode: it produces the artifact consumed by the production serving path (`docs/prd/1_local-dev-launcher.md` FR8 prod, FR8c). The flag is named `--production` to match the launcher's and `just serve`'s `--production`, so the surface is uniform. It is the only flag `setup` honours; other arguments are ignored.
- **FR3** — `lint` runs the workspace linters, including the PRD reference check; `test` runs workspace tests; `check` runs both and is the pre-completion gate.
- **FR4** — Every script a recipe wraps remains directly runnable without the task runner; the runner is a convenience, never a dependency.
- **FR5** — Recipes may inline shortcuts: short, linear command sequences for repeatable workflows (e.g. `git subtree` syncs against the upstream remotes). The recipe body itself then serves as the canonical, executable record of that workflow.

## Non-functional requirements

- **NFR1** — Recipes contain invocations or linear command sequences, no logic; anything with branching, parsing, or error handling belongs in `scripts/`.
- **NFR2** — Recipes run from the repository root regardless of the caller's working directory (the runner's default behavior).
- **NFR3** — Workspace-level tasks only: package-level commands stay inside their packages as documented by each package.

## Decision points

- **just vs. make vs. bare scripts.** `just` chosen: recipes take pass-through arguments cleanly (FR2), the tool self-lists (FR1), and there is no build-system semantics to fight (no phony targets, no dependency graph beyond simple recipe chaining like `check: lint test`).
- **Wrappers plus inline shortcuts.** Originally recipes were restricted to thin wrappers over `scripts/`. Relaxed: forcing a linear two-command workflow (like a subtree sync) into a script adds indirection without value, and the recipe body doubles as executable documentation of the workflow. The boundary is logic, not length — the moment a task needs branching, parsing, or error handling, it moves to `scripts/`. (`serve` is such a wrapper: it forwards unchanged to `scripts/launch-stack.js`, where all the logic lives.)
- **`setup --production` via a recipe flag, not a wrapper script.** The `--production` build trigger is a single mode-aware step, implemented with `just`'s `[arg("production", value="true")]` attribute on the `setup` recipe and a one-line `if`/`else` conditional in the recipe body. The alternative — a wrapper script under `scripts/` that parses `--production` and runs the same bootstrap+build — was rejected: the logic is one linear conditional over an already-parsed value (no arg parsing of our own, no error handling), so a script would add indirection without adding a separately-runnable capability worth keeping. The `just` attribute keeps the recipe the single source of the workflow while staying within NFR1's "linear command sequence" allowance (the conditional is the exception the inline-shortcut relaxation already grants). The flag is spelled `--production` to match the launcher's and `just serve`'s `--production`. If the build step ever grows real logic (version checks, artifact validation, multiple targets), it moves to `scripts/` per NFR1.

## Assumptions (re-check these first when tasks misbehave)

- `just` is installed on contributor machines and in CI. The `setup` recipe uses the `[arg(...)]` attribute (`just` 1.27+, 2024) for the `--production` flag; re-check the pinned/minimum `just` version if a contributor's `just` rejects the attribute.
- The wrapped scripts keep their command-line interfaces stable, or recipes are updated in the same change (the PRD reference check catches path drift; interface drift is caught by running `check`).

## Upstream divergence

None. The justfile is workspace-owned and wraps only workspace scripts.

## Conflict resolution notes

The stable interface is the task names — `serve`, `setup`, `lint`, `test`, `check` — and their pass-through/flag behavior (`serve` passes trailing flags to the launcher; `setup` accepts `--production`). Not the justfile text. If the runner or the file format changes, keep those names working and update AGENTS.md and README.md in the same change.
