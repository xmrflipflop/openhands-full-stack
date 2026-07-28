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

**Prerequisites**: [`just`](https://github.com/casey/just), [`pm2`](https://pm2.keymetrics.io/) (v7+), Node.js 22.12+, `npm`, [`uv`](https://docs.astral.sh/uv/)

The stack runs strictly from this repository's sources (no upstream releases are downloaded), supervised by PM2 through one committed `ecosystem.config.js`. The ecosystem is **self-deriving**: it reads the checkout's role and identity from the filesystem and computes app names, ports, and namespace from them — there is no launcher script.

- A checkout under `/opt` is **prod** (base ports); anywhere else is **dev**.
- Each dev checkout needs a `.dev-id` file (gitignored) holding a unique positive integer, e.g. `echo 1 > .dev-id`. That id derives the port block, app-name tag (`dev1`, `dev2`, …), and PM2 namespace, so concurrent checkouts never clash. (Prod uses id `0` and needs no `.dev-id`.)
- The frontend is served differently per role: **dev** runs the Vite dev server (`react-router dev`); **prod** serves a prebuilt production bundle through the upstream static file server. The split exists because the Vite dev server cannot run under `NODE_ENV=production` (Vite's SSR JSX transform then imports a runtime that has no `jsxDEV` export, crashing the dev server). Prod requires the bundle to be built first via `just setup --prod`; the prod launcher fails fast with a clear message if it is missing.

| Service | Prod | dev1 | dev2 | Purpose |
| --- | --- | --- | --- | --- |
| Stack (ingress) | `:9000` | `:9010` | `:9020` | Single-origin entry point — browse here |
| Frontend | `:3000` (static server + built SPA) | `:3010` (Vite dev server) | `:3020` (Vite dev server) | Direct frontend port, for debugging |
| Backend (agent-server) | `:18000` | `:18010` | `:18020` | Direct API port, for debugging (`/docs`) |

### Dev (foreground)

```bash
just setup            # uv sync + npm install (once per checkout)
just dev              # foreground: backend + frontend + ingress, logs stream, Ctrl-C stops all
```

`just dev` runs `pm2-runtime` in the foreground against a throwaway `PM2_HOME` (`/tmp/pm2-fg-openhands-dev`), so the dev run never touches the global `~/.pm2` daemon. Logs stream to the terminal; Ctrl-C stops the whole stack; there is no state to manage, save, or resurrect. Everything binds loopback by default — to reach a service from another machine, set its bind env before starting, e.g. `DEV_INGRESS_BIND=0.0.0.0 just dev`.

The OpenHands Automation backend is not part of this repository and is not started.

### Production (detached)

For a production deployment, clone the repository under `/opt` (the path is the prod signal) and run against the **global** PM2 daemon so the stack survives the operator disconnecting and restarts across machine reboots. Prod serves a **prebuilt** frontend bundle, so the one-time setup also builds it:

```bash
git clone <repo-url> /opt/openhands
cd /opt/openhands
just setup --prod                  # uv sync + npm install, then build the agent-canvas production bundle (one-time)
pm2 start ecosystem.config.js      # detached, on the global daemon (~/.pm2)
```

`just setup --prod` writes the bundle to `packages/agent-canvas/build/` (gitignored, never committed). If you change the frontend source, rebuild with `just setup --prod` (or `cd packages/agent-canvas && npm run build`) before restarting the stack; starting prod without a build fails fast with a message pointing here. (Dev checkouts never need the build — plain `just setup` skips it.)

Then manage it with PM2's own verbs:

```bash
pm2 ls                           # process table (grouped by namespace)
pm2 logs backend-prod            # one app, or `pm2 logs prod` for the whole namespace
pm2 save                         # snapshot the running set
pm2 resurrect                    # restore the saved set after a machine restart
pm2 stop prod && pm2 delete prod # tear down the prod instance
```

Run `pm2 save` whenever the set of running instances changes, so `pm2 resurrect` restores exactly what you expect.

## Workspace tasks

Run `just` with no arguments to list all recipes. The common ones:

```bash
just setup           # bootstrap deps (alloc .dev-id, uv sync, npm install) — once per checkout
just setup --prod    # same, plus build the agent-canvas production bundle (needed for prod role only)
just dev             # start the local stack in the foreground (frontend + backend + ingress)
just lint            # workspace linters, incl. the PRD reference check
just test            # workspace tests
just check           # lint + test — run before pushing
just setup-remotes   # set up the upstream git remotes
just sync            # pull both upstream subtrees
```

`just dev` runs `pm2-runtime` in the foreground against a throwaway `PM2_HOME`, so the dev run never touches the global `~/.pm2` daemon. Role (prod under `/opt`, dev elsewhere) derives `NODE_ENV` and the port block, and a unique PM2 namespace per checkout keeps concurrent checkouts from colliding. The dev role runs the Vite dev server; the prod role serves a prebuilt bundle (`just setup --prod` builds it), because the Vite dev server cannot run under `NODE_ENV=production`.

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
