# justfile
# See: https://github.com/casey/just

set shell := ["bash", "-cu"]

[default]
help:
    @just --list

# Start the local dev stack in the FOREGROUND: backend + frontend + ingress,
# streamed logs, Ctrl-C stops everything. The ecosystem is self-deriving (role
# from the checkout path, identity/ports from .dev-id; NODE_ENV from role).
# pm2-runtime runs against a THROWAWAY PM2_HOME so the foreground dev run never
# touches the global ~/.pm2 daemon (where prod lives). Run `just setup` first.
dev *args:
    PM2_HOME=/tmp/pm2-fg-openhands-dev pm2-runtime start ecosystem.config.js {{args}}

# Bootstrap dependencies the ecosystem expects (run once per checkout).
# Allocates the per-checkout `.dev-id` first so the dev stack can derive a
# unique app-name tag and port block (idempotent; supports git worktrees).
# See docs/prd/5_devid-worktree-allocation.md.
#
# Pass `--prod` to additionally build the Agent Canvas production bundle into
# packages/agent-canvas/build/. The prod launcher serves this prebuilt SPA
# (NODE_ENV=production is incompatible with `react-router dev`, so prod does
# NOT run the Vite dev server — see ecosystem.config.js and
# docs/prd/1_local-dev-launcher.md FR8). Dev checkouts never need `--prod`.
[arg("prod", value="true")]
setup prod="false":
    ./scripts/alloc-dev-id.sh
    cd packages/software-agent-sdk && uv sync
    cd packages/agent-canvas && npm install
    if [ "{{prod}}" = "true" ]; then \
        echo "→ --prod: building agent-canvas production bundle (npm run build:app)"; \
        npm run build --prefix packages/agent-canvas; \
    else \
        echo "→ skipping production frontend build (dev checkout; pass --prod to build it)"; \
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
