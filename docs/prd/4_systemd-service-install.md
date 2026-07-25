# PRD: systemd service install

**Status:** Active

## Summary

A single command that installs the workspace's local full-stack launcher as a long-running per-user systemd service, so the Agent Canvas frontend and the OpenHands Agent Server backend keep running across reboots without anyone staying logged in. The service runs the same launcher `just dev` runs (`scripts/dev-local.sh`), wired to the path of this repository clone. The installer is idempotent: if the service is already installed, it skips installation and just (re)starts it.

This is a **user** service, not a system one: no root or sudo is involved. The unit lives under the installing user's user-manager config, the service runs as that user, and it is managed with `systemctl --user`. To start at boot rather than only at login, the installer enables lingering for that user with `loginctl enable-linger`. The launcher already exists for interactive use; this functionality adds only the systemd plumbing to run it unattended.

## Scope

Workspace-owned only; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/install-service/install.sh` | The installer (workspace-owned): preflight, render unit, enable, start, linger, idempotency |
| `scripts/install-service/openhands.service` | The systemd USER unit file template (workspace-owned), with a repository-path placeholder |
| `justfile` | The `install-service` recipe, a thin wrapper over the installer |
| `scripts/dev-local.sh` | Consumed: the command the unit runs (the local full-stack launcher) |

## Functional requirements

- **FR1** — Running `just install-service` (or the installer script directly) produces a running `openhands` user service that fronts the same stack as `just dev`: the Agent Canvas frontend and the OpenHands Agent Server, behind the single-origin ingress.
- **FR2** — The installed unit runs the local launch script by absolute path, so the service does not depend on `just` being on the service user's `PATH`. `just dev` from the repo root is the documented equivalent, not a runtime dependency.
- **FR3** — The unit references the repository clone path at install time. The installer resolves the clone path from its own location (parent of `scripts/install-service`); it never assumes a fixed path.
- **FR4** — The installer is idempotent: if the unit is already installed or already known to the user manager, it performs no install writes, reloads no daemon, and just (re)starts the existing service.
- **FR5** — On a fresh install, the installer writes the rendered unit into the user's user-manager config, reloads the user daemon, enables the service (so it starts at the user session), enables lingering for the user (so it also starts at boot), and starts it now.
- **FR6** — The unit restarts the stack automatically after a failure (`Restart=on-failure`) with a bounded retry rate, without looping a clean exit. An intentional shutdown uses `systemctl --user stop` and stays stopped.
- **FR7** — The unit wants and waits for the network to be online before first start (`Wants=network-online.target`, `After=network-online.target`).
- **FR8** — The service runs as the installing user. The installer refuses to run as root (with a clear "drop sudo" message) so a unit is never installed into root's user-manager space; the launcher's session API-key cache lives in that user's persisted, writable home directory and survives restarts.
- **FR9** — The installer validates its environment before changing anything: `systemctl` and `loginctl` presence, a usable home directory, and that the user's systemd user manager is actually running. It fails fast with a clear message otherwise; a distinct, accurate message covers the common "no user manager yet — re-login or enable lingering" case.
- **FR10** — The installer fails fast on hosts without a usable user systemd manager rather than trying to emulate systemd.
- **FR11** — A `--dry-run` mode prints the rendered unit and the exact `systemctl --user` / `loginctl` commands that would run, without changing anything, and works even on a host where the user manager is not currently available (so a unit can be previewed from any machine). A `--no-linger` mode skips the lingering step for users who only want login-time start.
- **FR12** — Flags pass through from the recipe to the installer unchanged (`--dry-run`, `--no-linger`, `--help`); the recipe is a thin wrapper and the script remains directly runnable without `just`.

## Non-functional requirements

- **NFR1** — Script logic is compatible with current Linux bash; the systemd-facing operations are inherently Linux-specific and are guarded so the script degrades cleanly on other platforms.
- **NFR2** — The installer is read-only with respect to `packages/` and the rest of the repo tree; it writes only the rendered unit under the user's user-manager config and talks to the user manager. It leaves the unit template in place unmodified.
- **NFR3** — No secrets are written into the unit. The shared session API key is owned by the launcher (persisted under the user's home), not by the installer.
- **NFR4** — The unit file keeps the launcher's crash-coupling intact: it restarts only on failure and lets the launcher manage its own child process groups, so a crash of one stack component still brings down the rest as the launcher intends.
- **NFR5** — Idempotency is detectable through the user manager's own state (`list-unit-files` / existing unit file), not a private marker file, so the installer tracks the same truth systemd does.
- **NFR6** — No privilege is required: the installer never invokes sudo, never writes under `/etc`, and never manipulates a system unit. Lingering is enabled by the user for themselves, which does not require root.

## Decision points

- **Run the launcher directly vs. run `just dev`.** Chose the launcher script by absolute path. `just` may not be installed or on the service user's `PATH` at boot; depending on it would make the service fragile for no benefit. `just dev` remains the documented human-facing equivalent and the recipe still wraps the installer, but the unit ExecStart does not call `just`.
- **User service vs. system service.** Chose a per-user unit under the user's user-manager config. A system unit would require root/sudo to install and manage, isolate the stack under a fixed system identity, and fight the workspace's "run as the developer who cloned it" model. The user-manager approach keeps the stack running as the repo owner with no privilege, matching the launcher's assumptions. To satisfy the unattended-across-reboots goal that a system service would give for free, linger is enabled for the user so the user manager starts at boot without a login.
- **Boot autostart via lingering.** Chose `loginctl enable-linger`, self-served by the user (no root). Without lingering the user service starts only at login; with it, the user manager is brought up at boot and the enabled unit starts. The installer attempts this automatically and degrades gracefully (warning, not failure) if polkit declines or `loginctl` is absent, leaving `--no-linger` for users who want only login-time start.
- **Refuse root.** A user-service installer run as root would either install into root's user-manager space (serving no one) or require complex cross-user manager wiring. Refusing root with a clear "drop sudo" message is simpler, safer, and correct: there is nothing to install that needs privilege.
- **Idempotency detection.** Chose the user manager's own `list-unit-files` plus an existing-unit-file check, rather than a marker file. A marker file can drift from the manager's real state (deleted out of band, stale after a unit removal); asking the manager what it knows cannot.
- **Render by substitution vs. write a static unit.** Chose a template with a `%…%` placeholder rendered at install time. The clone path varies per host; baking it would produce a unit that only works where it was authored. Dropping the service-user placeholder (vs. the previous system-unit design) reflects that a user unit never needs an explicit `User=`/`Group=`.
- **`Restart=on-failure` vs. `always`.** Chose `on-failure`. A clean exit (operator `stop`, or a deliberate launcher shutdown) must stay stopped; only crashes should come back. A bounded `StartLimitIntervalSec`/`StartLimitBurst` (in `[Unit]`, the modern location) is set so a broken environment does not thrash.
- **`network-online.target` for a user unit.** Chose `Wants` + `After`, not a hard `Requires`. The launcher binds loopback by default and can start offline; the network wait is a convenience for sync and clean binding. The user manager honors dependencies on system targets, so this is well defined.
- **Dry-run scope.** Chose to render the unit, preview installing it, and preview the user-manager and linger commands, all without mutating state, and to allow this even when no user manager is present. This lets a user verify the resolved paths before committing, including from a non-Linux preview machine.

## Assumptions (re-check these first when systemd or the launcher changes)

- The systemd user-unit schema and the `systemctl --user daemon-reload` / `enable` / `start` choreography remain as in systemd v2xx; the unit uses only stable directives (`Type`, `ExecStart`, `Restart`, `RestartSec`, `Wants`, `After`, `KillMode`, `StandardOutput`, `WantedBy=default.target`). `StartLimit*` lives in `[Unit]` on modern systemd.
- `loginctl enable-linger <self>` remains a self-service action gated by polkit and does not require root on the target distros.
- `scripts/dev-local.sh` remains a self-contained, foreground launcher that stays alive while the stack runs and exits (non-zero on failure, zero on clean stop) when the stack stops, reachable as `scripts/dev-local.sh` from the repo root.
- The launcher accepts being run as a normal, non-root user provided that user has a readable, writable home directory for its persisted session API key.
- The repo keeps its published convention that workspace scripts sit under `scripts/` relative to the repo root, so the installer can resolve the clone path as the parent of `scripts/install-service`.
- The user's systemd user manager (`systemd --user`) is started at login, and when lingering is enabled it is also brought up at boot — the standard systemd per-user session behavior.
- A backend reachable for the single-origin ingress is produced by the launcher itself; the unit does not encode any backend address, mirroring the launcher's own "derive the target from the launched backend" decision.
- The launcher's environment variables (ports, bind address, API key) keep their current names and continue to be read from the environment, so future tuning can be done by dropping an `EnvironmentFile=` or `Environment=` into the unit without changing the installer.

## Upstream divergence

No upstream code is modified. The divergence is only that upstream `agent-canvas` has no built-in "install as a user service" surface; this functionality adds one at the workspace layer, pointing at the workspace-owned launcher. It is not upstreamable as-is because the launcher itself diverges from upstream (it runs local sources, not released artifacts — see `docs/prd/1_local-dev-launcher.md`).

## Conflict resolution notes

If the launcher's interface or location changes (renamed, moved, or its foreground/exit semantics change), preserve FR1–FR4: re-point the unit at whatever `just dev` now runs, keep running it by absolute path rather than through `just`, and keep the idempotency and restart guarantees. If systemd's user-manager or lingering semantics change, re-derive the boot-autostart path (FR5/NFR6) from the new mechanism; the requirement that the stack starts unattended and restarts on failure must survive. The user-service, no-root, run-as-repo-owner decisions (FR8) are load-bearing: do not silently regress to a system/root service without revisiting this PRD. The home-directory requirement (FR8/NFR3) for the launcher's persisted key must not be dropped silently.
