# Agent Instructions

## Purpose

This repository is an integration workspace for two canonical OpenHands projects, imported as Git subtrees.

| Local path | Canonical upstream | Git remote |
| --- | --- | --- |
| `packages/agent-canvas` | `https://github.com/OpenHands/agent-canvas.git` | `agent-canvas` |
| `packages/software-agent-sdk` | `https://github.com/OpenHands/software-agent-sdk.git` | `software-agent-sdk` |

- `packages/agent-canvas` contains the self-hostable Agent Canvas application.
- `packages/software-agent-sdk` contains the shared Software Agent SDK.
- This parent repository owns configuration and code that integrates both packages.

## Layout

```text
.
├── AGENTS.md
├── README.md
├── .github/
│   └── workflows/                 # Workspace CI/CD workflows
├── packages/
│   ├── agent-canvas/              # Git subtree: OpenHands/agent-canvas
│   └── software-agent-sdk/        # Git subtree: OpenHands/software-agent-sdk
├── docker/
│   ├── Dockerfile                 # Optional combined workspace image
│   └── compose.yaml               # Optional combined local-service configuration
├── docs/                          # Workspace documentation
│   └── prd/                       # One PRD per workspace functionality
├── infra/                         # Deployment and infrastructure definitions
└── scripts/                       # Development and maintenance scripts
```

## Ownership

| Path | Ownership and purpose |
| --- | --- |
| `packages/agent-canvas/` | Imported Git subtree from `OpenHands/agent-canvas` |
| `packages/software-agent-sdk/` | Imported Git subtree from `OpenHands/software-agent-sdk` |
| `docker/Dockerfile` | Workspace container image definition |
| `docker/compose.yaml` | Workspace local-service orchestration |
| `scripts/` | Repeatable development, CI, and maintenance commands |
| `scripts/dev-local.sh` | Workspace-owned local full-stack launcher (see Local development launcher) |
| `infra/` | Deployment and infrastructure configuration |
| `docs/` | Documentation for this combined workspace |
| `docs/prd/` | One PRD per workspace functionality: requirements, decisions, assumptions, upstream divergence |
| `.github/workflows/` | Workspace-level CI/CD workflows |

## Working rules

- Read the nearest `AGENTS.md`, `README.md`, and relevant configuration files before modifying code.
- Treat both directories under `packages/` as imported upstream projects. Preserve their layout, conventions, and local tooling.
- Follow the Modular and additive changes section below for every change. Its ordering of preferred approaches is mandatory, not advisory.
- Do not use `git submodule` commands. This repository uses Git subtrees.
- Do not rename, move, delete, or re-nest `packages/agent-canvas` or `packages/software-agent-sdk` without explicit instruction.
- Keep workspace-specific integration code and configuration outside `packages/` where possible.
- Prefer contributing reusable changes to the appropriate canonical OpenHands repository, then importing them through a subtree update.
- Do not mix subtree updates with unrelated features, formatting, dependency upgrades, or refactors.
- Do not commit credentials, tokens, private keys, `.env` files, local databases, generated build output, or Docker volumes.

## Modular and additive changes

The overriding goal of this workspace: keep `packages/agent-canvas` and `packages/software-agent-sdk` as close to their upstreams as possible, so that `git subtree pull` (and any rebase of workspace history) stays small and mechanical. Every line changed inside `packages/` is merge debt that must be reconciled again on every upstream sync. Preserve the existing architecture and design of both packages; extend them, do not reshape them.

### Preferred approaches, in order

When adding or changing functionality, use the first workable option:

