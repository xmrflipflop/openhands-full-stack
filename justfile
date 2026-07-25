# justfile
# See: https://github.com/casey/just

set shell := ["bash", "-cu"]

[default]
help:
    @just --list

# Start the PM2-managed local dev stack (frontend + backend + ingress).
# The ecosystem is self-deriving: role from the checkout path (/opt = prod,
# else dev) and identity/ports from .dev-id; NODE_ENV is derived from role.
# Run `uv sync` in the SDK package and `npm install` in the frontend package
# first if the venv/node_modules are missing — see setup.
dev *args:
    pm2 start ecosystem.config.js {{args}}

# Stop a whole instance by namespace (prod | devN), or all if none given.
dev-stop tag='':
    @if [ -n "{{tag}}" ]; then pm2 stop {{tag}}; else pm2 stop all; fi

# Restart a whole instance by namespace, or all if none given.
dev-restart tag='':
    @if [ -n "{{tag}}" ]; then pm2 restart {{tag}}; else pm2 restart all; fi

# Show the PM2 process table (grouped by namespace).
dev-status:
    pm2 ls

# Tail logs: an app name (e.g. backend-dev1), a namespace (prod/devN), or
# nothing for everything.
dev-logs *args:
    pm2 logs {{args}}

# Snapshot the running set so `pm2 resurrect` restores it across restarts.
dev-save:
    pm2 save

# Bootstrap dependencies the ecosystem expects (run once per checkout).
setup:
    cd packages/software-agent-sdk && uv sync
    cd packages/agent-canvas && npm install

# build:
#   echo Building…

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
