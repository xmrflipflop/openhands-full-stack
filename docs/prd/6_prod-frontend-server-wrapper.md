# PRD: Production frontend server wrapper

**Status:** Active

## Summary

A thin workspace-owned entry shim so the production frontend app starts correctly under PM2 fork mode. Upstream `packages/OpenHands/scripts/static-server.mjs` guards its entry behind an `isMainModule` check that passes when run directly with `node` but fails when PM2 forks the script — the process comes up `online` under PM2 but binds no port and prints no banner.

This wrapper imports the upstream script's exported `parseArgs` and `startStaticServer` functions and calls them directly, bypassing the guard. The arguments, environment, and behaviour are identical to a direct `node` invocation; only the entry mechanism differs.

If upstream ever drops the `isMainModule` guard (or exports a dedicated `main`), this wrapper can be retired and the ecosystem pointed back at the upstream script directly.

## Scope

Workspace-owned; no upstream files are modified.

| Path | Role |
| --- | --- |
| `scripts/prod-frontend-server.mjs` | The wrapper (workspace-owned). Imports `parseArgs` + `startStaticServer` from upstream and runs them unconditionally. |
| `packages/OpenHands/scripts/static-server.mjs` | Consumed upstream: the static file server + reverse proxy whose entry is guarded by `isMainModule`. Exports `parseArgs()` and `startStaticServer()` for programmatic use. |
| `ecosystem.config.js` | Points PM2 at the wrapper instead of the upstream script for the production frontend app (`script: PROD_FRONTEND_SCRIPT`). |

## Root cause

The upstream script self-detects whether it is the main module using:

```js
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
```

This idiom is correct for `node scripts/static-server.mjs` — `process.argv[1]` is the script path. Under PM2 fork mode, PM2 wraps every user script in `…/pm2/lib/ProcessContainerFork.js`, so `process.argv[1]` is the fork harness path, not the user script. `isMainModule` is always `false`, and `startStaticServer` is never invoked.

## Functional requirements

- **FR1** — The wrapper imports `parseArgs` and `startStaticServer` from the upstream static-server script and calls them in sequence, passing through all CLI arguments and environment variables unchanged.
- **FR2** — The wrapper is the sole entry point for the production frontend PM2 app; the ecosystem.config.js production frontend `script` field resolves to `scripts/prod-frontend-server.mjs`, not the upstream script.
- **FR3** — The wrapper exits non-zero if upstream parsing or server startup throws, so PM2 treats it as a crash (not a silent no-op).

## Non-functional requirements

- **NFR1** — No upstream code is modified; the wrapper is purely additive.
- **NFR2** — The wrapper contains no routing, proxying, or serving logic; it merely calls upstream exported functions.

## Decision points

- **Wrapper vs. patching upstream.** Patching `packages/OpenHands/scripts/static-server.mjs` to remove or relax the `isMainModule` guard was rejected — it is a subtree edit that creates merge debt on every upstream sync and offers no upstream benefit. A thin wrapper that imports the upstream exports is additive and conflict-free.
- **Wrapper vs. PM2 `--interpreter_args`.** PM2 does not support overriding how Node resolves `process.argv[1]`; the fork harness is internal to PM2. No PM2 configuration can make the guard pass.
- **Wrapper vs. `exec_mode: cluster_mode`.** Cluster mode uses worker threads and a different fork semantics, but the static server uses HTTP APIs incompatible with cluster-mode worker threads. Fork mode is the correct PM2 strategy; the wrapper is the correct fix.

## Assumptions (re-check these first when upstream changes)

- The upstream script continues to export both `parseArgs` (synchronous/returns config object) and `startStaticServer` (async/accepts config object).
- The upstream script's `isMainModule` guard remains in place (or a new `main` export emerges).
- No upstream change alters the argument contract (`--dir`, `--port`, `--host`, `--session-api-key`, `--route`) that the ecosystem passes through `args`.

## Upstream divergence

Behavioural only; no upstream code is modified. The divergence exists solely because upstream's self-detection idiom is incompatible with PM2 fork mode. A `main()` export (or `module` field in upstream `package.json`) would be a reasonable upstream contribution and would retire this wrapper.

## Conflict resolution notes

Preserve the requirement, not the implementation. If upstream adds a `main` export, retire the wrapper and point the ecosystem at the upstream script directly. If upstream renames or removes the `parseArgs` / `startStaticServer` exports, re-locate the current programmatic entry surface and rewire the wrapper's imports — the unconditional entry is the only stable workspace concern.

## Status

Active. Referenced by `docs/prd/1_local-dev-launcher.md` (FR8, Scope, Upstream divergence, Status).
