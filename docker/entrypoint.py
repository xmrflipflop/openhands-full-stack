#!/usr/bin/env python3
"""ymai-openhands all-in-one entrypoint — launches the stack from local sources.

Run under tini (PID 1 reaping). Starts three services and exposes them behind a
single ingress port (default 8000):

  1. Agent Server   on AGENT_SERVER_PORT  (default 18000)
     Launched from the local SDK venv built at image time:
       /opt/sdk/.venv/bin/python -m openhands.agent_server
     Override to a fresh checkout via OH_AGENT_SERVER_LOCAL_PATH (mirrors
     bin/agent-canvas.mjs -> scripts/dev-safe.mjs buildAgentServerCommand's
     local-path branch: uvx --reinstall --from <path>/openhands-agent-server
     --with-editable <path>/{openhands-sdk,openhands-tools,openhands-workspace}).
  2. Automation     on AUTOMATION_PORT     (default 18001)
     Launched from the same venv:
       /opt/sdk/.venv/bin/python -m uvicorn openhands.automation.app:app
     Override the source/version at runtime via OH_AUTOMATION_LOCAL_PATH,
     OH_AUTOMATION_GIT_REF, or OH_AUTOMATION_VERSION (uvx, mirroring
     dev-with-automation.mjs buildAutomationCommand).
  3. Static server  on PORT                (default 8000)
     Routes /api/automation/* -> automation, /api/* -> agent-server, and serves
     the local frontend build for everything else.

Local-source launch overrides:
  OH_AGENT_SERVER_LOCAL_PATH  Absolute path to a software-agent-sdk checkout
                              (must contain openhands-agent-server, openhands-sdk,
                              openhands-tools, openhands-workspace). Rebuilds the
                              agent-server from that path via uvx with editable
                              installs instead of the baked-in venv.
  OH_AUTOMATION_LOCAL_PATH    Absolute path to an openhands-automation checkout.
  OH_AUTOMATION_GIT_REF       Git ref for the automation backend (uvx).
  OH_AUTOMATION_VERSION       Specific PyPI version for automation (uvx).
  OH_AUTOMATION_REPO          Git repo URL for automation
                              (default: https://github.com/OpenHands/automation).
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from shutil import which as shutil_which
from typing import Optional

# ── Layout baked into the image by docker/Dockerfile ───────────────────────────
SDK_DIR = Path("/opt/sdk")
SDK_VENV = SDK_DIR / ".venv"
AC_DIR = Path("/opt/agent-canvas")
CANVAS_DIR = AC_DIR / "frontend"
STATIC_SERVER = AC_DIR / "static-server.mjs"
RUNTIME_SERVICES_CLI = AC_DIR / "runtime-services-info.mjs"
CANVAS_TOOLS_DIR = AC_DIR / "tools"
# Single source of truth for ports/paths/versions — read directly, no separate
# defaults.env generation stage needed (the bash entrypoint sourced one).
DEFAULTS_JSON = Path("/opt/agent-canvas/config/defaults.json")
DEFAULT_AUTOMATION_REPO = "https://github.com/OpenHands/automation"

# Cancellation flag set by the SIGTERM/SIGINT handler.
_shutting_down = threading.Event()


def log(msg: str) -> None:
    print(f"[ymai-openhands] {msg}", flush=True)


def log_error(msg: str) -> None:
    print(f"[ymai-openhands] ERROR: {msg}", file=sys.stderr, flush=True)


# ── Config ─────────────────────────────────────────────────────────────────────
def load_defaults() -> dict:
    if DEFAULTS_JSON.is_file():
        try:
            return json.loads(DEFAULTS_JSON.read_text())
        except (OSError, json.JSONDecodeError) as err:
            log_error(f"Could not read {DEFAULTS_JSON}: {err}; using built-ins")
    return {
        "ports": {"agentServer": 18000, "automation": 18001, "proxy": 8000},
        "paths": {
            "stateSubdir": "agent-canvas",
            "conversations": "agent-canvas/conversations",
            "bashEvents": "agent-canvas/bash_events",
            "automationDb": "automation/automations.db",
            "canvasBasePath": "/canvas",
        },
        "versions": {"automation": "1.1.7"},
    }


def environ_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        return int(raw)
    except ValueError:
        log_error(f"{name}={raw!r} is not an integer; using {fallback}")
        return fallback


# ── Secret / API-key persistence ───────────────────────────────────────────────
def random_hex_key() -> str:
    # 32 random bytes → 64-char hex, matching the bash entrypoint's output.
    return secrets.token_hex(32)


def get_or_create_secret(path: Path, label: str) -> str:
    existing = os.environ.get(label)
    if existing:
        return existing
    if path.is_file():
        try:
            return path.read_text().strip()
        except OSError as err:
            log_error(f"Could not read {path}: {err}; regenerating")
    key = random_hex_key()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(key)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    log(f"Generated {label} (persisted to {path})")
    return key


# ── Port readiness ─────────────────────────────────────────────────────────────
def wait_for_port(port: int, name: str, max_wait: float = 60.0) -> bool:
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        if _shutting_down.is_set():
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                log(f"{name} is ready on port {port}")
                return True
        except OSError:
            time.sleep(1)
    log(f"WARNING: {name} on port {port} did not become ready within {max_wait:.0f}s")
    return False


# ── Command builders (mirror dev-safe.mjs / dev-with-automation.mjs) ───────────
SDK_SUBDIRS = (
    "openhands-agent-server",
    "openhands-sdk",
    "openhands-tools",
    "openhands-workspace",
)


def validate_local_sdk_path(p: str) -> None:
    if not os.path.isabs(p):
        raise SystemExit(f"OH_AGENT_SERVER_LOCAL_PATH must be an absolute path, got: {p}")
    if not os.path.isdir(p):
        raise SystemExit(f"OH_AGENT_SERVER_LOCAL_PATH does not exist: {p}")
    for sub in SDK_SUBDIRS:
        if not os.path.isdir(os.path.join(p, sub)):
            raise SystemExit(
                f"OH_AGENT_SERVER_LOCAL_PATH is missing expected workspace package {sub!r}: {p}/{sub}"
            )


def build_agent_server_cmd() -> list[str]:
    local_path = os.environ.get("OH_AGENT_SERVER_LOCAL_PATH")
    if local_path:
        validate_local_sdk_path(local_path)
        log(f"agent-server: local checkout at {local_path} (uvx --reinstall + editable)")
        return [
            "uvx", "--reinstall",
            "--from", f"{local_path}/openhands-agent-server",
            "--with-editable", f"{local_path}/openhands-sdk",
            "--with-editable", f"{local_path}/openhands-tools",
            "--with-editable", f"{local_path}/openhands-workspace",
            "agent-server",
        ]
    venv_python = SDK_VENV / "bin" / "python"
    if venv_python.exists():
        log(f"agent-server: local venv at {SDK_VENV} (from local sources)")
        return [str(venv_python), "-m", "openhands.agent_server"]
    if shutil_which("openhands-agent-server"):
        log("agent-server: openhands-agent-server on PATH")
        return ["openhands-agent-server"]
    raise SystemExit(
        "Cannot locate agent-server. Set OH_AGENT_SERVER_LOCAL_PATH or rebuild the image."
    )


def automation_available() -> bool:
    venv_python = SDK_VENV / "bin" / "python"
    if not venv_python.exists():
        return False
    try:
        result = subprocess.run(
            [str(venv_python), "-c", "import openhands.automation"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except OSError:
        return False
    return result.returncode == 0


def build_automation_cmd() -> tuple[list[str], str]:
    """Return (cmd, source_label). Empty cmd means automation should be skipped."""
    local_path = os.environ.get("OH_AUTOMATION_LOCAL_PATH")
    if local_path:
        if not os.path.isdir(local_path):
            raise SystemExit(f"OH_AUTOMATION_LOCAL_PATH does not exist: {local_path}")
        log(f"automation: local checkout at {local_path} (uvx --reinstall)")
        return (
            ["uvx", "--reinstall", "--from", local_path, "uvicorn", "openhands.automation.app:app"],
            "local",
        )
    git_ref = os.environ.get("OH_AUTOMATION_GIT_REF")
    if git_ref:
        repo = os.environ.get("OH_AUTOMATION_REPO", DEFAULT_AUTOMATION_REPO)
        log(f"automation: git ref {git_ref} ({repo})")
        return (
            ["uvx", "--refresh", "--from", f"git+{repo}@{git_ref}", "uvicorn", "openhands.automation.app:app"],
            "git",
        )
    version = os.environ.get("OH_AUTOMATION_VERSION")
    if version:
        log(f"automation: PyPI {version}")
        return (
            ["uvx", "--from", f"openhands-automation=={version}", "uvicorn", "openhands.automation.app:app"],
            "pinned",
        )
    venv_python = SDK_VENV / "bin" / "python"
    if venv_python.exists() and automation_available():
        log(f"automation: local venv at {SDK_VENV}")
        return (
            [str(venv_python), "-m", "uvicorn", "openhands.automation.app:app"],
            "venv",
        )
    log("WARNING: automation backend not available in the venv and no OH_AUTOMATION_* override set; skipping automation.")
    return [], ""


# ── Runtime-services info block ─────────────────────────────────────────────────
def build_runtime_services_info(
    agent_server_url: str, automation_url: Optional[str]
) -> str:
    """Emit the runtime-services JSON via the same Node builder the dev stack uses
    (scripts/runtime-services-info.mjs), so the agent's <RUNTIME_SERVICES> prompt
    block never drifts from the launcher's own shape. The builder is dependency-free
    (only node:process/node:url) and the runtime image ships node.
    """
    args: list[str] = [
        "node", str(RUNTIME_SERVICES_CLI),
        "--mode", "docker",
        "--agent-host-alias", "127.0.0.1",
        "--agent-server-url", agent_server_url,
    ]
    if automation_url:
        args += ["--automation-url", automation_url]
    completed = subprocess.run(
        args, capture_output=True, text=True, env=os.environ.copy()
    )
    if completed.returncode != 0:
        raise SystemExit(
            f"runtime-services-info builder failed (exit {completed.returncode}): {completed.stderr.strip()}"
        )
    return completed.stdout.strip()


# ── Service supervisor ─────────────────────────────────────────────────────────
class Service:
    def __init__(self, name: str, cmd: list[str], env: dict[str, str], cwd: Optional[Path]):
        self.name = name
        self.cmd = cmd
        self.env = env
        self.cwd = cwd
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> None:
        # start_new_session=True makes each service the leader of its own process
        # group so SIGTERM/SIGKILL can later target the whole tree (uvx -> python,
        # uvicorn -> workers) rather than just the wrapper shell.
        self.proc = subprocess.Popen(
            self.cmd,
            env=self.env,
            cwd=str(self.cwd) if self.cwd else None,
            stdout=sys.stdout,
            stderr=sys.stderr,
            start_new_session=True,
        )
        log(f"{self.name}: started (pid {self.proc.pid})")

    def stop(self, signum: int) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        _kill_process_group(self.proc.pid, signum)

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


def _kill_process_group(pid: int, signum: int) -> None:
    try:
        os.killpg(os.getpgid(pid), signum)
    except (ProcessLookupError, PermissionError):
        pass


# ── Main ───────────────────────────────────────────────────────────────────────
def main() -> int:
    home = Path(os.environ.get("HOME") or "/home/openhands")
    defaults = load_defaults()
    ports = defaults["ports"]
    paths = defaults["paths"]

    port = environ_int("PORT", ports["proxy"])
    agent_server_port = environ_int("AGENT_SERVER_PORT", ports["agentServer"])
    automation_port = environ_int("AUTOMATION_PORT", ports["automation"])
    agent_canvas_base_path = os.environ.get(
        "AGENT_CANVAS_BASE_PATH", paths.get("canvasBasePath", "/canvas")
    )
    start_automation = os.environ.get("START_AUTOMATION", "1") == "1"

    openhands_dir = home / ".openhands"
    state_dir = openhands_dir / paths.get("stateSubdir", "agent-canvas")
    os.environ.setdefault("OH_PERSISTENCE_DIR", str(openhands_dir))
    os.environ.setdefault(
        "OH_CONVERSATIONS_PATH", str(openhands_dir / paths.get("conversations", "agent-canvas/conversations"))
    )
    os.environ.setdefault(
        "OH_BASH_EVENTS_DIR", str(openhands_dir / paths.get("bashEvents", "agent-canvas/bash_events"))
    )

    # ── OH_SECRET_KEY (settings/secrets encryption) ──
    secret_key = get_or_create_secret(state_dir / "secret-key.txt", "OH_SECRET_KEY")
    os.environ["OH_SECRET_KEY"] = secret_key

    # ── Session API key ──
    session_key = os.environ.get("OH_SESSION_API_KEYS_0") or os.environ.get("LOCAL_BACKEND_API_KEY")
    if not session_key:
        api_key_file = state_dir / "api-key.txt"
        if api_key_file.is_file():
            try:
                session_key = api_key_file.read_text().strip()
            except OSError:
                session_key = None
        if not session_key:
            session_key = random_hex_key()
            api_key_file.parent.mkdir(parents=True, exist_ok=True)
            api_key_file.write_text(session_key)
            try:
                api_key_file.chmod(0o600)
            except OSError:
                pass
            log(f"Generated session API key (persisted to {api_key_file})")
        os.environ["OH_SESSION_API_KEYS_0"] = session_key
        os.environ["LOCAL_BACKEND_API_KEY"] = session_key

    # Both backends share this key + the X-Session-API-Key header.
    os.environ.setdefault("OPENHANDS_AUTOMATION_API_KEY", session_key)
    os.environ.setdefault("AUTOMATION_LOCAL_API_KEY", session_key)
    os.environ.setdefault("AUTOMATION_AGENT_SERVER_API_KEY", session_key)
    os.environ.setdefault("OPENHANDS_REMOTE_WS_READY_REQUIRED", "false")

    # Loopback URLs so the automation sandbox can call back into the agent-server.
    agent_server_url = os.environ.get(
        "AGENT_SERVER_URL", f"http://127.0.0.1:{agent_server_port}"
    )
    os.environ["AGENT_SERVER_URL"] = agent_server_url
    os.environ.setdefault(
        "AUTOMATION_AGENT_SERVER_URL", f"http://127.0.0.1:{agent_server_port}"
    )
    # Legacy canvas_ui_tool compatibility module importable during conversation restore.
    os.environ.setdefault("OH_EXTRA_PYTHON_PATH", str(CANVAS_TOOLS_DIR))

    for d in (
        os.environ["OH_PERSISTENCE_DIR"],
        os.environ["OH_CONVERSATIONS_PATH"],
        os.environ["OH_BASH_EVENTS_DIR"],
        str(state_dir),
    ):
        Path(d).mkdir(parents=True, exist_ok=True)

    # uvx needs HOME for its cache even when invoked non-interactively.
    os.environ.setdefault("HOME", str(home))

    services: list[Service] = []

    def shutdown(*_args: object) -> None:
        if _shutting_down.is_set():
            return
        _shutting_down.set()
        log("Shutting down...")
        for svc in services:
            svc.stop(signal.SIGTERM)
        time.sleep(3)
        for svc in services:
            if svc.is_running():
                log(f"{svc.name}: force stopping...")
                try:
                    os.killpg(os.getpgid(svc.proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # ── 1. Agent server ──────────────────────────────────────────────────────
    agent_cmd = build_agent_server_cmd()
    services.append(
        Service(
            "agent-server",
            agent_cmd + ["--host", "127.0.0.1", "--port", str(agent_server_port)],
            env=dict(os.environ, PYTHONUTF8="1", LOG_JSON="true"),
            cwd=SDK_VENV.parent,
        )
    )
    services[-1].start()

    # ── 2. Automation (optional) ──────────────────────────────────────────────
    automation_cmd: list[str] = []
    if start_automation:
        automation_cmd, _ = build_automation_cmd()
        if automation_cmd:
            # Local filesystem storage so tarball presets work without cloud creds.
            os.environ["AUTOMATION_FRONTEND_DIR"] = ""
            os.environ.setdefault("FILE_STORE", "local")
            local_storage = Path(os.environ.get("LOCAL_STORAGE_PATH", str(openhands_dir / "storage")))
            local_storage.mkdir(parents=True, exist_ok=True)
            os.environ["LOCAL_STORAGE_PATH"] = str(local_storage)
            os.environ.setdefault("AUTOMATION_BASE_URL", f"http://127.0.0.1:{port}")
            workspaces = Path(os.environ.get("AUTOMATION_WORKSPACE_BASE", str(openhands_dir / "workspaces")))
            workspaces.mkdir(parents=True, exist_ok=True)
            os.environ["AUTOMATION_WORKSPACE_BASE"] = str(workspaces)
            if not os.environ.get("AUTOMATION_DB_URL"):
                db_file = openhands_dir / paths.get("automationDb", "automation/automations.db")
                db_file.parent.mkdir(parents=True, exist_ok=True)
                os.environ["AUTOMATION_DB_URL"] = f"sqlite+aiosqlite:///{db_file}"
                log(f"Using SQLite database: {os.environ['AUTOMATION_DB_URL']}")
            services.append(
                Service(
                    "automation",
                    automation_cmd + ["--host", "0.0.0.0", "--port", str(automation_port)],
                    env=dict(os.environ, PYTHONUTF8="1", OPENHANDS_SUPPRESS_BANNER="1"),
                    cwd=str(state_dir),
                )
            )
            services[-1].start()
    else:
        log("Automation disabled (START_AUTOMATION=0)")

    # ── 3. Wait for backends ──────────────────────────────────────────────────
    wait_threads = [
        threading.Thread(target=wait_for_port, args=(agent_server_port, "Agent Server", 60))
    ]
    if start_automation and automation_cmd:
        wait_threads.append(
            threading.Thread(target=wait_for_port, args=(automation_port, "Automation Server", 60))
        )
    for t in wait_threads:
        t.start()
    for t in wait_threads:
        t.join()

    # ── 4. Runtime-services info ───────────────────────────────────────────────
    automation_url = os.environ.get("AUTOMATION_BASE_URL") if (start_automation and automation_cmd) else None
    runtime_services_info = build_runtime_services_info(agent_server_url, automation_url)

    # ── 5. Static ingress ─────────────────────────────────────────────────────
    # Proxy routes mirror dev-with-automation.mjs AGENT_SERVER_ROUTE_PREFIXES.
    static_cmd: list[str] = [
        "node", str(STATIC_SERVER),
        "--port", str(port),
        "--host", "::",
        "--dir", str(CANVAS_DIR),
        "--base-path", agent_canvas_base_path,
        "--session-api-key", session_key,
        "--runtime-services-info", runtime_services_info,
    ]
    if start_automation and automation_cmd:
        static_cmd += ["--route", f"/api/automation=http://127.0.0.1:{automation_port}"]
    static_cmd += [
        "--route", f"/api=http://127.0.0.1:{agent_server_port}",
        "--route", f"/server_info=http://127.0.0.1:{agent_server_port}",
        "--route", f"/sockets=http://127.0.0.1:{agent_server_port}",
        "--route", f"/alive=http://127.0.0.1:{agent_server_port}",
        "--route", f"/health=http://127.0.0.1:{agent_server_port}",
        "--route", f"/ready=http://127.0.0.1:{agent_server_port}",
        "--route", f"/docs=http://127.0.0.1:{agent_server_port}",
        "--route", f"/redoc=http://127.0.0.1:{agent_server_port}",
        "--route", f"/openapi.json=http://127.0.0.1:{agent_server_port}",
    ]
    static_service = Service("static", static_cmd, env=dict(os.environ), cwd=AC_DIR)
    static_service.start()
    services.append(static_service)

    log(f"All services started. Unified entry point: http://0.0.0.0:{port}/")

    # Keep the container alive while the static-server (ingress) is running.
    # Backend crashes are tolerated — the proxy returns 502 for downed routes,
    # matching the non-Docker path where each service is an independent host.
    while static_service.is_running() and not _shutting_down.is_set():
        time.sleep(2)
    if not _shutting_down.is_set():
        log_error("Static server exited")
    shutdown()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
