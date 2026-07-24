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
  echo Linting…

# Install systemd service files
install-service:
  @echo Installing service files
  # TODO
