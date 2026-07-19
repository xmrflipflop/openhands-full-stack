# syntax=docker/dockerfile:1.7

# ═══════════════════════════════════════════════════════════════════════════════
# ymai-openhands all-in-one image — runs everything from LOCAL sources
#
# Unlike packages/agent-canvas/docker/Dockerfile (which fetches a prebuilt
# agent-server image + automation wheels from PyPI and the static frontend
# from the npm package build), this image builds the whole stack from the
# source trees that live in this monorepo:
#
#   - Frontend + ingress: built from packages/agent-canvas (npm ci + react-router build)
#   - Agent Server + SDK: installed from packages/software-agent-sdk as a uv
#     workspace (uv sync → .venv with all four packages editable in place).
#   - Automation backend: openhands-automation comes from a SEPARATE repo
#     (github.com/OpenHands/automation), so it is still fetched from PyPI into
#     the same venv. Runtime overrides (OH_AUTOMATION_LOCAL_PATH /
#     OH_AUTOMATION_GIT_REF / OH_AUTOMATION_VERSION) let you re-resolve it.
#
# The Python entrypoint (docker/entrypoint.py) launches all three behind a single
# port (default 8000) under tini:
#   /api/automation/* → automation backend (:18001)
#   /api/*, /sockets    → agent-server (:18000)
#   /* (default)       → static frontend + SPA fallback
#
# Build (run from the repository root):
#   docker build -t ymai-openhands -f docker/Dockerfile .
# Run:
#   docker run -p 8000:8000 ymai-openhands
# ═══════════════════════════════════════════════════════════════════════════════

# ── Build args ────────────────────────────────────────────────────────────────
# These are driven by packages/agent-canvas/config/defaults.json at build time.
ARG AGENT_CANVAS_PATH=packages/agent-canvas
ARG SOFTWARE_AGENT_SDK_PATH=packages/software-agent-sdk

# Automation backend is published from a separate repo; pin its PyPI version.
# Source: packages/agent-canvas/config/defaults.json → versions.automation
ARG AUTOMATION_VERSION=1.1.7

# Frontend build arguments (mirror packages/agent-canvas/docker/Dockerfile).
ARG VITE_APP_ENV=""
ARG VITE_POSTHOG_CLIENT_KEY=""
ARG VITE_BASE_PATH="/canvas"

# ── Stage 1: Build the frontend ───────────────────────────────────────────────
FROM node:24-slim AS frontend-build

ARG AGENT_CANVAS_PATH

WORKDIR /build

# Cache node_modules between layer rebuilds.
COPY ${AGENT_CANVAS_PATH}/package.json ${AGENT_CANVAS_PATH}/package-lock.json ./
RUN npm ci

# Copy the rest of the agent-canvas package tree.
COPY ${AGENT_CANVAS_PATH}/ ./

# Build the static frontend. react-router.config.ts unpacks build/client into
# build/ for non-Vercel builds, so the output is build/ (not build/client/).
ARG VITE_APP_ENV
ARG VITE_POSTHOG_CLIENT_KEY
ARG VITE_BASE_PATH
ENV VITE_APP_ENV=${VITE_APP_ENV}
ENV VITE_POSTHOG_CLIENT_KEY=${VITE_POSTHOG_CLIENT_KEY}
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
RUN npm run build

# ── Stage 2: Build the Python backend venv from local sources ────────────────
# bookworm-based so the resulting .venv is ABI-compatible with the runtime
# stage (also bookworm). Editable workspace installs keep the .pth files
# pointing at the source tree, so we copy source + .venv together into runtime
# at the same path.
FROM python:3.13-slim AS backend-build

ARG SOFTWARE_AGENT_SDK_PATH
ARG AUTOMATION_VERSION

# uv resolves & installs the lockfile without re-resolving (no network beyond
# the one uv pull); --frozen keeps the workspace pinned to uv.lock.
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /bin/

# Materialise the SDK source at the path the entrypoint and editable installs
# both expect: /opt/sdk.
WORKDIR /opt/sdk
COPY ${SOFTWARE_AGENT_SDK_PATH}/ ./

# Sync the workspace from the lockfile. --no-dev omits the heavy test/pre-commit
# dependency group; --extra boto3 matches the SDK's own runtime image so the
# optional object-storage paths import cleanly. Editable installs mean later
# source edits (e.g. via a bind-mount override) take effect without reinstall.
RUN uv sync --frozen --no-dev --extra boto3

# openhands-automation is NOT part of this monorepo — install the pinned PyPI
# wheel into the same venv so `uvicorn openhands.automation.app:app` resolves.
# `uv pip install` targets the workspace environment created above.
RUN uv pip install --python /opt/sdk/.venv/bin/python \
        "openhands-automation==${AUTOMATION_VERSION}"

# ── Stage 3: Runtime image ────────────────────────────────────────────────────
FROM python:3.13-slim AS final

ARG AGENT_CANVAS_PATH
ARG AUTOMATION_VERSION
ARG VITE_BASE_PATH="/canvas"
ARG OPENHANDS_BUILD_GIT_SHA=unknown
ARG OPENHANDS_BUILD_GIT_REF=unknown

