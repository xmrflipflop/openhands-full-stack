/**
 * ecosystem.config.js — PM2 process ecosystem for the openhands-full-stack
 * workspace.
 *
 * PRD: docs/prd/1_local-dev-launcher.md
 *
 * CONSUMER, not a deriver. This file resolves NOTHING deployment-specific: it
 * reads every identity and deployment value from environment variables set by
 * scripts/launch-stack.js (the only supported entry point) and hard-errors —
 * naming the launcher — if any required value is absent (FR15). A bare
 * `pm2 start ecosystem.config.js` therefore fails immediately with a message
 * pointing at the launcher; start the stack with `just serve` (which runs
 * the launcher). It still uses `__dirname` for path composition only.
 *
 * Required env vars (all set by the launcher; absent → hard error):
 *   STACK_FE_PORT, STACK_BE_PORT, STACK_INGRESS_PORT,
 *   STACK_FE_BIND,  STACK_BE_BIND,  STACK_INGRESS_BIND,
 *   STACK_TAG,      STACK_SESSION_API_KEY
 *   NODE_ENV is optional and defaults to "development".
 *
 * This file deliberately no longer reads `.dev-id`, infers environment from
 * its location, computes a port, applies a bind default, or generates a
 * credential. The launcher owns all of that (FR15/FR3/FR5/FR17/FR8b); this
 * file only fans the resolved values out to the three services.
 *
 * Three cooperating services, all launched strictly from THIS repository:
 *
 *   backend   OpenHands Agent Server from packages/software-agent-sdk.
 *             PM2's `script` points at the venv's installed `agent-server`
 *             console script (under packages/software-agent-sdk/.venv/bin);
 *             `interpreter` is that venv's python. `uv sync` installs the
 *             workspace members in editable mode, so every openhands-* package
 *             resolves to local sources — never a PyPI release. (FR7)
 *   frontend  Agent Canvas from packages/agent-canvas. The NODE_ENV-appropriate
 *             serving seam is selected here, because `react-router dev` cannot
 *             run under NODE_ENV=production — Vite's SSR JSX transform would
 *             import `react/jsx-runtime` (no `jsxDEV`), crashing the dev server
 *             with `jsxDEV is not a function`. This is the ONLY conditional the
 *             ecosystem contains, plus its production build preflight backstop
 *             (FR8/FR8c):
 *               • development → `react-router dev` (Vite dev server). Its dev
 *                 proxy targets the backend via VITE_BACKEND_HOST. (FR8 dev)
 *               • production  → workspace wrapper
 *                 `scripts/prod-frontend-server.mjs` (PM2 entry shim) which
 *                 imports `parseArgs` + `startStaticServer` from upstream
 *                 `packages/agent-canvas/scripts/static-server.mjs`. The
 *                 upstream script guards its entry behind an `isMainModule`
 *                 check that fails under PM2 fork mode, so the wrapper runs
 *                 the exported functions directly. Serves the prebuilt SPA
 *                 from packages/agent-canvas/build/ with history-mode fallback.
 *                 Its reverse proxy forwards the same /api,/sockets,… prefix
 *                 set as the ingress. The session key is injected at runtime
 *                 via --session-api-key (not baked into the build), preserving
 *                 FR8b. (FR8 prod)
 *   ingress   Workspace-owned single-origin proxy (scripts/dev-local-ingress.mjs)
 *             reusing the upstream reverse-proxy internals unmodified, with a
 *             bind address added so the stack port can stay loopback by
 *             default. (FR9, docs/prd/4_ingress-host-wrapper.md)
 *
 * Apps are named `<service>-<tag>` under namespace `tag` (the launcher sets
 * `tag` to `dev-<id>` / `prod-<id>`; FR4/FR16), so `pm2 restart prod-1`,
 * `pm2 stop dev-2`, and `pm2 logs backend-dev-1` all work in the shared PM2
 * registry. Multiple checkouts run concurrently with distinct ports.
 *
 * Unprivileged
 *   Nothing binds a port below 1024 or writes outside the checkout, so the
 *   stack runs as the invoking user with no root. Privilege drop via PM2
 *   uid/gid is documented (commented) but off by default and only honoured
 *   when PM2 is started as root. (FR12)
 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = __dirname;
const SDK_DIR = path.join(repoRoot, "packages", "software-agent-sdk");
const CANVAS_DIR = path.join(repoRoot, "packages", "agent-canvas");
const UV_VENV_PYTHON = path.join(SDK_DIR, ".venv", "bin", "python");
const AGENT_SERVER_SCRIPT = path.join(SDK_DIR, ".venv", "bin", "agent-server");
const INGRESS_SCRIPT = path.join(repoRoot, "scripts", "dev-local-ingress.mjs");
// Workspace-owned PM2 entry shim for the upstream static server.
// Upstream's `scripts/static-server.mjs` guards its entry behind an
// `isMainModule` check which fails under PM2 fork mode (PM2's wrapper sets
// process.argv[1] to the fork harness, not the user script). This wrapper
// imports `parseArgs` + `startStaticServer` from the upstream script and runs
// them directly. The args/env remain identical to a direct `node` run.
// (FR8 prod, docs/prd/1_local-dev-launcher.md §8.)
const PROD_FRONTEND_SCRIPT = path.join(
  repoRoot,
  "scripts",
  "prod-frontend-server.mjs",
);
const CANVAS_BUILD_DIR = path.join(CANVAS_DIR, "build");

// ── Consumer values (everything the launcher resolves; FR15) ─────────────────
// This file derives nothing. Every deployment value below is read from the
// environment the launcher sets; a missing required var is a hard error that
// names the launcher, so a bare `pm2 start ecosystem.config.js` fails
// immediately with an actionable message. The launcher (scripts/
// launch-stack.js, run via `just serve`) is the only supported entry point.
const LAUNCHER_NAME = "scripts/launch-stack.js (run via `just serve`)";
function requireStackVar(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `${name} is not set. The ecosystem derives nothing — every value is ` +
        `provided by the launcher (${LAUNCHER_NAME}). Start the stack with ` +
        `'just serve', not a bare 'pm2 start ecosystem.config.js'.`,
    );
  }
  return v;
}

const FRONTEND_PORT = requireStackVar("STACK_FE_PORT");
const BACKEND_PORT = requireStackVar("STACK_BE_PORT");
const INGRESS_PORT = requireStackVar("STACK_INGRESS_PORT");
const frontendBind = requireStackVar("STACK_FE_BIND");
const backendBind = requireStackVar("STACK_BE_BIND");
const ingressBind = requireStackVar("STACK_INGRESS_BIND");
const tag = requireStackVar("STACK_TAG");
const apiKey = requireStackVar("STACK_SESSION_API_KEY");
const namespace = tag;

// NODE_ENV — the only optional STACK/env value. It drives the frontend serving
// seam (FR8) and is set on every app (FR10). It defaults to development; the
// launcher always sets it (production only under --production).
const NODE_ENV = process.env.NODE_ENV || "development";
const isProductionNodeEnv = NODE_ENV === "production";

const backendHost = `${backendBind}:${BACKEND_PORT}`;

// Backend URL path prefixes forwarded to the agent-server. A single list
// shared by three consumers so they route identically: the Vite dev proxy
// (packages/agent-canvas/vite.config.ts — its mirror, kept in sync here), the
// ingress (this ecosystem), and the prod static-server (this ecosystem).
// Keeping one workspace-owned list prevents the three paths from drifting.
const backendRoutes = [
  "/api",
  "/sockets",
  "/server_info",
  "/alive",
  "/health",
  "/ready",
  "/docs",
  "/redoc",
  "/openapi.json",
];

// ── Production build preflight backstop (FR8c) ───────────────────────────────
// The launcher performs this check first and aborts; the ecosystem repeats it
// as a backstop so a snapshot re-evaluation (or a direct invocation) cannot
// silently serve nothing. The build is out-of-band, regenerated by
// `just setup --production` (FR13b).
if (isProductionNodeEnv && !fs.existsSync(path.join(CANVAS_BUILD_DIR, "index.html"))) {
  throw new Error(
    `Production requires a built frontend SPA at ${CANVAS_BUILD_DIR} ` +
      `(missing index.html). Run 'just setup --production' (or ` +
      `'cd packages/agent-canvas && npm run build') before starting the ` +
      `production stack.`,
  );
}

// ── Shared env applied to every app (all modes) ──────────────────────────────
// PYTHONUTF8 / DEV_REPO_ROOT / NODE_ENV are common to every app. The session
// key is NOT in this shared block: it is fanned out per consumer below
// (FR8b) — OH_SESSION_API_KEYS_0 to the backend, VITE_SESSION_API_KEY to the
// dev frontend, --session-api-key to the production static server.
const sharedEnv = {
  PYTHONUTF8: "1",
  DEV_REPO_ROOT: repoRoot,
  NODE_ENV,
};


// Per-app supervision limits (FR11): bounded auto-restart + memory guard.
const supervise = {
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  restart_delay: 1500,
  max_memory_restart: "1G",
  kill_timeout: 8000,
};

// PM2 writes logs relative to the repo root by default; keep them under a
// gitignored .pm2-runtime/<tag>/ tree so concurrent checkouts don't clobber.
const logDir = path.join(repoRoot, ".pm2-runtime", tag);
const outFile = (svc) => path.join(logDir, svc, "out.log");
const errFile = (svc) => path.join(logDir, svc, "err.log");
const logFields = (svc) => ({
  out_file: outFile(svc),
  error_file: errFile(svc),
  merge_logs: true,
  time: true,
});

// ── Frontend app: NODE_ENV selects dev-server vs served SPA (FR8) ───────────
// The Vite dev server cannot run under NODE_ENV=production (jsxDEV runtime
// mismatch — see header), so the frontend serving seam keys off NODE_ENV, not
// the checkout location. This is the ONLY conditional the ecosystem contains,
// plus its build preflight backstop above. Neither upstream seam is patched:
// development runs `react-router dev`; production runs the upstream static
// server against the prebuilt `build/` directory. Both keep the single-origin
// contract: dev via the Vite dev proxy, prod via the static server's own
// reverse proxy (same `backendRoutes` prefix set as the ingress). (FR8.)
//
// Session key fan-out (FR8b): the resolved STACK_SESSION_API_KEY is handed to
// each consumer by the seam that needs it — the backend's key list
// (OH_SESSION_API_KEYS_0, below), the dev frontend's session-key env var
// (VITE_SESSION_API_KEY, here), and the production static server's
// --session-api-key (here). The key is never baked into the build.
const frontendApp = isProductionNodeEnv
  ? {
      name: `frontend-${tag}`,
      namespace,
      cwd: CANVAS_DIR,
      script: PROD_FRONTEND_SCRIPT,
      interpreter: "node",
      args: [
        `--dir ${CANVAS_BUILD_DIR}`,
        `--port ${FRONTEND_PORT}`,
        `--host ${frontendBind}`,
        // Inject the session key into the served index.html at runtime so the
        // prebuilt bundle authenticates to the agent-server without baking the
        // key into the build (preserving FR8b for the served bundle).
        `--session-api-key ${apiKey}`,
        ...backendRoutes.map((r) => `--route ${r}=http://${backendHost}`),
      ].join(" "),
      env: { ...sharedEnv },
      ...supervise,
      ...logFields("frontend"),
    }
  : {
      name: `frontend-${tag}`,
      namespace,
      cwd: CANVAS_DIR,
      script: "npm",
      args: `run dev:frontend -- --host ${frontendBind}`,
      interpreter: "none",
      env: {
        ...sharedEnv,
        VITE_SESSION_API_KEY: apiKey,
        VITE_FRONTEND_PORT: String(FRONTEND_PORT),
        VITE_BACKEND_HOST: backendHost,
      },
      ...supervise,
      ...logFields("frontend"),
    };

const apps = [
  {
    name: `backend-${tag}`,
    namespace,
    cwd: SDK_DIR,
    script: AGENT_SERVER_SCRIPT,
    interpreter: UV_VENV_PYTHON,
    args: `--host ${backendBind} --port ${BACKEND_PORT}`,
    env: { ...sharedEnv, OH_SESSION_API_KEYS_0: apiKey, PYTHONUNBUFFERED: "1" },
    ...supervise,
    ...logFields("backend"),
  },
  frontendApp,
  {
    name: `ingress-${tag}`,
    namespace,
    cwd: repoRoot,
    script: INGRESS_SCRIPT,
    interpreter: "node",
    args: [
      `--port ${INGRESS_PORT}`,
      `--host ${ingressBind}`,
      ...backendRoutes.map((r) => `--route ${r}=http://${backendHost}`),
      `--default http://${frontendBind}:${FRONTEND_PORT}`,
    ].join(" "),
    env: { ...sharedEnv },
    ...supervise,
    ...logFields("ingress"),
  },
];

module.exports = { apps };
