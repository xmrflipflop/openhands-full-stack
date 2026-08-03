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
 *   STACK_TAG,      STACK_SESSION_API_KEY,
 *   STACK_WORKSPACE_DIR, STACK_CONVERSATIONS_DIR, STACK_BASH_EVENTS_DIR,
 *   STACK_VITE_WORKING_DIR
 *   NODE_ENV is optional and defaults to "development".
 *
 * Three cooperating services, all launched strictly from THIS repository:
 *
 *   backend   OpenHands Agent Server from packages/software-agent-sdk.
 *             PM2's `script` points at the venv's installed `agent-server`
 *             console script; `interpreter` is that venv's python. `uv sync`
 *             installs workspace members in editable mode — local sources only.
 *             (FR7)
 *   frontend  Agent Canvas from packages/OpenHands. The NODE_ENV-appropriate
 *             serving seam is selected here, because `react-router dev` cannot
 *             run under NODE_ENV=production (Vite's SSR JSX transform would
 *             import `react/jsx-runtime` with no `jsxDEV`, crashing the dev
 *             server). This is the ONLY conditional the ecosystem contains,
 *             plus its production build preflight backstop (FR8/FR8c):
 *               • development → `react-router dev` (Vite dev server). Its dev
 *                 proxy targets the backend via VITE_BACKEND_HOST. (FR8 dev)
 *               • production  → workspace wrapper
 *                 `scripts/prod-frontend-server.mjs` (PM2 entry shim) which
 *                 imports `parseArgs` + `startStaticServer` from upstream
 *                 `packages/OpenHands/scripts/static-server.mjs`. The upstream
 *                 script guards its entry behind an `isMainModule` check that
 *                 fails under PM2 fork mode, so the wrapper runs the exported
 *                 functions directly. Serves the prebuilt SPA from
 *                 packages/OpenHands/build/ with history-mode fallback. Its
 *                 reverse proxy forwards the same prefix set as the ingress.
 *                 The session key is injected at runtime via --session-api-key
 *                 (not baked into the build), preserving FR8b. (FR8 prod)
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
 * Unprivileged: nothing binds a port below 1024 or writes outside the checkout
 * (FR12). Privilege drop via PM2 uid/gid is documented but off by default.
 */

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = __dirname;
const SDK_DIR = path.join(repoRoot, "packages", "software-agent-sdk");
const CANVAS_DIR = path.join(repoRoot, "packages", "OpenHands");
const UV_VENV_PYTHON = path.join(SDK_DIR, ".venv", "bin", "python");
const AGENT_SERVER_SCRIPT = path.join(SDK_DIR, ".venv", "bin", "agent-server");
const INGRESS_SCRIPT = path.join(repoRoot, "scripts", "dev-local-ingress.mjs");
// Workspace-owned PM2 entry shim for upstream static server (PM2 fork mode
// guard fails; wrapper imports parseArgs + startStaticServer and runs them).
const PROD_FRONTEND_SCRIPT = path.join(repoRoot, "scripts", "prod-frontend-server.mjs");
const CANVAS_BUILD_DIR = path.join(CANVAS_DIR, "build");

// ── Consumer values (everything the launcher resolves; FR15) ─────────────────
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
const workspaceDir = requireStackVar("STACK_WORKSPACE_DIR");
const conversationsDir = requireStackVar("STACK_CONVERSATIONS_DIR");
const bashEventsDir = requireStackVar("STACK_BASH_EVENTS_DIR");
// Per-conversation working dir base for conversations without explicit workspace.
// Frontend reads via import.meta.env.VITE_WORKING_DIR.
// DEV honors at serve time (Vite exposes VITE_* to import.meta.env).
// PROD bakes it at build time — served bundle must be rebuilt with env set.
const viteWorkingDir = requireStackVar("STACK_VITE_WORKING_DIR");
const namespace = tag;

const NODE_ENV = process.env.NODE_ENV || "development";
const isProductionNodeEnv = NODE_ENV === "production";

const backendHost = `${backendBind}:${BACKEND_PORT}`;

// Backend URL path prefixes forwarded to the agent-server. Shared by Vite dev
// proxy, ingress, and prod static-server to keep routing identical.
const backendRoutes = [
  "/api", "/sockets", "/server_info", "/alive", "/health", "/ready",
  "/docs", "/redoc", "/openapi.json",
];

// ── Production build preflight backstop (FR8c) ───────────────────────────────
// Launcher checks first; ecosystem repeats as backstop so a snapshot
// re-evaluation cannot silently serve nothing. Build is out-of-band via
// `just setup --production`.
if (isProductionNodeEnv && !fs.existsSync(path.join(CANVAS_BUILD_DIR, "index.html"))) {
  throw new Error(
    `Production requires a built frontend SPA at ${CANVAS_BUILD_DIR} ` +
      `(missing index.html). Run 'just setup --production' (or ` +
      `'cd packages/OpenHands && npm run build') before starting the ` +
      `production stack.`,
  );
}

// ── Shared env applied to every app (all modes) ──────────────────────────────
// Session key is fanned out per consumer (FR8b): OH_SESSION_API_KEYS_0 to
// backend, VITE_SESSION_API_KEY to dev frontend, --session-api-key to prod.
const sharedEnv = {
  PYTHONUTF8: "1",
  DEV_REPO_ROOT: repoRoot,
  NODE_ENV,
  OH_WORKSPACE_PATH: workspaceDir,
  OH_CONVERSATIONS_PATH: conversationsDir,
  OH_BASH_EVENTS_DIR: bashEventsDir,
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
// Vite dev server cannot run under NODE_ENV=production (jsxDEV runtime
// mismatch — see header). This is the ONLY conditional the ecosystem contains.
// Session key fan-out (FR8b): STACK_SESSION_API_KEY handed to each consumer
// by the seam that needs it — backend key list, dev frontend env var,
// prod static server --session-api-key. Key is never baked into the build.
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
        // Inject session key into served index.html at runtime so prebuilt
        // bundle authenticates without baking key into build (FR8b).
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
        // Per-conversation working_dir base for conversations without explicit
        // workspace (FR20). Frontend reads via import.meta.env.VITE_WORKING_DIR.
        // DEV only — PROD bakes it at build time.
        VITE_WORKING_DIR: viteWorkingDir,
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
