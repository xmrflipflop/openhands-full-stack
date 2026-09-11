/**
 * Workspace-owned PM2 entry point for the upstream agent-canvas static server.
 *
 * Background (PRD: docs/prd/1_local-dev-launcher.md, FR8 prod):
 *   The upstream `packages/OpenHands/scripts/static-server.mjs` guards its
 *   entry on an `isMainModule` check:
 *
 *     const isMainModule =
 *       process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
 *
 *   That idiom is correct for a plain `node scripts/static-server.mjs` run, but
 *   PM2's fork mode wraps the user script in
 *   `.../pm2/lib/ProcessContainerFork.js`, so `process.argv[1]` is the wrapper
 *   path, not this script, the `isMainModule` guard is false, and
 *   `startStaticServer` is never invoked — the prod frontend comes up `online`
 *   under PM2 but binds no port and prints no banner.
 *
 *   This is an upstream-file quirk we deliberately do NOT patch inside
 *   `packages/OpenHands`. The upstream script already *exports*
 *   `parseArgs` and `startStaticServer`, so this workspace-owned wrapper drives
 *   them directly — the ecosystem points PM2 at this file instead of the
 *   upstream script. The args/env remain identical to a direct run, so behaviour
 *   is unchanged; only the entry shim differs. If upstream ever drops the
 *   `isMainModule` guard (or exports a dedicated `main`), this wrapper can be
 *   retired and the ecosystem pointed back at the upstream script.
 */

import { parseArgs, startStaticServer } from "../packages/OpenHands/scripts/static-server.mjs";

try {
  const config = parseArgs();
  // Advertise the local services in /server_info (PRD 1 FR22a), matching the
  // dev path the ingress handles. The launcher builds the JSON and passes it
  // here as an env var, not a CLI arg: the JSON contains spaces and PM2
  // shell-joins a string `args` field, which would corrupt it. The upstream
  // static-server reads it from the config and both appends it to the proxied
  // /server_info and injects the legacy window global into index.html.
  if (config.runtimeServicesInfo == null && process.env.FRONTEND_RUNTIME_SERVICES_INFO) {
    config.runtimeServicesInfo = process.env.FRONTEND_RUNTIME_SERVICES_INFO;
  }
  await startStaticServer(config);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
