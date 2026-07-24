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
    git remote -v

[private]
sync-canvas ref="latest":
    ref := if ref == "latest" {
      `curl -fsSL https://api.github.com/repos/OpenHands/agent-canvas/releases/latest | jq -er '.tag_name'`
    } else {
      ref
    }
    echo "Syncing agent-canvas at {{ref}}"
    git fetch agent-canvas --tags
    git subtree pull --prefix=packages/agent-canvas agent-canvas {{ref}}

[private]
sync-sdk ref="latest":
    ref := if ref == "latest" {
      `curl -fsSL https://api.github.com/repos/OpenHands/software-agent-sdk/releases/latest | jq -er '.tag_name'`
    } else {
      ref
    }
    echo "Syncing software-agent-sdk at {{ref}}"
    git fetch software-agent-sdk --tags
    git subtree pull --prefix=packages/software-agent-sdk software-agent-sdk {{ref}}

# Sync subtree packages from upstream
sync: sync-canvas sync-sdk

# Install systemd service files
install-service:
  @echo Installing service files
  # TODO
