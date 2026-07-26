# PRD: Ingress host-bind wrapper

**Status:** Active

## Summary

A thin workspace-owned wrapper around the upstream Agent Canvas ingress so the single-origin entry can bind a chosen address (loopback by default). Upstream's ingress binds all interfaces and exposes no host option; this wrapper adds only the bind step and leaves all routing/proxying to upstream code consumed unmodified.

## Scope

Workspace-owned; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/dev-local-ingress.mjs` | The wrapper (workspace-owned). Reuses the upstream reverse-proxy internals unmodified and adds only a bind address to `server.listen`, so the ingress can be loopback-only or exposed on demand. |
| `packages/agent-canvas/scripts/ingress.mjs` | Consumed upstream: the standalone ingress whose `server.listen(config.port, …)` call takes no host argument, so it binds all interfaces with no `--host` flag. |
| `packages/agent-canvas/scripts/proxy-utils.mjs` | Consumed upstream: the proxy handler internals the wrapper imports unmodified. |

## Functional requirements

- **FR1** — The wrapper starts the ingress with the same routing/proxying behavior as the upstream standalone ingress, importing the upstream proxy internals unmodified (no duplication of routing or proxy logic).
- **FR2** — The wrapper accepts a bind address (default loopback) and passes it to the listen call, so the single-origin port is not reachable from other machines unless explicitly exposed.
- **FR3** — The wrapper is launched as one PM2 app (the third app in the local-dev ecosystem) alongside the frontend and backend apps.

## Non-functional requirements

- **NFR1** — No upstream code is modified; the wrapper is additive only.
- **NFR2** — The wrapper contains only the bind-address addition; all routing, path-prefixing, and websocket proxying remain upstream's.

## Decision points

- **Wrapper vs. patching upstream.** Patching `packages/agent-canvas/scripts/ingress.mjs` to add a host argument was rejected (a subtree edit that creates merge debt on every upstream sync). A thin wrapper that imports the upstream internals and adds the bind step is additive and conflict-free.
- **Wrapper vs. no ingress.** A single-origin entry is kept (Option B) so the whole stack is served behind one host:port and the browser makes same-origin API/websocket calls. The wrapper is the price of controlling that entry's bind address.

## Assumptions (re-check these first when upstream changes)

- The upstream ingress script continues to call `server.listen` with a port-only signature (no host argument) and exposes no `--host` flag.
- The upstream proxy internals (the path-prefix router and HTTP/websocket proxy handlers) remain importable from the package's scripts directory.
- The upstream ingress's route/default configuration contract (routes map + default target) is unchanged.

## Upstream divergence

Behavioral only; no upstream code is modified. The divergence exists solely because upstream binds the ingress to all interfaces with no host option. A `--host` option on the upstream ingress would be a reasonable contribution and would retire this wrapper.

The wrapper also carries half of the same-origin contract owned by `docs/prd/1_local-dev-launcher.md` (FR8a/FR9): it is the path that answers the browser's same-origin `/api` and `/sockets` calls when the browser arrives through the ingress port, forwarding them to the backend's loopback port on the server. If the wrapper is retired (e.g. upstream gains a `--host` option and the ecosystem points directly at the upstream ingress), the replacement must still forward that same prefix set to the backend, or the FR8a same-origin promise breaks.

## Conflict resolution notes

Preserve the requirement, not the implementation. If the upstream ingress gains a host/bind option, retire the wrapper and point the ecosystem at the upstream script directly. If the upstream proxy internals move or change their import surface, rewire the wrapper's imports; the bind-address addition is the only stable workspace concern.

## Status

Active. This PRD depends on the local-dev launcher (`docs/prd/1_local-dev-launcher.md`), which lists the wrapper as the third PM2 app.