1. **Workspace-owned code.** Put integration code, launchers, glue, wrappers, and configuration in workspace directories (`scripts/`, `docker/`, `infra/`, `docs/`, `.github/`). Code outside `packages/` can never conflict with an upstream merge.
2. **Upstream extension points.** Configure rather than patch. Both packages expose deliberate seams: environment variables (`OH_AGENT_SERVER_LOCAL_PATH`, `VITE_BACKEND_HOST`, `OH_SESSION_API_KEYS_0`, ...), CLI flags (`--host`, `--port`), config files (`packages/agent-canvas/config/defaults.json`), and documented plugin, hook, and adapter APIs. Drive them from workspace-owned scripts or env files.
3. **Additive files inside a package.** If code must live inside a package, add new files or modules rather than editing existing ones, and keep the import surface into upstream files as small as possible. New files rarely conflict on merge; edited ones almost always do.
4. **Surgical edits to upstream files (last resort).** Keep the edit minimal and isolated to the fewest possible lines. Mark every such edit with a `WORKSPACE-PATCH(docs/prd/<number>_<slug>.md):` comment pointing at the PRD that owns it, so conflicting code can be traced back to its requirements without searching.

### Rules that keep upstream merges cheap

- Do not reformat, re-lint, reorder imports, rename symbols, or apply style-only or "cleanup" changes inside `packages/`. Noise diffs turn subtree pulls into conflict storms.
- Do not rename, move, or delete upstream files or directories. Wrap or extend instead.
- Do not change upstream public APIs, shared types, or module boundaries. Add adapters in workspace code or in new package files.
- Do not copy upstream logic into the workspace to avoid patching it. A silently diverging fork of the logic is worse than a small, marked patch.
- Do not pin, upgrade, or add dependencies inside a package unless the change is itself intended for upstream. Workspace-only dependency needs belong in workspace-owned tooling.
- One concern per commit. Never mix workspace changes with changes inside `packages/`, and never mix changes to both packages, in a single commit.
- If a change is useful beyond this workspace, contribute it to the canonical repository (see Fork workflow), adopt it back via a subtree update, then delete the local patch and mark its PRD retired.

### Document every functionality as a PRD under `docs/prd/`

Every workspace functionality — anything this repository adds on top of the upstream packages, and especially anything that modifies code inside `packages/` — must have its own PRD file at `docs/prd/<number>_<slug>.md`. One functionality per file (e.g. `docs/prd/1_local-dev-launcher.md`); do not batch unrelated changes into a shared document. Create or update the PRD in the same change that introduces or alters the functionality.

Write PRDs from a requirements perspective, at a level high enough to survive refactors and upstream churn. Describe intent, behavior, and constraints. Never include line numbers, diffs, or code snippets — file paths and module names are the finest granularity allowed; anything finer goes stale with the next code change.

Each PRD must contain:

- **Summary** — what the functionality is and why the workspace needs it.
- **Scope** — the files and directories involved, at path level, separating workspace-owned files from any upstream files modified.
- **Functional requirements** — what the functionality must do, as numbered, testable statements.
- **Non-functional requirements** — portability, security, performance, and compatibility constraints.
- **Decision points** — the alternatives considered and why the chosen approach won.
- **Assumptions** — the upstream behaviors, interfaces, and conventions the functionality relies on. These are the tripwires to re-check first whenever upstream changes.
- **Upstream divergence** — how behavior or code differs from upstream, why the change cannot live upstream (or the status of an upstream PR), and what would allow the divergence to be retired.
- **Conflict resolution notes** — what must be preserved versus what may be reimplemented differently if upstream changes force a rework.
- **Status** — active, superseded (naming the successor PRD), or retired (absorbed upstream or removed).

When a `git subtree pull` or rebase conflicts, resolve from requirements, not from the old diff: find the PRDs whose Scope covers the conflicting paths, re-check their Assumptions against the new upstream code, and re-apply the Functional requirements on top of it. The previous implementation is disposable; the requirements are not. After resolving, update the PRD if decisions or assumptions changed.

## Package development

Each imported package owns its dependency management, build process, formatting, linting, type checking, tests, and release process. Do not assume a single root-level package manager or test command.

### Agent Canvas

Read the package documentation before making changes:

```bash
cat packages/agent-canvas/README.md
cat packages/agent-canvas/docs/DEVELOPMENT.md
```

Run its documented development commands from its package directory:

```bash
cd packages/agent-canvas
npm install
npm run dev
```

### Software Agent SDK

Read the SDK documentation before changing code, installing dependencies, or running tests:

```bash
cat packages/software-agent-sdk/README.md
```

Run the SDK's documented setup, format, lint, type-check, and test commands from within `packages/software-agent-sdk`.

