# justfile
# See: https://github.com/casey/just

set shell := ["bash", "-cu"]

[default]
help:
    @just --list

# Start the local stack in the FOREGROUND (default): backend + frontend +
# ingress, streamed logs, Ctrl-C stops everything. Forwards all flags unchanged
# to scripts/launch-stack.js (the only supported entry point), which resolves
# every deployment value (per-checkout id, tag, ports, binds, session key,
# workspace directory, NODE_ENV) and hands them to ecosystem.config.js as STACK_* env vars.
# Foreground runs `pm2-runtime` against a THROWAWAY PM2_HOME keyed on the tag,
# so the run never touches the global ~/.pm2 daemon. Pass --background to detach
# against the shared daemon instead, and --production to serve the prebuilt SPA.
# Run `just setup` first.
#
# In production mode (--production), automatically builds first since VITE_WORKING_DIR
# is baked at build time. The same --workspace_dir must be used for build and serve.
# Can also be set via WORKSPACE_DIR env var.
serve *args:
    just build {{args}}
    node scripts/launch-stack.js {{args}}

# Build the Agent Canvas production bundle (no-op in dev mode).
# VITE_WORKING_DIR is baked at build time. For production, pass the same
# workspace_dir that will be used at serve time. Defaults to <repo_root>/workspace.
# Can also be set via WORKSPACE_DIR env var.
[arg("production", long, value="true")]
[arg("workspace_dir", long)]
build production="false" workspace_dir="":
    if [ "{{production}}" = "true" ]; then \
        if [ -n "{{workspace_dir}}" ]; then \
            echo "→ production: building with workspace_dir={{workspace_dir}}"; \
            VITE_WORKING_DIR="{{workspace_dir}}/project" npm run build --prefix packages/OpenHands; \
        else \
            echo "→ production: building with default workspace"; \
            npm run build --prefix packages/OpenHands; \
        fi; \
    else \
        echo "→ dev mode: no build needed"; \
    fi

# Kill all background stack processes for this checkout.
# Reads .dev-id and deletes both dev-<id> and prod-<id> PM2 namespaces from
# the shared daemon. Idempotent (exits 0 if nothing was running). Works
# across branch switches because .dev-id is stable (gitignored).
# Pass --kill directly to the launcher; all other flags are ignored by --kill.
kill *args:
    node scripts/launch-stack.js --kill {{args}}

# Bootstrap dependencies the stack expects (run once per checkout).
# Allocates the per-checkout `.dev-id` first so the launcher can derive a unique
# app-name tag (dev-<id>/prod-<id>) and port block (idempotent; supports git
# worktrees). Every checkout — production included — needs a `.dev-id` now.
# See docs/prd/5_devid-worktree-allocation.md.
#
# In dev mode (no `--production`) this ALSO runs `just setup-remotes` so a fresh
# checkout is ready for `just sync` against the upstream subtrees. That step only
# records remote URLs (no network), is idempotent, and is intentionally skipped
# in production (a deployment does not need the upstream sync remotes). See
# docs/prd/3_just-task-runner.md FR2b.
[arg("production", long, value="true")]
[arg("workspace_dir", long)]
setup production="false" workspace_dir="":
    ./scripts/alloc-dev-id.sh
    cd packages/software-agent-sdk && uv sync
    cd packages/OpenHands && npm install
    if [ "{{production}}" = "true" ]; then \
        echo "→ --production: skipping frontend build (use 'just serve --production' which builds automatically)"; \
    else \
        echo "→ dev mode: ensuring upstream git remotes (just setup-remotes, idempotent, no network)"; \
        just setup-remotes; \
        echo "→ skipping production frontend build (dev mode; pass --production to build it)"; \
    fi

# Run lint and test
check: lint test

# Run tests
test *args:
  echo Testing…

# Run linters
lint *args:
  @echo Linting PRD references
  ./scripts/check-prd-refs.sh

# Set up the canonical upstream git remotes.
# The `OpenHands` remote points at the OpenHands monorepo
# (https://github.com/OpenHands/OpenHands), whose repo root IS the
# @openhands/agent-canvas frontend.
setup-remotes:
    git remote add OpenHands https://github.com/OpenHands/OpenHands.git || git remote set-url OpenHands https://github.com/OpenHands/OpenHands.git
    git remote add software-agent-sdk https://github.com/OpenHands/software-agent-sdk.git || git remote set-url software-agent-sdk https://github.com/OpenHands/software-agent-sdk.git
    git config remote.software-agent-sdk.tagOpt --no-tags
    git config remote.OpenHands.tagOpt --no-tags
    git remote -v

# `repo` is the GitHub repository slug whose `releases/latest` resolves the
# default ref. It defaults to `name` (the git remote and prefix).
[private]
sync-subtree name ref="latest" repo=name:
    #!/usr/bin/env bash
    set -euxo pipefail

    ref="{{ref}}"
    if [[ "$ref" == "latest" ]]; then
        ref=$(curl -fsSL "https://api.github.com/repos/OpenHands/{{repo}}/releases/latest" | jq -er '.tag_name')
    fi

    git fetch --no-tags "{{name}}" "refs/tags/$ref"
    git subtree merge --prefix="packages/{{name}}" FETCH_HEAD \
        -m "chore: sync {{name}} to $ref"

# Sync the software-agent-sdk subtree
sync-sdk ref="latest": (sync-subtree "software-agent-sdk" ref)

# Sync the OpenHands monorepo subtree (frontend root)
sync-openhands ref="latest": (sync-subtree "OpenHands" ref)

# Sync subtree packages from upstream
sync: sync-openhands sync-sdk

# Install systemd service files
install-service:
  @echo Installing service files
  # TODO
