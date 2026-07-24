# OpenHands Full Stack Workspace

An integration repository for developing and running OpenHands Agent Canvas alongside the OpenHands Software Agent SDK.

This repository uses **Git subtrees**. Both upstream projects are committed as ordinary directories in this repository, so a regular clone includes their full source code. No submodule initialisation is required.

## Included packages

| Local path | Canonical upstream | Role |
| --- | --- | --- |
| `packages/agent-canvas` | [OpenHands/agent-canvas](https://github.com/OpenHands/agent-canvas) | Self-hostable Agent Canvas application |
| `packages/software-agent-sdk` | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | Modular SDK for building software agents |

## Layout

```text
.
├── AGENTS.md
├── README.md
├── justfile                       # Workspace task runner (just)
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

The root repository owns cross-package integration: the task runner, Docker and Compose configuration, CI/CD, developer scripts, deployment configuration, infrastructure, and workspace documentation.

## Clone

```bash
git clone https://github.com/xmrflipflop/openhands-full-stack.git
cd openhands-full-stack
```

A normal clone is sufficient. Do not run `git submodule init` or `git submodule update`.

## Run the stack locally

**Prerequisites**: [`just`](https://github.com/casey/just), Node.js 22.12+, `npm`, [`uv`](https://docs.astral.sh/uv/)

```bash
just dev
```

This starts, strictly from the source in this repository (no upstream releases are downloaded):

| Service | Port | Purpose |
| --- | --- | --- |
| Stack (ingress) | `:9000` | Single-origin entry point — browse here |
| Frontend (Vite) | `:8000` | Direct dev-server port, for debugging |
| Backend (agent-server) | `:18000` | Direct API port, for debugging (`/docs`) |

Everything binds loopback by default. To reach the stack from another machine, expose the ingress port:

```bash
just dev --host 0.0.0.0                 # expose the stack port only
just dev --host 0.0.0.0 --expose-debug  # debug ports too
```

If any service exits, the whole stack shuts down. All launcher flags pass through `just dev`; see `scripts/dev-local.sh --help` for the full list. The OpenHands Automation backend is not part of this repository and is not started.

## Workspace tasks

Run `just` with no arguments to list all recipes. The common ones:

```bash
just dev            # start the local stack
just lint           # workspace linters, incl. the PRD reference check
just test           # workspace tests
just check          # lint + test — run before pushing
just setup-remotes  # set up the upstream git remotes
just sync           # pull both upstream subtrees
```

## Develop

Each imported package retains its own tooling, dependencies, development commands, tests, and documentation.
Refer to their README for installation, examples, linting, and test commands. The justfile covers workspace-level tasks only; run package-level commands inside the affected package.

Before changing anything, read [AGENTS.md](AGENTS.md) — in particular the rules on modular and additive changes and the PRD process under `docs/prd/`, which keep this repository easy to sync with its upstreams.

## Subtree remotes

The workspace pulls updates from the canonical OpenHands repositories. Set up (or repair) the remotes with:

```bash
just setup-remotes
```

The recipe is idempotent and prints the configured remotes when done. It is equivalent to:

```bash
git remote add agent-canvas \
  https://github.com/OpenHands/agent-canvas.git

git remote add software-agent-sdk \
  https://github.com/OpenHands/software-agent-sdk.git

git remote -v
```

## Update packages

Pull updates from the OpenHands upstream repositories:

```bash
just sync                 # both subtrees, from upstream main
just sync-canvas <ref>    # only Agent Canvas, from a specific ref
just sync-sdk <ref>       # only the SDK, from a specific ref
```

Under the hood they run the standard subtree pulls:

```bash
# Update Agent Canvas
git fetch agent-canvas
git subtree pull \
  --prefix=packages/agent-canvas \
  agent-canvas main

# Update Software Agent SDK
git fetch software-agent-sdk
git subtree pull \
  --prefix=packages/software-agent-sdk \
  software-agent-sdk main
```

If an upstream repository uses a branch other than `main`, pass its default branch as the ref.

After pulling, review, validate (`just check`), commit, and push the update:

```bash
git status
git add packages/agent-canvas packages/software-agent-sdk
git commit -m "chore: update OpenHands subtrees"
git push origin main
```
