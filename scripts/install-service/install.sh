#!/usr/bin/env bash
#
# install.sh — Install the openhands-local systemd USER service.
#
# PRD: docs/prd/4_systemd-service-install.md
#
# Installs a per-user systemd unit that runs the workspace's local full-stack
# launcher (the same thing `just dev` runs: scripts/dev-local.sh) as a user
# service for the CURRENT user, wired to the path of THIS repository clone,
# then enables it to auto-start and starts it immediately. Idempotent: if the
# unit is already installed / known to the user manager, installation is
# skipped and the existing service is simply (re)started.
#
# This is a USER service: no root, no sudo. The unit lives under the current
# user's user-manager config (~/.config/systemd/user/) and is managed with
# `systemctl --user`. To start at boot (not just on login) the installer also
# enables lingering for the current user with `loginctl enable-linger`.
#
# Scope is Linux with systemd. On other platforms it prints a clear message and
# exits non-zero rather than trying to emulate systemd.
#
# Usage:
#   scripts/install-service/install.sh            # install for current user
#   scripts/install-service/install.sh --dry-run  # preview, no changes
#   scripts/install-service/install.sh --help

set -u

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_SRC="$SCRIPT_DIR/openhands.service"
UNIT_NAME="openhands.service"

# ── Defaults ─────────────────────────────────────────────────────────────────
DRY_RUN=0
ENABLE_LINGER=1            # 1: attempt `loginctl enable-linger` for boot autostart

# ── Terminal styling ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_CYAN=""; C_YELLOW=""
fi

