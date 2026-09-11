# PRD: Ingress host-bind wrapper

**Status:** Active

## Summary

A thin workspace-owned wrapper around the upstream Agent Canvas ingress so the single-origin entry can bind a chosen address (loopback by default) and advertise the local services in `/server_info` (FR22a of `docs/prd/1_local-dev-launcher.md`). Upstream's ingress binds all interfaces and exposes no host option; this wrapper adds the bind step and the runtime-services advertisement, and leaves all routing/proxying to upstream code consumed unmodified.

## Scope

Workspace-owned; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/dev-local-ingress.mjs` | The wrapper (workspace-owned). Reuses the upstream reverse-proxy internals unmodified and adds a bind address to `server.listen` so the ingress can be loopback-only or exposed on demand; and appends a `runtime_services` field to the proxied `/server_info` response so agents can discover the local services (the `INGRESS_RUNTIME_SERVICES_INFO` value the launcher supplies). |
| `packages/OpenHands/scripts/ingress.mjs` | Consumed upstream: the standalone ingress whose `server.listen(config.port, …)` call takes no host argument, so it binds all interfaces with no `--host` flag. The wrapper's runtime-services handling mirrors the upstream ingress's own `--runtime-services-info` / `INGRESS_RUNTIME_SERVICES_INFO` support (which the wrapper also inherits, since it imports the same `isServerInfoRequest` / `proxyServerInfoRequest` helpers). |
| `packages/OpenHands/scripts/proxy-utils.mjs` | Consumed upstream: the proxy handler internals the wrapper imports unmodified, including the `isServerInfoRequest` / `proxyServerInfoRequest` helpers used to append `runtime_services` to `/server_info`. |

## Functional requirements

- **FR1** — The wrapper starts the ingress with the same routing/proxying behavior as the upstream standalone ingress, importing the upstream proxy internals unmodified (no duplication of routing or proxy logic).
- **FR2** — The wrapper accepts a bind address (default loopback) and passes it to the listen call, so the single-origin port is not reachable from other machines unless explicitly exposed.
- **FR3** — The wrapper is launched as one PM2 app (the fourth app in the local-dev ecosystem) alongside the frontend, backend, and automation apps. Its route table forwards the `/api/automation` prefix to the automation service and the backend path-prefix set to the backend, everything else to the frontend.
- **FR4** — When supplied with a runtime-services block (via `INGRESS_RUNTIME_SERVICES_INFO`, mirroring the upstream ingress's env support), the wrapper appends a `runtime_services` field to the proxied `/server_info` response using the upstream `isServerInfoRequest` / `proxyServerInfoRequest` helpers, so the frontend can render the local services into agent system prompts. Without the value, `/server_info` is proxied unchanged (upstream behavior).

## Non-functional requirements

- **NFR1** — No upstream code is modified; the wrapper is additive only.
- **NFR2** — The wrapper contains only two additions on top of the upstream routing: the bind-address on `server.listen`, and the `runtime_services` advertisement on `/server_info` (FR4). All routing, path-prefixing, and websocket proxying remain upstream's.

## Decision points

- **Wrapper vs. patching upstream.** Patching `packages/OpenHands/scripts/ingress.mjs` to add a host argument was rejected (a subtree edit that creates merge debt on every upstream sync). A thin wrapper that imports the upstream internals and adds the bind step is additive and conflict-free.
- **Wrapper vs. no ingress.** A single-origin entry is kept (Option B) so the whole stack is served behind one host:port and the browser makes same-origin API/websocket calls. The wrapper is the price of controlling that entry's bind address.

## Assumptions (re-check these first when upstream changes)

- The upstream ingress script continues to call `server.listen` with a port-only signature (no host argument) and exposes no `--host` flag.
- The upstream proxy internals (the path-prefix router and HTTP/websocket proxy handlers) remain importable from the package's scripts directory.
- The upstream ingress's route/default configuration contract (routes map + default target) is unchanged.

## Upstream divergence

Behavioral only; no upstream code is modified. The primary divergence exists because upstream binds the ingress to all interfaces with no host option; a `--host` option on the upstream ingress would be a reasonable contribution and would retire the bind part of this wrapper. The runtime-services advertisement (FR4) reuses upstream's own helpers and mirrors the upstream ingress's `--runtime-services-info` / `INGRESS_RUNTIME_SERVICES_INFO` support, so it is not a divergence in behavior — it is the wrapper wiring the same upstream seam that the standalone ingress exposes, driven by the value the launcher resolves.

The wrapper also carries half of the same-origin contract owned by `docs/prd/1_local-dev-launcher.md` (FR8a/FR9): it is the path that answers the browser's same-origin `/api` and `/sockets` calls when the browser arrives through the ingress port, forwarding them to the backend's loopback port on the server, and forwards the `/api/automation` prefix to the automation service. It is also the single point through which the browser reads `/server_info` in both modes, so the FR22a runtime-services advertisement terminates here. If the wrapper is retired (e.g. upstream gains a `--host` option and the ecosystem points directly at the upstream ingress), the replacement must still forward that same prefix set to the backend, the automation prefix to the automation service, and append `runtime_services` to `/server_info`, or the FR8a same-origin and FR22a advertisement promises break.

## Conflict resolution notes

Preserve the requirement, not the implementation. If the upstream ingress gains a host/bind option, retire the wrapper and point the ecosystem at the upstream script directly. If the upstream proxy internals move or change their import surface, rewire the wrapper's imports. The two stable workspace concerns to re-apply on any rework are the bind address on `server.listen` and the `runtime_services` advertisement on `/server_info` (both additive, both driven by values the launcher resolves).

## Status

Active. This PRD depends on the local-dev launcher (`docs/prd/1_local-dev-launcher.md`), which lists the wrapper as the fourth PM2 app.