## Local development launcher

`scripts/dev-local.sh` starts the full stack strictly from the code in this repository:

- **Backend** — the OpenHands Agent Server, run with `uv run` over the local uv workspace in `packages/software-agent-sdk`. Workspace sources only; it never installs `openhands-*` releases from PyPI.
- **Frontend** — the Agent Canvas Vite dev server from `packages/agent-canvas` (`npm run dev:frontend`), proxying `/api` to the local backend.

Each service runs in its own process group. If any service exits — crash or clean — the launcher stops everything else and exits with that service's status.

```sh
scripts/dev-local.sh                  # frontend + backend
scripts/dev-local.sh --frontend-only  # Vite dev server only
scripts/dev-local.sh --backend-only   # local agent-server only
scripts/dev-local.sh --help           # all options
```

The flag surface mirrors the upstream `agent-canvas` CLI (`--frontend-only`, `--backend-only`, `-p/--port`), but unlike upstream it never fetches the agent-server via `uvx` from PyPI and never installs the published `@openhands/agent-canvas` package. The OpenHands Automation backend is intentionally not started: that project is not vendored in this repository. Do not "fix" the launcher by pointing it at upstream releases; it exists to exercise the local subtrees.

The launcher's requirements live in `docs/prd/1_local-dev-launcher.md`, which also serves as the reference example of the PRD format described in Modular and additive changes.

## Validation

Before declaring work complete:

1. Identify the affected layer: workspace integration, Agent Canvas, Software Agent SDK, Docker/Compose, or multiple packages.
2. Run the narrowest relevant formatter, linter, type check, build, and test command documented by the affected package.
3. For subtree updates, validate the updated package and any affected workspace integration.
4. Confirm the change follows the Modular and additive changes rules and that its PRD under `docs/prd/` is created or updated in the same change.
5. Report the commands run, their results, and checks that could not be run.

## Subtree maintenance

Keep the remote names and local prefixes stable.

| Upstream | Remote | Local prefix |
| --- | --- | --- |
| `OpenHands/agent-canvas` | `agent-canvas` | `packages/agent-canvas` |
| `OpenHands/software-agent-sdk` | `software-agent-sdk` | `packages/software-agent-sdk` |

Verify remotes:

```bash
git remote -v
```

Confirm upstream default branches before pulling updates:

```bash
git ls-remote --symref agent-canvas HEAD
git ls-remote --symref software-agent-sdk HEAD
```

Pull canonical upstream changes with the matching prefix:

```bash
git fetch agent-canvas
git subtree pull \
  --prefix=packages/agent-canvas \
  agent-canvas main

git fetch software-agent-sdk
git subtree pull \
  --prefix=packages/software-agent-sdk \
  software-agent-sdk main
```

After updating a subtree:

1. Inspect the complete diff and resolve merge conflicts carefully.
2. Review relevant upstream changelogs, release notes, and migration instructions.
3. Find the PRDs under `docs/prd/` whose Scope covers the paths the pull touched; re-check their Assumptions and re-apply their requirements on the new upstream code (see Modular and additive changes). Retire PRDs whose functionality upstream has absorbed.
4. Run the affected package's validation commands and workspace integration checks.
5. Commit the subtree update separately from all other work.

Example:

```text
chore: update agent-canvas subtree
```

## Fork workflow

If changes within a subtree should be submitted upstream, use a personal fork rather than pushing to a canonical OpenHands remote.

Optional fork remotes:

```bash
git remote add agent-canvas-fork \
  https://github.com/xmrflipflop/agent-canvas.git

git remote add software-agent-sdk-fork \
  https://github.com/xmrflipflop/software-agent-sdk.git
```

Pull normal updates from the canonical `agent-canvas` and `software-agent-sdk` remotes. Push a split subtree to a personal fork only when intentionally preparing an upstream contribution.

## Commit messages

Use small, focused commits with a clear scope:

```text
canvas: configure a local development endpoint
sdk: update client integration
docker: add workspace development image
infra: configure a deployment environment
docs: document workspace startup
chore: update software-agent-sdk subtree
```
