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
serve *args:
    node scripts/launch-stack.js {{args}}

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
# Pass `--production` to additionally build the Agent Canvas production bundle
# into packages/OpenHands/build/. The production launcher serves this
# prebuilt SPA (NODE_ENV=production is incompatible with `react-router dev`, so
# production does NOT run the Vite dev server — see ecosystem.config.js and
# docs/prd/1_local-dev-launcher.md FR8). The flag name matches the launcher's
# `--production` (and `just serve`'s) so the surface is uniform. Dev-mode
# checkouts never need `--production`.
#
# Pass `--workspace_dir` to set the base directory for agent-server data and
# the per-conversation working-dir base (VITE_WORKING_DIR). This is REQUIRED
# for `--production` because VITE_WORKING_DIR is baked into the production
# bundle at build time and cannot be changed at serve time. The same
# `--workspace_dir` must be passed to both `just setup --production` and
# `just serve --production` for consistency. Defaults to <repo_root>/workspace.
# Can also be set via WORKSPACE_DIR env var.
#
# In dev mode (no `--production`) this ALSO runs `just setup-remotes` so a fresh
# checkout is ready for `just sync` against the upstream subtrees. That step only
# records remote URLs (no network), is idempotent, and is intentionally skipped
# in production (a deployment does not need the upstream sync remotes). See
# docs/prd/3_just-task-runner.md FR2b.
[arg("production", long, value="true")]
[arg("workspace_dir", long, value="")]
setup production="false" workspace_dir="":
    ./scripts/alloc-dev-id.sh
    cd packages/software-agent-sdk && uv sync
    cd packages/OpenHands && npm install
    if [ "{{production}}" = "true" ]; then \
        echo "→ --production: building Agent Canvas production bundle (npm run build)"; \
        if [ -n "{{workspace_dir}}" ]; then \
            VITE_WORKING_DIR="{{workspace_dir}}/project" npm run build --prefix packages/OpenHands; \
        else \
            npm run build --prefix packages/OpenHands; \
        fi; \
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
