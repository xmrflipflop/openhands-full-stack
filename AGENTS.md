# ymai-openhands monorepo

Monorepo with two packages:
- `packages/agent-canvas` — agent-canvas frontend (Node/React) + dev/static launcher scripts (`scripts/dev-with-automation.mjs`, `scripts/dev-safe.mjs`, `scripts/static-server.mjs`, `scripts/runtime-services-info.mjs`). npm-based; `npm ci && npm run build` outputs static assets to `build/` (react-router.config.ts unpacks `build/client` into `build/`).
- `packages/software-agent-sdk` — Python SDK monorepo (uv workspace): `openhands-sdk`, `openhands-tools`, `openhands-workspace`, `openhands-agent-server`. Python 3.13; `uv sync` installs all four as editable workspace packages into `.venv`. Run agent-server: `.venv/bin/python -m openhands.agent_server --host --port` (CLI in `openhands.agent_server.__main__:main`).

`openhands-automation` lives in a SEPARATE repo (github.com/OpenHands/automation), not this monorepo; install via `uv pip install openhands-automation==<ver>`.

## Centralized config
`packages/agent-canvas/config/defaults.json` is the single source of truth for version pins, ports (agentServer 18000, automation 18001, proxy 8000), persistence paths, and package names. All JS launchers, the legacy `packages/agent-canvas/docker/Dockerfile` (config-gen stage), CI, and the new `docker/Dockerfile`/`docker/entrypoint.py` derive values from it.

## docker/ — local-source all-in-one stack
`docker/Dockerfile` + `docker/entrypoint.py` build and launch the full stack from LOCAL sources (unlike `packages/agent-canvas/docker/` which fetches a prebuilt agent-server image + automation wheels + the npm-package frontend):
- Frontend: `npm ci && npm run build` from `packages/agent-canvas` (stage `frontend-build`, node:24-slim).
- Backend: `uv sync --frozen --no-dev --extra boto3` of `packages/software-agent-sdk` → `/opt/sdk/.venv` (all four workspace pkgs editable), then `uv pip install openhands-automation==<AUTOMATION_VERSION>` (stage `backend-build`, python:3.13-slim). Copy source + `.venv` together to `/opt/sdk` so editable `.pth` paths stay valid.
- Runtime: `python:3.13-slim` base + node22 copied to `/opt/node` (PATH) — do NOT overlay `/usr/local` or it clobbers python. Install tmux/git/jq/libpq-dev/tini; create `openhands` user (UID 10001). tini → `python3 /opt/agent-canvas/entrypoint.py`.
- `entrypoint.py` is **stdlib-only** (no pip deps), reads `defaults.json` directly, so no `config-gen`/`defaults.env` stage needed. It: persists `OH_SECRET_KEY` + session API key under `~/.openhands/agent-canvas/`, launches agent-server from the venv (override via `OH_AGENT_SERVER_LOCAL_PATH` → uvx editable, mirroring `dev-safe.mjs::buildAgentServerCommand`), launches automation from the venv (override via `OH_AUTOMATION_LOCAL_PATH`/`OH_AUTOMATION_GIT_REF`/`OH_AUTOMATION_VERSION` → uvx), shells out to `node runtime-services-info.mjs --mode docker ...` for the `<RUNTIME_SERVICES>` block, then runs `node static-server.mjs` as ingress with proxy routes mirroring `dev-with-automation.mjs` `AGENT_SERVER_ROUTE_PREFIXES`. Each service is its own process group (`start_new_session=True` + `os.killpg`).

## Runtime services / agent-server env
Agent-server binds 127.0.0.1; the static ingress (port 8000) proxies /api/*, /sockets, /server_info, /health, /ready, /alive, /docs, /redoc, /openapi.json → agent-server and /api/automation/* → automation. Both backends share one session API key via `X-Session-API-Key`. Locale must be C.UTF-8 (libtmux). See the agent-canvas AGENTS.md "Runtime Services in Dev Stacks" section for the `<RUNTIME_SERVICES>` block shape.
