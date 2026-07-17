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

The root repository owns cross-package integration: Docker and Compose configuration, CI/CD, developer scripts, deployment configuration, infrastructure, and workspace documentation.

## Clone

```bash
git clone https://github.com/xmrflipflop/openhands-full-stack.git
cd openhands-full-stack
```

A normal clone is sufficient. Do not run `git submodule init` or `git submodule update`.

## Develop

Each imported package retains its own tooling, dependencies, development commands, tests, and documentation.
Refer to their README for installation, examples, linting, and test commands.

## Subtree remotes

The workspace pulls updates from the canonical OpenHands repositories:

```bash
git remote add agent-canvas \
  https://github.com/OpenHands/agent-canvas.git

git remote add software-agent-sdk \
  https://github.com/OpenHands/software-agent-sdk.git
```

Verify the configured remotes:

```bash
git remote -v
```

## Update packages

Pull updates from the OpenHands upstream repositories:

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

If an upstream repository uses a branch other than `main`, replace `main` with its default branch.

After pulling, review, validate, commit, and push the update:

```bash
git status
git add packages/agent-canvas packages/software-agent-sdk
git commit -m "chore: update OpenHands subtrees"
git push origin main
```
