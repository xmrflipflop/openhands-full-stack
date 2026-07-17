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
| `infra/` | Deployment and infrastructure configuration |
| `docs/` | Documentation for this combined workspace |
| `.github/workflows/` | Workspace-level CI/CD workflows |

## Working rules

- Read the nearest `AGENTS.md`, `README.md`, and relevant configuration files before modifying code.
- Treat both directories under `packages/` as imported upstream projects. Preserve their layout, conventions, and local tooling.
- Do not use `git submodule` commands. This repository uses Git subtrees.
- Do not rename, move, delete, or re-nest `packages/agent-canvas` or `packages/software-agent-sdk` without explicit instruction.
- Keep workspace-specific integration code and configuration outside `packages/` where possible.
- Prefer contributing reusable changes to the appropriate canonical OpenHands repository, then importing them through a subtree update.
- Do not mix subtree updates with unrelated features, formatting, dependency upgrades, or refactors.
- Do not commit credentials, tokens, private keys, `.env` files, local databases, generated build output, or Docker volumes.

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

## Validation

Before declaring work complete:

1. Identify the affected layer: workspace integration, Agent Canvas, Software Agent SDK, Docker/Compose, or multiple packages.
2. Run the narrowest relevant formatter, linter, type check, build, and test command documented by the affected package.
3. For subtree updates, validate the updated package and any affected workspace integration.
4. Report the commands run, their results, and checks that could not be run.

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
3. Run the affected package's validation commands and workspace integration checks.
4. Commit the subtree update separately from all other work.

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
