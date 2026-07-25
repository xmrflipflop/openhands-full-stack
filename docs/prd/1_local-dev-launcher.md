# PRD: Local development launcher

**Status:** Active

## Summary

Run the Agent Canvas frontend and the OpenHands Agent Server backend together, built strictly from the source in this repository, so the two subtrees can be developed and validated against each other. The upstream `agent-canvas` CLI runs a similar stack but installs released artifacts (the agent-server from PyPI via `uvx`, the frontend from the published npm package); this workspace runs the same workflow pointed at local sources instead.

Process management is **PM2**, driven by a single committed `ecosystem.config.js` that derives everything from where it is running. There is no custom launcher script: the ecosystem reads the checkout's role and identity from the filesystem and computes app names, ports, namespace, and runtime environment from them, so the day-to-day commands are plain PM2 verbs (`pm2 start`, `pm2 status`, `pm2 restart`, `pm2 logs`). One prod checkout (under `/opt`) and one or more dev checkouts (under the home tree, including git worktrees) run concurrently without clashing.

## Scope

Workspace-owned only; no upstream files are modified.

| Path | Role |
| --- | --- |
| `ecosystem.config.js` | The single committed PM2 process ecosystem (workspace-owned). Derives role, identity, app names, ports, namespace, and `NODE_ENV` from the checkout location and a per-checkout id; defines the uv-venv interpreter and supervision limits. No secrets or env-specific values are hard-coded in app code. |
| `scripts/dev-local-ingress.mjs` | The single-origin ingress app (workspace-owned), the third PM2 app. A thin wrapper over the upstream ingress that adds only a bind address; its existence is justified in `docs/prd/4_ingress-host-wrapper.md`. |
| `.gitignore` | Ignores the per-checkout identity file, the uv venv, node_modules, and PM2 runtime state. |
| `packages/agent-canvas` | Consumed: the frontend dev server and its dev-proxy / configuration surface; the ingress script and proxy internals consumed by the wrapper. |
| `packages/software-agent-sdk` | Consumed: the agent-server entry point and its uv workspace; the `uv sync`-managed `.venv` is the PM2 backend interpreter. |

### Retired by this revision

This revision replaces an earlier, over-engineered build with direct PM2. The following workspace-owned files (no longer in the tree) are **removed** by the migration to this PRD:

| Role it played | Notes |
| --- | --- |
| The pre-PM2 foreground shell supervisor | Process-group-based crash-linked supervision. Replaced by PM2. |
| The bespoke PM2 launcher | A flag surface, hash-derived names, per-deployment `PM2_HOME` isolation, a "last started" name file, and orphan-reaping logic. Replaced by the self-deriving ecosystem. |
| The backend entry shim | A PM2 file-path entry point for the agent-server. Retired in favor of pointing PM2's `script` at the venv `agent-server` console script directly. |

## Functional requirements

