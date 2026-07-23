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
| `packages/agent-canvas` | Consumed: frontend dev server and its configuration surface |
| `packages/software-agent-sdk` | Consumed: agent-server entry point and its Python workspace |

## Functional requirements

- **FR1** — Default invocation starts both frontend and backend. `--frontend-only` and `--backend-only` each start exactly one of them and are mutually exclusive.
- **FR2** — The backend runs from the local `packages/software-agent-sdk` sources. No `openhands-*` package may be fetched as a registry release.
- **FR3** — The frontend is the local `packages/agent-canvas` dev server. The published `@openhands/agent-canvas` package must never be installed or executed.
- **FR4** — In full-stack mode the frontend reaches the backend API without manual configuration. In frontend-only mode the target backend is overridable.
- **FR5** — If any launched service exits, for any reason, all other launched services are stopped and the launcher exits, propagating the failed service's status.
- **FR6** — Interrupting or terminating the launcher stops all services without leaving orphan processes.
- **FR7** — Frontend and backend share a session API key. If the user does not supply one, a generated key persists across restarts.
- **FR8** — UI and backend ports are configurable via flags; defaults follow upstream conventions (UI 8000, agent-server 18000).
- **FR9** — The whole stack is additionally exposed behind a single origin (one host:port) that routes API and websocket paths to the backend and everything else to the frontend, so browsers on machines other than the server work without reaching the backend port. This single-origin entry runs by default in every mode and is disableable by flag.
- **FR10** — The direct frontend and backend ports remain available alongside the single-origin entry, for debugging.
- **FR11** — Pages served from any of the exposed ports must lead the browser to make same-origin API and websocket calls (no absolute loopback or server-local backend addresses baked into what the browser executes).

## Non-functional requirements

- **NFR1** — Runs on the stock macOS shell (bash 3.2) and current Linux bash.
- **NFR2** — Binds to loopback by default; exposing services on other interfaces must be an explicit user choice.
- **NFR3** — Makes no modifications inside `packages/`; consumes only documented upstream configuration surfaces (environment variables, CLI flags, package scripts).
- **NFR4** — The CLI surface stays recognizable to upstream `agent-canvas` CLI users (same split-flag names and defaults where they apply).

## Decision points

- **Reuse upstream's dev pipeline vs. own launcher.** Rejected reuse: the upstream pipeline downloads the agent-server and the automation backend from external sources by default, violating FR2 and pulling in unvendored components.
- **Run the backend through the SDK's own Python workspace vs. building it from a local path with upstream's installer tooling.** The SDK's workspace mechanism was chosen: it is the SDK's native development path and guarantees every `openhands-*` package resolves to local sources.
- **Dedicated ingress proxy vs. the frontend dev server's own proxying.** Originally the frontend's built-in dev proxy alone was chosen. Revised when remote-client browsing became a requirement (FR9): the stack now also runs the frontend package's own standalone ingress script, consumed unmodified as an upstream extension point, to provide the single-origin entry — rather than writing a workspace-owned proxy that would duplicate upstream functionality.
- **Browser-to-backend addressing.** The frontend's baked backend address is left unset so the app falls back to same-origin requests (FR11), which both the ingress and the dev server's proxy forward to the backend. Baking a concrete backend address was rejected: it only works for browsers on the server itself.
- **Automation backend.** Deliberately excluded: the OpenHands Automation project is not vendored in this repository, and starting it would require fetching an external release. Automation-dependent UI features are accepted as unavailable locally.

## Assumptions (re-check these first when upstream changes)

- The SDK remains a single Python workspace whose members include the agent-server, and exposes a runnable agent-server entry point accepting host and port options.
- The frontend keeps a package script that starts only the dev server (without spawning backends), and honors environment configuration for its port, backend host, backend base URL, and session API key.
- The frontend dev server proxies API paths to the configured backend host.
- When no backend address is baked into the frontend, the app falls back to same-origin (browser location) for API and websocket calls.
- The frontend package ships a standalone, backend-agnostic reverse-proxy script with path-prefix routing, a default route, and websocket support, runnable directly from the package checkout.
- The set of URL path prefixes the backend serves (API, websockets, docs, health) matches the prefixes the frontend's own dev proxy forwards.
- Backend and frontend authenticate with a shared session API key supplied through environment configuration.
- Default ports and the session-key convention continue to follow the frontend package's central defaults configuration.

## Upstream divergence

No upstream code is modified; the divergence is behavioral. Upstream's launcher installs released artifacts by design; this launcher forbids that and runs local sources. It is therefore not upstreamable as-is. If upstream ever ships a supported "run everything from a local checkout" mode covering both projects, this launcher can be retired in its favor.

## Conflict resolution notes

If an upstream update breaks the launcher, preserve the requirements, not the implementation. Re-locate the SDK's current way of running the agent-server from workspace sources and the frontend's current dev-server script and configuration surface, then rewire the launcher to them. Any of FR1–FR8 may be reimplemented with different mechanics; none may be dropped silently.
