# justfile
# See: https://github.com/casey/just

set shell := ["bash", "-cu"]

[default]
help:
    @just --list

# Start dev server
dev *args:
    ./scripts/dev-local.sh {{args}}

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
    echo "Syncing {{name}} at $ref"

    git fetch --no-tags "{{name}}" "refs/tags/$ref"
    git subtree pull --prefix="packages/{{name}}" "{{name}}" FETCH_HEAD --squash \
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