- **FR1** — A single committed `ecosystem.config.js` at the repo root defines every app. It derives role, identity, app names, ports, namespace, and `NODE_ENV` from the checkout location and a per-checkout id at evaluation time, so `pm2 start ecosystem.config.js` requires no per-invocation flags to produce a correct, clash-free deployment.
- **FR2** — Role comes from the checkout path. A checkout located under `/opt` is **prod** (exactly one, fixed base ports). Any other checkout location is **dev**. The role selects `NODE_ENV` and the port block.
- **FR3** — Each non-prod checkout carries a `.dev-id` file containing a positive integer, unique per checkout (e.g. `1`, `2`, … across worktrees). The ecosystem reads it fresh on every evaluation; a missing or invalid `.dev-id` for a non-prod checkout is a hard error that aborts the start, so a clash can never happen silently. `.dev-id` is gitignored and never committed.
- **FR4** — The id (treated as `0` for prod) is the single source of truth: the app-name tag, the PM2 namespace, and the frontend/backend port block all derive from it. Because names are derived from the id, name uniqueness implies port uniqueness; there is no independent port to misconfigure.
- **FR5** — PM2 app names are `<service>-<tag>` where `tag` is `prod` or `dev<N>` (e.g. `backend-prod`, `backend-dev1`, `frontend-dev2`). The PM2 `namespace` is the tag, so group operations (`pm2 restart prod`, `pm2 stop dev2`) and single-app operations (`pm2 logs backend-dev1`) both work naturally.
- **FR6** — Multiple dev checkouts, including git worktrees, run concurrently with distinct ports and per-app logs/data, never clashing with each other or with the single prod checkout.
- **FR7** — The backend runs from local `packages/software-agent-sdk` sources and is launched with the repository's uv-managed virtual environment specified explicitly as PM2's `interpreter` (not system Python, not `uvx`, not a PyPI release). `uv sync` materialises that venv with workspace members in editable mode before start, so every `openhands-*` package resolves to local sources. No `openhands-*` release may be fetched from a registry. PM2's `script` points at the venv's installed `agent-server` console script (under `packages/software-agent-sdk/.venv/bin`); the venv python is the `interpreter`, so the composed command is `<venv>/bin/python <venv>/bin/agent-server --host .. --port ..` and the installed package imports cleanly.
- **FR8** — The frontend is the local `packages/agent-canvas` dev server. The published `@openhands/agent-canvas` package must never be installed or executed. The frontend's built-in dev proxy targets the backend at the backend's derived port (supplied via the frontend's documented backend-URL configuration).
- **FR9** — The whole stack is additionally served behind a single origin (one host:port, the ingress app) that routes API and websocket paths to the backend and everything else to the frontend, so the browser makes same-origin API/websocket calls. The ingress is the third PM2 app, run by `scripts/dev-local-ingress.mjs` (justified in `docs/prd/4_ingress-host-wrapper.md`). Its bind address is controllable (loopback by default; exposed on demand).
- **FR10** — `NODE_ENV` is derived from role: prod → `production`, dev → `development`. It is the only env-mode variable any application code reads (the frontend uses it for i18n debug logging and an `isDevMode` flag; the backend ignores it). There are no named runtime-environment blocks (`env_staging` / `env_production`) and no `--env <name>` selection — the earlier named-environment machinery was removed because `DEV_ENV_NAME` was set but never consumed and the blocks differed only in `NODE_ENV`, which role already determines.
- **FR11** — PM2 supervises frontend, backend, and ingress with bounded auto-restart: `autorestart`, a `max_restarts` limit, `min_uptime`, `restart_delay`, and a `max_memory_restart` threshold. A process that repeatedly fails within its minimum-uptime window is held in `errored` state rather than spinning.
- **FR12** — The stack runs unprivileged: no port below 1024 is bound, and all writes stay inside the checkout. Root is not required for normal operation. Privilege drop via PM2 `uid`/`gid` is documented but disabled by default and only honoured when PM2 is started as root.
- **FR13** — Day-to-day operations use PM2 directly: `pm2 start ecosystem.config.js` to launch, `pm2 status` to list (grouped by namespace), `pm2 restart <namespace>` / `pm2 stop <namespace>` for whole instances, `pm2 logs <app-name>` for one process. `pm2 save` snapshots the running set and `pm2 resurrect` restores it across machine restarts.
- **FR14** — `just dev` is a thin wrapper that forwards to `pm2 start ecosystem.config.js`. It is not a supervisor and adds no process-management logic of its own; all supervision is PM2's.

## Non-functional requirements

- **NFR1** — Portable, POSIX-only scripting where any scripting is needed (the Coder host and contributor laptops may run macOS bash 3.2).
- **NFR2** — The id-from-path and id-from-file derivation is read fresh on every PM2 evaluation and baked into `pm2 save` snapshots, so `pm2 resurrect` brings prod and all dev instances back with the correct ports after a restart.
- **NFR3** — No credentials, tokens, or `.dev-id` values are committed. The `.gitignore` covers `.dev-id`, venvs, node_modules, and PM2 runtime state.
- **NFR4** — Concurrent checkouts never collide: the id is the single source of truth for names and ports, and a missing/invalid `.dev-id` fails fast.

## Decision points

- **Self-deriving ecosystem vs. a custom launcher script.** Chose the self-deriving ecosystem. The earlier bespoke launcher accumulated a flag surface, hash-derived names, per-deployment `PM2_HOME` isolation, a "last started" name file, and orphan-reaping logic — far more machinery than the problem needs. Deriving role and identity inside `ecosystem.config.js` from path and `.dev-id` keeps one source of truth and lets PM2's own verbs do all the work.
- **Role from path vs. an explicit `--role` flag.** Path is automatic and unambiguous for the `/opt` = prod convention; it cannot be forgotten on a start.
- **`.dev-id` file vs. a derived/hash id.** A small explicit file is the clearest single source of truth, is unique per checkout, and survives `pm2 save` / `pm2 resurrect` (the id is read fresh each evaluation and baked into the snapshot). A hash of the path would also be unique but is opaque and harder to reason about for `pm2 logs backend-dev1`.
- **Single shared PM2 registry + namespaces vs. per-deployment `PM2_HOME` isolation.** Chose shared + namespaces. The prior per-deployment `PM2_HOME` was over-isolation: it defeated PM2's group operations, required a custom wrapper to find the right registry, and made orphan reaping necessary. A single registry with `namespace` per instance gives `pm2 restart prod` / `pm2 stop dev2` for free and one `pm2 resurrect` to restore everything.
- **Single-origin ingress vs. frontend dev proxy alone.** Kept the single-origin ingress as the third PM2 app (Option B), so the whole stack is served behind one host:port and the browser makes same-origin API/websocket calls. Because the upstream ingress cannot bind a host, it runs through the thin workspace-owned wrapper `scripts/dev-local-ingress.mjs` (justified in `docs/prd/4_ingress-host-wrapper.md`); the frontend's built-in dev proxy is not relied upon for the single-origin contract.
- **Backend launch: venv console script vs. `uv run` / a workspace shim.** PM2 resolves its `script` field as a file path and cannot run `python -m openhands.agent_server` directly; pointing at the package `__main__.py` shadows the installed package on `sys.path[0]`. The SDK's installed `agent-server` console script (under the venv's `bin`) is a file path whose own body is a clean `from openhands.agent_server.__main__ import main; sys.exit(main())`, so pointing PM2's `script` at it with the venv python as `interpreter` runs the server with no shadowing and no workspace-owned shim. A workspace shim was considered and rejected as redundant: it would duplicate the console script's body. Using `uv run` was rejected because it adds a wrapper process and keeps PM2's process tree non-flat.
- **Prod under `/opt` vs. an environment variable.** The path convention is chosen because the prod checkout's location is itself the deployment signal in the Coder setup. Note the Coder caveat: `/opt` is typically not on the persistent home volume, so the prod clone (and its `chown` to the unprivileged user) belongs in the image or startup script, and `pm2 save` must be re-run whenever the set of instances changes.
- **Derived `NODE_ENV` vs. named runtime environments (`--env`).** The ecosystem originally provided `env` / `env_staging` / `env_production` blocks selectable with `--env <name>`. Removed in favor of deriving `NODE_ENV` from role (prod → `production`, dev → `development`). `DEV_ENV_NAME` was set but consumed by nothing; the blocks differed only in `NODE_ENV`, which role already determines; and the only readers of `NODE_ENV` are the frontend's i18n debug logging and an `isDevMode` flag (the backend ignores it). Named environments added a selection surface with no behavioral payoff.