log()      { printf '%s[install-service]%s %s\n' "$C_CYAN" "$C_RESET" "$1"; }
log_ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
log_warn() { printf '%s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
log_err()  { printf '%s[install-service] Error:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }

usage() {
  cat <<'EOF'
install.sh - Install the openhands-local systemd USER service

Installs the per-user systemd unit that runs scripts/dev-local.sh (equivalent
to `just dev`) as a USER service for the current user, wired to this
repository clone's path, enables it to start at boot (via lingering), and
starts it now. Idempotent: if already installed, just (re)starts the service.

No root or sudo required — this installs and manages a user service.

USAGE:
  scripts/install-service/install.sh [options]

OPTIONS:
  --dry-run          Print the resolved unit file and the commands that would
                     run, then exit without changing anything.
  --no-linger        Skip enabling lingering. WARNING: without lingering the
                     service starts at user login, not at boot.
  -h, --help         Show this help message

NOTES:
  - Requires a Linux host running systemd (a user manager, `systemctl --user`).
  - Must be run as the user who will own the service, NOT as root. If you used
    sudo, drop it — user services are per-user.
  - The owning user must have a readable, writable home directory: the launcher
    persists the shared session API key under
    ~/.openhands/agent-canvas/dev-local-api-key.
  - Manage the service with: systemctl --user <start|stop|restart|status> openhands
    and follow logs with: journalctl --user -u openhands -f
EOF
}

# ── arg parsing ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --no-linger)  ENABLE_LINGER=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) log_err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

run_or_preview() {
  # In dry-run, print the command; otherwise execute it.
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s$ %s\n' "$C_DIM" "$*" >&2
    return 0
  fi
  "$@"
}

# ── preflight: identity ───────────────────────────────────────────────────────
# A user service runs as the user who owns the user manager. Refuse root: there
# is no meaningful per-user install for root here, and installing under root's
# user config would not serve the person who cloned the repo.
if [ "$(id -u)" = 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$(id -u "${SUDO_USER:-}")" != 0 ]; then
    log_err "ran as root via sudo (SUDO_USER=$SUDO_USER). User services are per-user;"
    log_err "drop sudo and run this as yourself instead:"
    log_err "  scripts/install-service/install.sh"
    exit 1
  fi
  log_err "refusing to run as root. User services are per-user; run this as the"
  log_err "user who owns the repository clone, without sudo."
  exit 1
fi

SERVICE_USER="$(id -un)"
SERVICE_UID="$(id -u)"

# ── preflight: files ──────────────────────────────────────────────────────────
log "repo root: $REPO_ROOT"
log "service user (owner): $SERVICE_USER"

if [ ! -f "$UNIT_SRC" ]; then
  log_err "unit template not found: $UNIT_SRC"
  exit 1
fi
if [ ! -f "$REPO_ROOT/scripts/dev-local.sh" ]; then
  log_err "launcher not found: $REPO_ROOT/scripts/dev-local.sh"
  exit 1
fi

# ── preflight: user manager ──────────────────────────────────────────────────
# A user service needs the per-user systemd manager (systemctl --user). Its
# runtime socket lives under XDG_RUNTIME_DIR (/run/user/$UID by default), which
# only exists while the user manager is running.
have systemctl || { log_err "systemctl not found on PATH. Aborting."; exit 1; }

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$SERVICE_UID}"
if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then
  log_err "no usable HOME directory for user '$SERVICE_USER' ($HOME)."
  log_err "The launcher persists the session API key under ~/.openhands/agent-canvas/."
  exit 1
fi
export XDG_RUNTIME_DIR

# Is the user manager actually up? `systemctl --user is-system-running`:
#   - prints a state word (running, degraded, starting, stopping, maintenance,
#     offline) and exit 0 only for "running"; degrades/starting/etc. exit
#     non-zero but still mean a manager IS present and serving units.
#   - prints nothing useful + writes a "Failed to connect" error when there is
#     NO user manager for this user.
# So detect presence from the state word, not the exit code.
USER_MANAGER_RUNNING=0
if [ -d "$XDG_RUNTIME_DIR" ]; then
  RUN_STATE="$(systemctl --user is-system-running 2>/dev/null)"
  case "$RUN_STATE" in
    running|degraded|starting|stopping|maintenance|offline)
      USER_MANAGER_RUNNING=1 ;;
  esac
fi

# Absence vs. degraded: a degraded manager still serves units; an absent one
# cannot. The installer only refuses the real (non-dry-run) path on absence.
if [ "$USER_MANAGER_RUNNING" = 0 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    log_warn "no user systemd manager detected (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR)."
    log_warn "Dry-run will still render and preview; a real install would need the user manager."
  else
    log_err "no user systemd manager is running for user '$SERVICE_USER'."
    log_err "On most systems it starts at login. Re-login or start it, then re-run."
    log_err "For boot-time start, enable lingering: loginctl enable-linger $SERVICE_USER"
    exit 1
  fi
fi

# ── install destination ───────────────────────────────────────────────────────
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT_DIR="$XDG_CONFIG_HOME/systemd/user"
UNIT_DEST="$UNIT_DIR/$UNIT_NAME"

# ── already installed? (idempotency) ──────────────────────────────────────────
# Track the user manager's own truth, not a marker file: installed if the unit
# file exists OR the user manager lists it. Skip detection entirely when there
# is no user manager (dry-run on a machine without one).
ALREADY_INSTALLED=0
if [ "$USER_MANAGER_RUNNING" = 1 ]; then
  if [ -f "$UNIT_DEST" ]; then
    ALREADY_INSTALLED=1
  elif systemctl --user list-unit-files 2>/dev/null | grep -qE "^${UNIT_NAME}\b"; then
    ALREADY_INSTALLED=1
  fi
fi

if [ "$ALREADY_INSTALLED" = 1 ]; then
  log "service '$UNIT_NAME' is already installed; skipping install."
  if [ "$DRY_RUN" = 1 ]; then
    log "dry-run: would (re)start the existing service with:"
    run_or_preview systemctl --user restart "$UNIT_NAME"
    run_or_preview systemctl --user --no-pager status "$UNIT_NAME"
    exit 0
  fi
  log "(re)starting the service."
  systemctl --user restart "$UNIT_NAME" || {
    rc=$?
    log_err "failed to restart '$UNIT_NAME' (exit $rc)."
    exit "$rc"
  }
  systemctl --user --no-pager status "$UNIT_NAME" || true
  log_ok "service '$UNIT_NAME' (re)started."
  exit 0
fi

# ── install: render the unit ──────────────────────────────────────────────────
# Substitute the placeholder by writing to a temp file, then install it. The
# template stays untouched; it is the source, not the installed unit.
RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT
sed "s|%OPENHANDS_REPO_ROOT%|${REPO_ROOT}|g" "$UNIT_SRC" > "$RENDER" \
  || { log_err "failed to render unit file"; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: rendered unit for install at $UNIT_DEST (not written):"
  printf '%s---- begin %s ----%s\n' "$C_DIM" "$UNIT_DEST" "$C_RESET" >&2
  cat "$RENDER" >&2
  printf '%s---- end %s ----%s\n' "$C_DIM" "$UNIT_DEST" "$C_RESET" >&2
  log "dry-run: the following commands would run:"
  run_or_preview mkdir -p "$UNIT_DIR"
  run_or_preview install -m 0644 "$RENDER" "$UNIT_DEST"
  run_or_preview systemctl --user daemon-reload
  run_or_preview systemctl --user enable "$UNIT_NAME"
  if [ "$ENABLE_LINGER" = 1 ]; then
    run_or_preview loginctl enable-linger "$SERVICE_USER"
  fi
  run_or_preview systemctl --user start "$UNIT_NAME"
  run_or_preview systemctl --user --no-pager status "$UNIT_NAME"
  exit 0
fi

# ── install: write, reload, enable, linger, start ─────────────────────────────
mkdir -p "$UNIT_DIR" || { log_err "failed to create unit dir: $UNIT_DIR"; exit 1; }
install -m 0644 "$RENDER" "$UNIT_DEST" \
  || { log_err "failed to install unit to $UNIT_DEST"; exit 1; }
log_ok "installed unit: $UNIT_DEST"

systemctl --user daemon-reload || { log_err "systemctl --user daemon-reload failed"; exit $?; }
systemctl --user enable "$UNIT_NAME" || { log_err "failed to enable $UNIT_NAME"; exit $?; }
log_ok "enabled '$UNIT_NAME' (starts at user login)."

if [ "$ENABLE_LINGER" = 1 ]; then
  if have loginctl; then
    if loginctl enable-linger "$SERVICE_USER" 2>/dev/null; then
      log_ok "enabled lingering for '$SERVICE_USER' (service starts at boot)."
    else
      log_warn "could not enable lingering for '$SERVICE_USER' (loginctl enable-linger failed)."
      log_warn "Without lingering the service starts at user login, not at boot."
      log_warn "Run this yourself if you need boot-time start: loginctl enable-linger $SERVICE_USER"
    fi
  else
    log_warn "loginctl not found; cannot enable lingering."
    log_warn "Without lingering the service starts at user login, not at boot."
  fi
fi

systemctl --user start "$UNIT_NAME" || { log_err "failed to start $UNIT_NAME"; exit $?; }
log_ok "started '$UNIT_NAME'."

systemctl --user --no-pager status "$UNIT_NAME" || true

cat <<EOF

${C_GREEN}Done.${C_RESET} The openhands user service is installed, enabled, and running.

  service user : $SERVICE_USER
  working dir  : $REPO_ROOT
  launcher     : $REPO_ROOT/scripts/dev-local.sh  (equivalent to: just dev)
  unit file    : $UNIT_DEST
  manage       : systemctl --user <start|stop|restart|status> openhands
  logs         : journalctl --user -u openhands -f
EOF
