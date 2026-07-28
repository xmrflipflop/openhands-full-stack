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

The stack runs strictly from this repository's sources (no upstream releases are downloaded), supervised by PM2. There is one launcher — `scripts/launch-stack.js`, the only supported entry point — and one committed `ecosystem.config.js` that consumes the launcher's output. The launcher resolves every deployment-specific value (the per-checkout id, the app-name tag, ports, bind addresses, the session API key, `NODE_ENV`) and hands them to the ecosystem as `STACK_*` environment variables; the ecosystem derives nothing and hard-errors (naming the launcher) if any required value is absent. Start the stack with `just serve`, which forwards all flags to the launcher unchanged.

Key points:

- Every checkout — production included — needs a `.dev-id` file (gitignored) holding a unique positive integer. `just setup` allocates one automatically (idempotent). The id embeds in the tag and the port block for both modes.
- The stack has two **independent** axes. **Mode** (`--production` or not) selects `NODE_ENV` and the frontend serving seam. **Run style** (`--background` or not) selects foreground `pm2-runtime` (default) vs. detached `pm2` against the shared daemon. All four combinations are legal.
- Tag shape is `dev-<id>` or `prod-<id>`, used verbatim as the PM2 app-name suffix and namespace (e.g. `backend-dev-1`, `frontend-prod-2`). This is a breaking rename from the earlier `dev1` / `prod` shape.
- Default ports (bases 3000 / 18000 / 9000 for frontend / backend / ingress) are `base + id×10`, plus 5 for production (so a dev and a prod of the same id never collide). Each of the six ports defaults independently; pass `--fe_port` / `--be_port` / `--ingress_port` to override.
- Bind addresses default to loopback (`127.0.0.1`) for every service. Loopback is a security property, not a convenience: the stack is unauthenticated by default, so exposing it must stay opt-in and explicit. Override via the `--fe_bind` / `--be_bind` / `--ingress_bind` flags, or the legacy `DEV_FRONTEND_BIND` / `DEV_BACKEND_BIND` / `DEV_INGRESS_BIND` env vars (kept for continuity with existing shell profiles).
- The frontend is served differently per **mode**: development runs the Vite dev server (`react-router dev`); production serves a prebuilt bundle through the upstream static file server. The split exists because the Vite dev server cannot run under `NODE_ENV=production` (Vite's SSR JSX transform then imports a runtime that has no `jsxDEV` export, crashing the dev server). Production requires the bundle to be built first via `just setup --production`; the launcher (and the ecosystem, as a backstop) fail fast with a clear message if it is missing.

| Service | dev-1 | prod-1 | Purpose |
| --- | --- | --- | --- |
| Stack (ingress) | `:9010` | `:9015` | Single-origin entry point — browse here |
| Frontend | `:3010` (Vite dev server) | `:3015` (static server + built SPA) | Direct frontend port, for debugging |
| Backend (agent-server) | `:18010` | `:18015` | Direct API port, for debugging (`/docs`) |

### Foreground (default)

```bash
just setup            # uv sync + npm install (allocates .dev-id, once per checkout)
just serve            # foreground: backend + frontend + ingress, logs stream, Ctrl-C stops all
```

`just serve` runs the launcher, which starts `pm2-runtime` in the foreground against a throwaway `PM2_HOME` keyed on the tag (`/tmp/pm2-fg-<tag>`), so the foreground run never touches the global `~/.pm2` daemon. Logs stream to the terminal; Ctrl-C stops the whole stack; there is no state to manage, save, or resurrect. To reach a service from another machine, pass the bind flag, e.g. `just serve --ingress_bind 0.0.0.0`.

The OpenHands Automation backend is not part of this repository and is not started.

### Background / production

For a deployment (or any detached run), add `--background` to run against the **global** PM2 daemon so the stack survives the operator disconnecting. Add `--production` to serve the **prebuilt** frontend bundle under `NODE_ENV=production`; `just setup --production` builds it first (one-time, or whenever the frontend source changes):

```bash
just setup --production                   # uv sync + npm install, then build the agent-canvas production bundle (one-time)
just serve --production --background   # detached, on the global daemon (~/.pm2)
```

`just setup --production` writes the bundle to `packages/agent-canvas/build/` (gitignored, never committed). If you change the frontend source, rebuild with `just setup --production` (or `cd packages/agent-canvas && npm run build`) before restarting the stack; starting production without a build fails fast with a message pointing here.

Then manage it with PM2's own verbs (grouped by the tag namespace):

```bash
pm2 ls                                # process table (grouped by namespace)
pm2 logs backend-prod-1               # one app, or a whole namespace
pm2 stop prod-1 && pm2 delete prod-1   # tear down that instance
```

Snapshot/restore (`pm2 save` / `pm2 resurrect`) is intentionally **not** supported: a restored snapshot would replay the resolved values from the moment it was taken, and the launcher resolves values fresh on every start. There is no resurrect handling; there is no reboot-survival path. Restart by re-running `just serve`.

### Flags

`just serve` forwards everything to `scripts/launch-stack.js`:

| Flag | Effect |
| --- | --- |
| `--fe_port` / `--be_port` / `--ingress_port` | Override one of the three ports (default each computes from the id). Out of 1024–65535 or non-integer is a hard error. |
| `--fe_bind` / `--be_bind` / `--ingress_bind` | Override one of the three bind addresses (default loopback; then `DEV_*_BIND` env). |
| `--background` | Detach: `pm2 start` against the shared daemon (default is foreground `pm2-runtime`). |
| `--production` | `NODE_ENV=production`, serve the prebuilt SPA, require the build to exist. |
| `--dry-run` | Print the resolved env and intended runner; start nothing. |


## Workspace tasks

Run `just` with no arguments to list all recipes. The common ones:

```bash
just setup           # bootstrap deps (alloc .dev-id, uv sync, npm install) — once per checkout
just setup --production    # same, plus build the agent-canvas production bundle (needed for production mode only)
just serve           # start the local stack in the foreground (frontend + backend + ingress)
just serve --background   # detach: leave the stack running on the shared daemon
just lint            # workspace linters, incl. the PRD reference check
just test            # workspace tests
just check           # lint + test — run before pushing
just setup-remotes   # set up the upstream git remotes
just sync            # pull both upstream subtrees
```

`just serve` forwards all flags to `scripts/launch-stack.js`, which resolves the per-checkout id, tag, ports, bind addresses, session key, and `NODE_ENV`, then hands them to `ecosystem.config.js`. The default foreground run uses `pm2-runtime` with a throwaway `PM2_HOME` keyed on the tag, so it never touches the global `~/.pm2` daemon; `--background` detaches against the shared daemon instead. Mode is independent of run style: `--production` selects `NODE_ENV=production` and serves a prebuilt bundle (`just setup --production` builds it), because the Vite dev server cannot run under `NODE_ENV=production`.

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
