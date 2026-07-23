#!/usr/bin/env bash
#
# dev-local.sh — Local full-stack launcher for the openhands-full-stack workspace.
#
# Starts, strictly from the code in THIS repository:
#   backend   OpenHands Agent Server from packages/software-agent-sdk,
#             run with `uv run` over the local uv workspace (workspace
#             sources only — never an openhands-* release from PyPI).
#   frontend  Agent Canvas Vite dev server from packages/agent-canvas
#             (`npm run dev:frontend`), proxying /api to the local backend.
#
# Modeled on the upstream `agent-canvas` CLI (same --frontend-only /
# --backend-only split), but it never fetches the agent-server via uvx from
# PyPI and never installs the published @openhands/agent-canvas package.
# The OpenHands Automation backend is intentionally NOT started — it is not
# vendored in this repository.
#
# Crash-linked: every service runs in its own process group. If any service
# exits — crash or clean — all remaining services are stopped and the
# launcher exits with that service's status.
#
# Compatible with the stock macOS bash 3.2 as well as bash 4/5 on Linux.
#
# Usage: scripts/dev-local.sh [options]        (see --help)

set -u
set -m  # job control: each background service becomes its own process group

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CANVAS_DIR="$REPO_ROOT/packages/agent-canvas"
SDK_DIR="$REPO_ROOT/packages/software-agent-sdk"

# ── Defaults (ports mirror packages/agent-canvas/config/defaults.json) ───────
STACK_PORT=9000            # single-origin entry: ingress routes to everything
UI_PORT=8000               # Vite dev server, direct (debug)
BACKEND_PORT=18000         # agent-server, direct (debug); upstream default
BACKEND_BIND_HOST="127.0.0.1"
BACKEND_HOST=""            # host:port proxies target; derived if empty
FRONTEND_ONLY=0
BACKEND_ONLY=0
NO_INGRESS=0
DRY_RUN=0

# Extra flags for `uv run` (e.g. DEV_LOCAL_UV_FLAGS="--no-frozen").
UV_FLAGS="--frozen${DEV_LOCAL_UV_FLAGS:+ $DEV_LOCAL_UV_FLAGS}"

# ── Terminal styling ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_CYAN=$'\033[36m'; C_MAGENTA=$'\033[35m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_CYAN=""; C_MAGENTA=""
fi

