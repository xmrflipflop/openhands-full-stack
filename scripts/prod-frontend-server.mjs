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
  await startStaticServer(config);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
