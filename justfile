# justfile
# See: https://github.com/casey/just

set shell := ["bash", "-cu"]

[default]
help:
    @just --list

# Start the stack in the FOREGROUND (Ctrl-C stops everything).
# Forwards all flags to scripts/launch-stack.js (the only supported entry point).
# In production mode (--production), auto-builds first since VITE_WORKING_DIR
# is baked at build time (FR8c, FR20). Same --workspace_dir must be used for
# build and serve. Run `just setup` first.
serve *args:
    just build {{args}}
    node scripts/launch-stack.js {{args}}

# Build the Agent Canvas production bundle (no-op in dev mode).
# VITE_WORKING_DIR is baked at build time. For production, pass the same
# workspace_dir that will be used at serve time (defaults to <repo_root>/workspace).
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

# Kill background stack processes for this checkout.
# Reads .dev-id and deletes dev-<id>/prod-<id> PM2 namespaces. Idempotent.
# Pass --kill directly to the launcher; all other flags ignored.
kill *args:
    node scripts/launch-stack.js --kill {{args}}

# Bootstrap dependencies (run once per checkout).
# Allocates .dev-id, runs uv sync + npm install.
# In dev mode (no --production), also sets up upstream git remotes.
# See docs/prd/5_devid-worktree-allocation.md and docs/prd/3_just-task-runner.md FR2b.
[arg("production", long, value="true")]
[arg("workspace_dir", long)]
setup production="false" workspace_dir="":
    ./scripts/alloc-dev-id.sh
    cd packages/software-agent-sdk && uv sync
    cd packages/OpenHands && npm install
    if [ "{{production}}" = "false" ]; then \
        echo "→ dev mode: ensuring upstream git remotes"; \
        just setup-remotes; \
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