log()      { printf '%s[dev-local]%s %s\n' "$C_CYAN" "$C_RESET" "$1"; }
log_ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
log_err()  { printf '%s[dev-local] Error:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }

usage() {
  cat <<EOF
dev-local.sh - Run the openhands-full-stack local stack from THIS repository

Starts the Agent Canvas frontend (Vite dev server, packages/agent-canvas)
and the OpenHands Agent Server backend (uv run, packages/software-agent-sdk),
unified behind a single-origin ingress port (the repo's own standalone
scripts/ingress.mjs). Everything is launched strictly from local sources:
no openhands-* package is fetched from PyPI and no @openhands/agent-canvas
release is installed.

If any service exits, all remaining services are stopped and the launcher
exits with the same status.

USAGE:
  scripts/dev-local.sh [options]

OPTIONS:
  --stack-port <port>       Single-origin entry point for the whole stack
                            (ingress; use this URL to browse)  (default: 9000)
  -p, --port <port>         Frontend (Vite) direct port, kept for debugging
                                                              (default: 8000)
  --backend-port <port>     Agent-server direct port, kept for debugging
                                                              (default: 18000)
  --host <addr>             Agent-server bind address    (default: 127.0.0.1)
  --backend-host <host:port>
                            Backend the proxies target. Only useful with
                            --frontend-only.       (default: 127.0.0.1:18000)
  --no-ingress              Do not start the ingress; direct ports only
  --frontend-only           Frontend dev server + ingress only
  --backend-only            Local agent-server + ingress only
  --dry-run                 Print resolved config and commands, then exit
  -h, --help                Show this help message

ENVIRONMENT VARIABLES:
  LOCAL_BACKEND_API_KEY     Session API key shared by frontend and backend.
                            Auto-generated and persisted at
                            ~/.openhands/agent-canvas/dev-local-api-key
                            if unset, so restarts keep the same key.
  DEV_LOCAL_UV_FLAGS        Extra flags appended to \`uv run --frozen\`.

EXAMPLES:
  scripts/dev-local.sh                       # full local stack behind :9000
  scripts/dev-local.sh --stack-port 12000    # combined stack on :12000
  scripts/dev-local.sh --backend-only        # agent-server + ingress
  scripts/dev-local.sh --frontend-only --backend-host 192.168.1.20:18000

NOTES:
  - Stack (share this URL):  http://<server>:<stack-port>   single origin;
    /api, /sockets, /docs etc. route to the backend, the rest to the frontend
  - Frontend direct (debug): http://<server>:<port>
  - Backend direct (debug):  http://127.0.0.1:<backend-port>/docs
  - The frontend uses same-origin API calls, so remote browsers work through
    the stack port or the frontend port. The backend binds loopback by
    default; reach it from other machines via those ports, or pass
    --host 0.0.0.0 for direct access.
  - The OpenHands Automation backend is not started (not part of this repo),
    so automation features in the UI are unavailable.
EOF
}

# ── Argument parsing ─────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-only) FRONTEND_ONLY=1 ;;
    --backend-only)  BACKEND_ONLY=1 ;;
    --no-ingress)    NO_INGRESS=1 ;;
    --stack-port)
      [ $# -ge 2 ] || { log_err "$1 requires a value"; exit 1; }
      STACK_PORT="$2"; shift ;;
    --stack-port=*) STACK_PORT="${1#*=}" ;;
    -p|--port)
      [ $# -ge 2 ] || { log_err "$1 requires a value"; exit 1; }
      UI_PORT="$2"; shift ;;
    --port=*) UI_PORT="${1#*=}" ;;
    --backend-port)
      [ $# -ge 2 ] || { log_err "$1 requires a value"; exit 1; }
      BACKEND_PORT="$2"; shift ;;
    --backend-port=*) BACKEND_PORT="${1#*=}" ;;
    --host)
      [ $# -ge 2 ] || { log_err "$1 requires a value"; exit 1; }
      BACKEND_BIND_HOST="$2"; shift ;;
    --host=*) BACKEND_BIND_HOST="${1#*=}" ;;
    --backend-host)
      [ $# -ge 2 ] || { log_err "$1 requires a value"; exit 1; }
      BACKEND_HOST="$2"; shift ;;
    --backend-host=*) BACKEND_HOST="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      log_err "Unknown option: $1 (see --help)"
      exit 1 ;;
  esac
  shift
done

if [ "$FRONTEND_ONLY" = 1 ] && [ "$BACKEND_ONLY" = 1 ]; then
  log_err "--frontend-only and --backend-only cannot be used together"
  exit 1
fi

case "$UI_PORT" in *[!0-9]*|"") log_err "Invalid --port: $UI_PORT"; exit 1 ;; esac
case "$BACKEND_PORT" in *[!0-9]*|"") log_err "Invalid --backend-port: $BACKEND_PORT"; exit 1 ;; esac
case "$STACK_PORT" in *[!0-9]*|"") log_err "Invalid --stack-port: $STACK_PORT"; exit 1 ;; esac

LAUNCH_FRONTEND=1; [ "$BACKEND_ONLY" = 1 ] && LAUNCH_FRONTEND=0
LAUNCH_BACKEND=1;  [ "$FRONTEND_ONLY" = 1 ] && LAUNCH_BACKEND=0
LAUNCH_INGRESS=1;  [ "$NO_INGRESS" = 1 ] && LAUNCH_INGRESS=0

# Host:port the proxies (Vite dev proxy and ingress) target. When we launch
# the backend ourselves it is always the local one; --backend-host only
# matters in --frontend-only mode.
if [ -z "$BACKEND_HOST" ]; then
  BACKEND_HOST="127.0.0.1:$BACKEND_PORT"
fi
BACKEND_URL="http://$BACKEND_HOST"

# Where the ingress sends everything that is not a backend path.
if [ "$LAUNCH_FRONTEND" = 1 ]; then
  INGRESS_DEFAULT="http://127.0.0.1:$UI_PORT"
else
  INGRESS_DEFAULT="$BACKEND_URL"
fi

# Paths the ingress routes to the agent-server. Mirrors the Vite dev proxy
# list in packages/agent-canvas/vite.config.ts.
BACKEND_ROUTES="/api /sockets /server_info /alive /health /ready /docs /redoc /openapi.json"

# ── Session API key (shared by frontend and backend) ─────────────────────────
# Mirrors upstream behaviour: auto-generate once, persist across restarts.
KEY_FILE="$HOME/.openhands/agent-canvas/dev-local-api-key"
if [ -n "${LOCAL_BACKEND_API_KEY:-}" ]; then
  API_KEY="$LOCAL_BACKEND_API_KEY"
  KEY_SOURCE="LOCAL_BACKEND_API_KEY env var"
elif [ -s "$KEY_FILE" ]; then
  API_KEY="$(cat "$KEY_FILE")"
  KEY_SOURCE="persisted ($KEY_FILE)"
else
  if command -v openssl >/dev/null 2>&1; then
    API_KEY="$(openssl rand -hex 32)"
  else
    API_KEY="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  fi
  mkdir -p "$(dirname "$KEY_FILE")"
  umask_prev="$(umask)"; umask 177
  printf '%s' "$API_KEY" > "$KEY_FILE"
  umask "$umask_prev"
  KEY_SOURCE="generated and persisted ($KEY_FILE)"
fi

# ── Resolved commands ────────────────────────────────────────────────────────
# Backend: `uv run` inside the SDK checkout resolves openhands-sdk,
# openhands-tools, openhands-workspace and openhands-agent-server as local
# uv-workspace members — this is what guarantees local sources, in contrast
# to the upstream CLI's `uvx --from openhands-agent-server==<release>`.
BACKEND_CMD="uv run $UV_FLAGS agent-server --host $BACKEND_BIND_HOST --port $BACKEND_PORT"
FRONTEND_CMD="npm run dev:frontend"

# The ingress is the repo's own standalone reverse proxy (an upstream file,
# consumed unmodified). It unifies the stack behind one origin so browsers on
# other machines never need to reach the backend port directly.
build_ingress_args() {
  set -- --port "$STACK_PORT"
  local _route
  for _route in $BACKEND_ROUTES; do
    set -- "$@" --route "$_route=$BACKEND_URL"
  done
  set -- "$@" --default "$INGRESS_DEFAULT"
  printf '%s ' "$@"
}
INGRESS_ARGS="$(build_ingress_args)"
INGRESS_CMD="node scripts/ingress.mjs $INGRESS_ARGS"

MODE="full stack"
[ "$FRONTEND_ONLY" = 1 ] && MODE="frontend only"
[ "$BACKEND_ONLY" = 1 ] && MODE="backend only"
[ "$LAUNCH_INGRESS" = 1 ] && MODE="$MODE + ingress"

if [ "$DRY_RUN" = 1 ]; then
  echo "mode:            $MODE"
  echo "repo root:       $REPO_ROOT"
  [ "$LAUNCH_BACKEND" = 1 ] && {
    echo "backend cwd:     $SDK_DIR"
    echo "backend cmd:     $BACKEND_CMD"
    echo "backend env:     PYTHONUTF8=1 OH_SESSION_API_KEYS_0=<key: $KEY_SOURCE>"
  }
  [ "$LAUNCH_FRONTEND" = 1 ] && {
    echo "frontend cwd:    $CANVAS_DIR"
    echo "frontend cmd:    $FRONTEND_CMD"
    echo "frontend env:    VITE_FRONTEND_PORT=$UI_PORT VITE_BACKEND_HOST=$BACKEND_HOST VITE_SESSION_API_KEY=<key>"
  }
  [ "$LAUNCH_INGRESS" = 1 ] && {
    echo "ingress cwd:     $CANVAS_DIR"
    echo "ingress cmd:     $INGRESS_CMD"
    echo "stack url:       http://localhost:$STACK_PORT"
  }
  [ "$LAUNCH_FRONTEND" = 1 ] && echo "ui url (debug):  http://localhost:$UI_PORT"
  [ "$LAUNCH_BACKEND" = 1 ] && echo "api url (debug): http://127.0.0.1:$BACKEND_PORT/docs"
  exit 0
fi

# ── Preflight checks ─────────────────────────────────────────────────────────
[ -d "$CANVAS_DIR" ] || { log_err "Missing $CANVAS_DIR — run from a full checkout"; exit 1; }
[ -d "$SDK_DIR" ]    || { log_err "Missing $SDK_DIR — run from a full checkout"; exit 1; }

if [ "$LAUNCH_BACKEND" = 1 ]; then
  command -v uv >/dev/null 2>&1 || {
    log_err "uv is required to run the local agent-server."
    log_err "Install: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
  }
fi

if [ "$LAUNCH_FRONTEND" = 1 ] || [ "$LAUNCH_INGRESS" = 1 ]; then
  command -v node >/dev/null 2>&1 || { log_err "Node.js 22.12+ is required."; exit 1; }
  command -v npm  >/dev/null 2>&1 || { log_err "npm is required."; exit 1; }
  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    log_err "Node.js 22.12+ required, found $(node --version)"
    exit 1
  fi
fi
if [ "$LAUNCH_INGRESS" = 1 ] && [ ! -f "$CANVAS_DIR/scripts/ingress.mjs" ]; then
  log_err "Ingress script not found at packages/agent-canvas/scripts/ingress.mjs."
  log_err "Use --no-ingress or update the agent-canvas subtree."
  exit 1
fi

port_in_use() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}
[ "$LAUNCH_FRONTEND" = 1 ] && port_in_use "$UI_PORT" && {
  log_err "Port $UI_PORT is already in use (frontend). Use --port."; exit 1; }
[ "$LAUNCH_BACKEND" = 1 ] && port_in_use "$BACKEND_PORT" && {
  log_err "Port $BACKEND_PORT is already in use (backend). Use --backend-port."; exit 1; }
[ "$LAUNCH_INGRESS" = 1 ] && port_in_use "$STACK_PORT" && {
  log_err "Port $STACK_PORT is already in use (ingress). Use --stack-port."; exit 1; }

# Install the frontend's dev dependencies if needed (the ingress also uses
# them). This installs node_modules for the LOCAL package — it does not
# install the published @openhands/agent-canvas application.
if { [ "$LAUNCH_FRONTEND" = 1 ] || [ "$LAUNCH_INGRESS" = 1 ]; } && [ ! -d "$CANVAS_DIR/node_modules" ]; then
  log "node_modules missing — running npm install in packages/agent-canvas ..."
  (cd "$CANVAS_DIR" && npm install) || { log_err "npm install failed"; exit 1; }
fi

# ── Service management ───────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""
INGRESS_PID=""
SHUTTING_DOWN=0

prefix_logs() { # prefix_logs <name> <color>
  local _name="$1" _color="$2" _line
  while IFS= read -r _line; do
    printf '%s[%s]%s %s\n' "$_color" "$_name" "$C_RESET" "$_line"
  done
}

start_backend() {
  (
    set -o pipefail
    cd "$SDK_DIR" || exit 1
    export PYTHONUTF8=1
    export OH_SESSION_API_KEYS_0="$API_KEY"
    # shellcheck disable=SC2086  # UV_FLAGS is intentionally word-split
    uv run $UV_FLAGS agent-server \
      --host "$BACKEND_BIND_HOST" --port "$BACKEND_PORT" 2>&1 \
      | prefix_logs backend "$C_MAGENTA"
  ) &
  BACKEND_PID=$!
  log "backend  starting (pid $BACKEND_PID): $BACKEND_CMD"
}

start_frontend() {
  (
    set -o pipefail
    cd "$CANVAS_DIR" || exit 1
    export VITE_FRONTEND_PORT="$UI_PORT"
    # Server-side proxy target only. VITE_BACKEND_BASE_URL is deliberately
    # NOT set: without it the app falls back to window.location.origin, so
    # browsers use same-origin API calls that the ingress and the Vite dev
    # proxy forward to the backend — required for remote clients.
    export VITE_BACKEND_HOST="$BACKEND_HOST"
    export VITE_SESSION_API_KEY="$API_KEY"
    npm run dev:frontend 2>&1 | prefix_logs frontend "$C_CYAN"
  ) &
  FRONTEND_PID=$!
  log "frontend starting (pid $FRONTEND_PID): $FRONTEND_CMD"
}

start_ingress() {
  (
    set -o pipefail
    cd "$CANVAS_DIR" || exit 1
    # shellcheck disable=SC2086  # INGRESS_ARGS is intentionally word-split
    node scripts/ingress.mjs $INGRESS_ARGS 2>&1 | prefix_logs ingress "$C_GREEN"
  ) &
  INGRESS_PID=$!
  log "ingress  starting (pid $INGRESS_PID): $INGRESS_CMD"
}

kill_group() { # kill_group <pid> <signal>
  [ -n "$1" ] || return 0
  kill "-$2" -- "-$1" 2>/dev/null
}

group_alive() { # group_alive <pid>
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

shutdown_all() {
  [ "$SHUTTING_DOWN" = 1 ] && return 0
  SHUTTING_DOWN=1
  log "shutting down remaining services ..."
  kill_group "$BACKEND_PID" TERM
  kill_group "$FRONTEND_PID" TERM
  kill_group "$INGRESS_PID" TERM
  # Grace period, then force-kill anything still alive.
  local _i=0
  while [ "$_i" -lt 20 ]; do
    group_alive "$BACKEND_PID" || group_alive "$FRONTEND_PID" \
      || group_alive "$INGRESS_PID" || break
    sleep 0.5
    _i=$((_i + 1))
  done
  kill_group "$BACKEND_PID" KILL
  kill_group "$FRONTEND_PID" KILL
  kill_group "$INGRESS_PID" KILL
}

on_signal() {
  trap - INT TERM
  shutdown_all
  wait 2>/dev/null
  exit 130
}
trap on_signal INT TERM

# ── Launch ───────────────────────────────────────────────────────────────────
log "mode: $MODE"
log "api key: $KEY_SOURCE"

[ "$LAUNCH_BACKEND" = 1 ] && start_backend
[ "$LAUNCH_FRONTEND" = 1 ] && start_frontend
[ "$LAUNCH_INGRESS" = 1 ] && start_ingress

# Process groups are set; turn job control back off so bash does not print
# asynchronous job-status notices ("Terminated: ...") during shutdown.
set +m

echo ""
[ "$LAUNCH_INGRESS" = 1 ] && log_ok "Stack (once ready, single origin): http://localhost:$STACK_PORT"
[ "$LAUNCH_FRONTEND" = 1 ] && log_ok "Frontend direct (debug):           http://localhost:$UI_PORT"
[ "$LAUNCH_BACKEND" = 1 ] && log_ok "Backend direct (debug):            http://127.0.0.1:$BACKEND_PORT/docs"
[ "$LAUNCH_BACKEND" = 0 ] && \
  log "proxies target http://$BACKEND_HOST (start a backend there)"
echo ""

# ── Monitor: first service to exit takes the whole stack down ────────────────
BACKEND_READY=0
EXIT_CODE=0

check_ready() {
  [ "$LAUNCH_BACKEND" = 1 ] || return 0
  [ "$BACKEND_READY" = 1 ] && return 0
  command -v curl >/dev/null 2>&1 || { BACKEND_READY=1; return 0; }
  if curl -fsS -m 2 -H "X-Session-API-Key: $API_KEY" \
      "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then
    BACKEND_READY=1
    log_ok "backend ready at http://127.0.0.1:$BACKEND_PORT"
  fi
}

while :; do
  if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID"; EXIT_CODE=$?
    log_err "backend exited (status $EXIT_CODE) — stopping everything"
    BACKEND_PID=""
    shutdown_all
    break
  fi
  if [ -n "$FRONTEND_PID" ] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    wait "$FRONTEND_PID"; EXIT_CODE=$?
    log_err "frontend exited (status $EXIT_CODE) — stopping everything"
    FRONTEND_PID=""
    shutdown_all
    break
  fi
  if [ -n "$INGRESS_PID" ] && ! kill -0 "$INGRESS_PID" 2>/dev/null; then
    wait "$INGRESS_PID"; EXIT_CODE=$?
    log_err "ingress exited (status $EXIT_CODE) — stopping everything"
    INGRESS_PID=""
    shutdown_all
    break
  fi
  check_ready
  sleep 1
done

wait 2>/dev/null
log "all services stopped (exit $EXIT_CODE)"
exit "$EXIT_CODE"