LABEL org.opencontainers.image.title="ymai-openhands"
LABEL org.opencontainers.image.description="All-in-one agent-canvas stack built from local sources: Agent Server (local SDK) + Automation + Frontend"
LABEL org.opencontainers.image.source="https://github.com/OpenHands/ymai-openhands"
LABEL org.opencontainers.image.version="${AUTOMATION_VERSION}"
LABEL org.opencontainers.image.revision="${OPENHANDS_BUILD_GIT_SHA}"

ENV AGENT_CANVAS_BUILD_GIT_SHA=${OPENHANDS_BUILD_GIT_SHA}
ENV AGENT_CANVAS_BUILD_GIT_REF=${OPENHANDS_BUILD_GIT_REF}
ENV AGENT_CANVAS_BASE_PATH=${VITE_BASE_PATH}

# libtmux requires a UTF-8 locale (the SDK image documents this; without it tmux
# rewrites UTF-8 separators and breaks the terminal tool).
ENV LC_ALL=C.UTF-8
ENV LANG=C.UTF-8
ENV PYTHONUTF8=1

USER root

# System dependencies the agent-server needs to actually run agents: tmux
# (terminal tool), git (workspace/git tool), jq, curl/ca-certificates, and
# libpq-dev for asyncpg. tini is PID 1 reaping for the multi-service entrypoint.
# Also create the non-root runtime user (python:3.13-slim ships none) with a
# stable UID/GID so bind-mounted host volumes get predictable ownership.
RUN groupadd -g 10001 openhands 2>/dev/null || true && \
    (id -u openhands >/dev/null 2>&1 || useradd -m -u 10001 -g 10001 -s /bin/bash openhands) && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        bash ca-certificates curl wget git jq tmux tar \
        libpq-dev tini procps findutils grep sed gpg && \
    rm -rf /var/lib/apt/lists/*

# Node.js runtime for the static-server.mjs ingress + runtime-services-info.mjs
# CLI. Copied verbatim from node:22-slim (bookworm, ABI-compatible with this
# python:3.13-slim base) into /opt/node, then prepended to PATH. The dedicated
# prefix avoids any collision with the base image's Python under /usr/local.
COPY --from=node:22-slim /usr/local /opt/node
ENV PATH=/opt/node/bin:${PATH}

# uv is needed for the optional uvx overrides (OH_AGENT_SERVER_LOCAL_PATH,
# OH_AUTOMATION_GIT_REF / OH_AUTOMATION_VERSION) that the entrypoint exposes.
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /bin/

# Backend: the editable workspace venv + the local SDK source side-by-side at
# /opt/sdk (the path the editable .pth files point at).
COPY --from=backend-build /opt/sdk /opt/sdk

# Frontend: prebuilt static assets.
COPY --from=frontend-build /build/build /opt/agent-canvas/frontend

# Frontend ingress server and its production runtime node deps (the minimal set
# static-server.mjs/proxy-utils.mjs import).
COPY --from=frontend-build /build/scripts/static-server.mjs /opt/agent-canvas/static-server.mjs
COPY --from=frontend-build /build/scripts/proxy-utils.mjs /opt/agent-canvas/proxy-utils.mjs
COPY --from=frontend-build /build/scripts/runtime-services-info.mjs /opt/agent-canvas/runtime-services-info.mjs
COPY --from=frontend-build /build/node_modules/httpxy /opt/agent-canvas/node_modules/httpxy
COPY --from=frontend-build /build/node_modules/sirv /opt/agent-canvas/node_modules/sirv
COPY --from=frontend-build /build/node_modules/@polka /opt/agent-canvas/node_modules/@polka
COPY --from=frontend-build /build/node_modules/mrmime /opt/agent-canvas/node_modules/mrmime
COPY --from=frontend-build /build/node_modules/totalist /opt/agent-canvas/node_modules/totalist

# canvas_ui_tool compatibility module (legacy persisted metadata still imports
# it by qualname during conversation restore).
COPY ${AGENT_CANVAS_PATH}/tools/ /opt/agent-canvas/tools/

# defaults.json — the single source of truth for ports/paths/versions. The
# Python entrypoint reads it directly (no separate defaults.env stage needed).
RUN mkdir -p /opt/agent-canvas/config
COPY ${AGENT_CANVAS_PATH}/config/defaults.json /opt/agent-canvas/config/defaults.json

# Entrypoint (Python orchestrator; stdlib-only so it runs on the base image's
# system Python 3.13 with no extra pip install. tini reaps and forwards signals).
COPY docker/entrypoint.py /opt/agent-canvas/entrypoint.py
RUN chmod +x /opt/agent-canvas/entrypoint.py

# Pre-create persistence directories with correct ownership so the runtime
# user can write even when Docker attaches anonymous (root-owned) volumes.
RUN mkdir -p /home/openhands/.openhands/agent-canvas/conversations \
             /home/openhands/.openhands/agent-canvas/bash_events \
             /home/openhands/.openhands/automation \
             /projects && \
    chown -R openhands:openhands /home/openhands/.openhands /projects /opt/agent-canvas

USER openhands

# Persistence volumes: settings/secrets/conversations/automation DB, and the
# agent-editable workspace. Bind-mount these for data to survive restarts.
VOLUME ["/home/openhands/.openhands", "/projects"]

# Unified entry point (static ingress).
EXPOSE 8000

ENTRYPOINT ["tini", "--", "python3", "/opt/agent-canvas/entrypoint.py"]
