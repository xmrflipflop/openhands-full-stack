# PRD: Local development launcher

**Status:** Active

## Summary

A single command that runs the Agent Canvas frontend and the OpenHands Agent Server backend together, built strictly from the source in this repository, so the two subtrees can be developed and validated against each other.

The upstream `agent-canvas` CLI runs a similar stack but installs released artifacts: the agent-server from PyPI (via `uvx`) and the frontend from the published npm package. This workspace needs the same workflow pointed at local sources instead — otherwise local changes to either subtree are never exercised.

## Scope

Workspace-owned only; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/dev-local.sh` | The launcher (workspace-owned) |
| `scripts/dev-local-ingress.mjs` | Ingress runner (workspace-owned); adds a bind address on top of the upstream proxy internals |
| `packages/agent-canvas` | Consumed: frontend dev server, its configuration surface, and its reverse-proxy internals |
| `packages/software-agent-sdk` | Consumed: agent-server entry point and its Python workspace |

## Functional requirements

- **FR1** — Default invocation starts both frontend and backend. `--frontend-only` and `--backend-only` each start exactly one of them and are mutually exclusive.
- **FR2** — The backend runs from the local `packages/software-agent-sdk` sources. No `openhands-*` package may be fetched as a registry release.
- **FR3** — The frontend is the local `packages/agent-canvas` dev server. The published `@openhands/agent-canvas` package must never be installed or executed.
- **FR4** — The proxies (single-origin entry and frontend dev proxy) derive their backend target from the launched backend's actual address; no separate target flag exists. In frontend-only mode they expect a backend on this machine at the configured backend port.
- **FR5** — If any launched service exits, for any reason, all other launched services are stopped and the launcher exits, propagating the failed service's status.
- **FR6** — Interrupting or terminating the launcher stops all services without leaving orphan processes.
- **FR7** — Frontend and backend share a session API key. If the user does not supply one, a generated key persists across restarts.
- **FR8** — UI and backend ports are configurable via flags; defaults follow upstream conventions (UI 8000, agent-server 18000).
- **FR9** — The whole stack is additionally served behind a single origin (one host:port) that routes API and websocket paths to the backend and everything else to the frontend, so browsers on machines other than the server work without reaching the backend port. This single-origin entry runs by default in every mode and is disableable by flag.
- **FR10** — The direct frontend and backend ports remain available alongside the single-origin entry, for debugging.
- **FR11** — Pages served from any of the exposed ports must lead the browser to make same-origin API and websocket calls (no absolute loopback or server-local backend addresses baked into what the browser executes).
- **FR12** — Everything binds loopback by default, including the single-origin entry. One bind-address option (`--host`) controls the single-origin entry only; a separate opt-in flag (`--expose-debug`) binds the debug ports to that same address. Nothing is reachable from other machines without an explicit choice.

## Non-functional requirements

- **NFR1** — Runs on the stock macOS shell (bash 3.2) and current Linux bash.
- **NFR2** — Zero network surface by default: every service, including the single-origin entry, binds loopback. Any external exposure must be an explicit user choice.
- **NFR3** — Makes no modifications inside `packages/`; consumes only documented upstream configuration surfaces (environment variables, CLI flags, package scripts).
- **NFR4** — The CLI surface stays recognizable to upstream `agent-canvas` CLI users (same split-flag names and defaults where they apply).

## Decision points

- **Reuse upstream's dev pipeline vs. own launcher.** Rejected reuse: the upstream pipeline downloads the agent-server and the automation backend from external sources by default, violating FR2 and pulling in unvendored components.
- **Run the backend through the SDK's own Python workspace vs. building it from a local path with upstream's installer tooling.** The SDK's workspace mechanism was chosen: it is the SDK's native development path and guarantees every `openhands-*` package resolves to local sources.
- **Dedicated ingress proxy vs. the frontend dev server's own proxying.** Originally the frontend's built-in dev proxy alone was chosen. Revised when remote-client browsing became a requirement (FR9): the stack now also runs the frontend package's own standalone ingress script, consumed unmodified as an upstream extension point, to provide the single-origin entry — rather than writing a workspace-owned proxy that would duplicate upstream functionality.
- **Browser-to-backend addressing.** The frontend's baked backend address is left unset so the app falls back to same-origin requests (FR11), which both the ingress and the dev server's proxy forward to the backend. Baking a concrete backend address was rejected: it only works for browsers on the server itself.
- **Debug-port binding.** The frontend package's dev configuration binds all interfaces by default. Rather than patching that configuration (a subtree edit), the launcher overrides the bind address through the dev command's own host option, keeping debug ports loopback-only (FR12) without touching upstream files.
- **Ingress bind address.** The upstream standalone ingress always listens on all interfaces and offers no bind-address option. Patching it (subtree edit) was rejected; instead a thin workspace-owned runner reuses the upstream proxy internals unmodified and adds only the bind step. If upstream adds a bind-address option, the runner should be retired in its favor.
- **Backend target flag removed.** An earlier revision had a flag naming the backend the proxies target. Removed: the target is now derived from the launched backend's actual address, eliminating a flag that could contradict reality. The cost is that frontend-only setups pointing at a backend on another machine are no longer expressible; that trade was accepted deliberately.
- **Automation backend.** Deliberately excluded: the OpenHands Automation project is not vendored in this repository, and starting it would require fetching an external release. Automation-dependent UI features are accepted as unavailable locally.

## Assumptions (re-check these first when upstream changes)

- The SDK remains a single Python workspace whose members include the agent-server, and exposes a runnable agent-server entry point accepting host and port options.
- The frontend keeps a package script that starts only the dev server (without spawning backends), and honors environment configuration for its port, backend host, backend base URL, and session API key.
- The frontend's dev command accepts a host option that takes precedence over the bind address in its configuration file.
- The frontend dev server proxies API paths to the configured backend host.
- When no backend address is baked into the frontend, the app falls back to same-origin (browser location) for API and websocket calls.
- The frontend package ships backend-agnostic reverse-proxy internals (path-prefix router and HTTP/websocket proxy handlers) importable from its scripts directory, alongside a standalone ingress script that uses them.
- The set of URL path prefixes the backend serves (API, websockets, docs, health) matches the prefixes the frontend's own dev proxy forwards.
- Backend and frontend authenticate with a shared session API key supplied through environment configuration.
- Default ports and the session-key convention continue to follow the frontend package's central defaults configuration.

## Upstream divergence

No upstream code is modified; the divergence is behavioral. Upstream's launcher installs released artifacts by design; this launcher forbids that and runs local sources. It is therefore not upstreamable as-is. If upstream ever ships a supported "run everything from a local checkout" mode covering both projects, this launcher can be retired in its favor.

The workspace ingress runner duplicates the small server-assembly portion of the upstream ingress script (not its routing or proxying logic, which are imported unmodified) solely to control the bind address. A bind-address option would be a reasonable upstream contribution; upstreaming it retires the runner.

## Conflict resolution notes

If an upstream update breaks the launcher, preserve the requirements, not the implementation. Re-locate the SDK's current way of running the agent-server from workspace sources and the frontend's current dev-server script and configuration surface, then rewire the launcher to them. Any of FR1–FR8 may be reimplemented with different mechanics; none may be dropped silently.