## Assumptions (re-check these first when upstream changes)

- `pm2` (any current v7+) is installed on contributor machines, in CI, and in the Coder image.
- The Coder host convention holds: the prod checkout lives under `/opt`; dev checkouts (including git worktrees) live elsewhere, typically under the home tree.
- The SDK remains a single uv workspace whose members include the agent-server; it exposes a runnable agent-server entry point accepting host and port options; and `uv sync` materialises a `.venv` whose `python` can import and run the agent-server entry function.
- The frontend keeps a `dev:frontend` package script that starts only the dev server (without spawning backends), honours environment configuration for its port and backend base URL, and proxies API/websocket paths to the configured backend.
- The frontend's backend-URL configuration accepts a `http://host:port` value that the dev proxy forwards to.

## Upstream divergence

No upstream code is modified; the divergence is behavioral. Upstream's launcher installs released artifacts by design; this one forbids that and runs local sources, so it is not upstreamable as-is. If upstream ever ships a supported "run everything from a local checkout" mode covering both projects, this functionality can be retired in its favor.

The PM2 ecosystem is workspace-owned; it is not an upstream contribution because upstream does not supervise its launcher with PM2. The backend launch uses the SDK's own installed `agent-server` console script (no workspace-owned backend entry file).

## Conflict resolution notes

Preserve the requirements, not the implementation. If an upstream update breaks the stack, re-locate the SDK's current way of running the agent-server from workspace sources (`uv sync` + the venv python) and the frontend's current dev-server script and configuration surface, then rewire the ecosystem to them. Any functional requirement may be reimplemented with different mechanics; none may be dropped silently. The stable invariants are the id-from-path/id-from-file contract (FR2–FR4), the local-sources-only contract (FR7–FR8), the uv-venv-as-interpreter contract (FR7), and the PM2-supervision contract (FR10). A future rework must not silently reintroduce a bespoke launcher that duplicates PM2's own verbs, nor drop the fail-fast `.dev-id` check that prevents silent port clashes, without revising this PRD first.

## Migration status

Implemented. The ecosystem is the self-deriving form (path → role, `.dev-id` → id/ports/namespace, three apps including the ingress); the bespoke launcher, the pre-PM2 shell supervisor, and the backend entry shim have been removed; and the `just dev` recipe is a thin `pm2 start ecosystem.config.js` wrapper. The ingress wrapper `scripts/dev-local-ingress.mjs` is retained (see `docs/prd/4_ingress-host-wrapper.md`).
