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
# NODE_ENV) and hands them to ecosystem.config.js as STACK_* env vars.
# Foreground runs `pm2-runtime` against a THROWAWAY PM2_HOME keyed on the tag,
# so the run never touches the global ~/.pm2 daemon. Pass --background to detach
# against the shared daemon instead, and --production to serve the prebuilt SPA.
# Run `just setup` first.
serve *args:
    node scripts/launch-stack.js {{args}}

# Bootstrap dependencies the stack expects (run once per checkout).
# Allocates the per-checkout `.dev-id` first so the launcher can derive a unique
# app-name tag (dev-<id>/prod-<id>) and port block (idempotent; supports git
# worktrees). Every checkout — production included — needs a `.dev-id` now.
# See docs/prd/5_devid-worktree-allocation.md.
#
# Pass `--production` to additionally build the Agent Canvas production bundle
# into packages/agent-canvas/build/. The production launcher serves this
# prebuilt SPA (NODE_ENV=production is incompatible with `react-router dev`, so
# production does NOT run the Vite dev server — see ecosystem.config.js and
# docs/prd/1_local-dev-launcher.md FR8). The flag name matches the launcher's
# `--production` (and `just serve`'s) so the surface is uniform. Dev-mode
# checkouts never need `--production`.
[arg("production", value="true")]
setup production="false":
    ./scripts/alloc-dev-id.sh
    cd packages/software-agent-sdk && uv sync
    cd packages/agent-canvas && npm install
    if [ "{{production}}" = "true" ]; then \
        echo "→ --production: building agent-canvas production bundle (npm run build)"; \
        npm run build --prefix packages/agent-canvas; \
    else \
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

# Set up the canonical upstream git remotes
setup-remotes:
    git remote add agent-canvas https://github.com/OpenHands/agent-canvas.git || git remote set-url agent-canvas https://github.com/OpenHands/agent-canvas.git
    git remote add software-agent-sdk https://github.com/OpenHands/software-agent-sdk.git || git remote set-url software-agent-sdk https://github.com/OpenHands/software-agent-sdk.git
    git config remote.software-agent-sdk.tagOpt --no-tags
    git config remote.agent-canvas.tagOpt --no-tags
    git remote -v

[private]
sync-subtree name ref="latest":
    #!/usr/bin/env bash
    set -euxo pipefail

    ref="{{ref}}"
    if [[ "$ref" == "latest" ]]; then
        ref=$(curl -fsSL "https://api.github.com/repos/OpenHands/{{name}}/releases/latest" | jq -er '.tag_name')
    fi

    git fetch --no-tags "{{name}}" "refs/tags/$ref"
    git subtree merge --prefix="packages/{{name}}" FETCH_HEAD \
        -m "chore: sync {{name}} to $ref"

# Sync the software-agent-sdk subtree
sync-sdk ref="latest": (sync-subtree "software-agent-sdk" ref)

# Sync the agent-canvas subtree
sync-canvas ref="latest": (sync-subtree "agent-canvas" ref)

# Sync subtree packages from upstream
sync: sync-canvas sync-sdk

# Install systemd service files
install-service:
  @echo Installing service files
  # TODO
