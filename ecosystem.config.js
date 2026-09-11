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
 *   STACK_FE_PORT, STACK_BE_PORT, STACK_AUTOMATION_PORT, STACK_INGRESS_PORT,
 *   STACK_FE_BIND,  STACK_BE_BIND,  STACK_AUTOMATION_BIND,  STACK_INGRESS_BIND,
 *   STACK_TAG,      STACK_SESSION_API_KEY,
 *   STACK_WORKSPACE_DIR, STACK_CONVERSATIONS_DIR, STACK_BASH_EVENTS_DIR,
 *   STACK_AUTOMATION_DB, STACK_AUTOMATION_STORAGE_DIR,
 *   STACK_AUTOMATION_WORKSPACE_DIR,
 *   STACK_VITE_WORKING_DIR
 *   NODE_ENV is optional and defaults to "development".
 *   OH_CONVERSATION_WORKTREE_ROOT is optional: the operator's env var, parsed into
 *   an absolute directory (a leading ~ is home-relative; other paths resolve
 *   against the checkout) and forwarded to the backend when set, so
 *   per-conversation worktrees leave the agent-server's built-in /tmp default.
 *
 * Four cooperating services, all launched strictly from THIS repository:
 *
 *   backend   OpenHands Agent Server from packages/software-agent-sdk.
 *             PM2's `script` points at the venv's installed `agent-server`
 *             console script; `interpreter` is that venv's python. `uv sync`
 *             installs workspace members in editable mode — local sources only.
 *             (FR7)
 *   automation OpenHands Automation service from packages/automation, run in
 *             "local mode" (a persistent local agent server instead of cloud
 *             sandboxes). PM2's `script` is the automation venv's `uvicorn`
 *             with the app module `openhands.automation.app:app`. It talks to
 *             the backend over the resolved STACK_ values, keeps its state in
 *             a SQLite DB under the workspace dir, and serves its API at
 *             /api/automation — routed by the ingress.
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
const os = require("node:os");

const repoRoot = __dirname;
const SDK_DIR = path.join(repoRoot, "packages", "software-agent-sdk");
const CANVAS_DIR = path.join(repoRoot, "packages", "OpenHands");
const AUTOMATION_DIR = path.join(repoRoot, "packages", "automation");
const UV_VENV_PYTHON = path.join(SDK_DIR, ".venv", "bin", "python");
const AGENT_SERVER_SCRIPT = path.join(SDK_DIR, ".venv", "bin", "agent-server");
// The automation service is installed into its own venv by `uv sync`
// (just setup); its entry point is the app module run by uvicorn.
const AUTOMATION_UVICORN = path.join(AUTOMATION_DIR, ".venv", "bin", "uvicorn");
const AUTOMATION_VENV_PYTHON = path.join(AUTOMATION_DIR, ".venv", "bin", "python");
const AUTOMATION_APP_MODULE = "openhands.automation.app:app";
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
const AUTOMATION_PORT = requireStackVar("STACK_AUTOMATION_PORT");
const INGRESS_PORT = requireStackVar("STACK_INGRESS_PORT");
const frontendBind = requireStackVar("STACK_FE_BIND");
const backendBind = requireStackVar("STACK_BE_BIND");
const automationBind = requireStackVar("STACK_AUTOMATION_BIND");
const ingressBind = requireStackVar("STACK_INGRESS_BIND");
const tag = requireStackVar("STACK_TAG");
const apiKey = requireStackVar("STACK_SESSION_API_KEY");
const workspaceDir = requireStackVar("STACK_WORKSPACE_DIR");
const conversationsDir = requireStackVar("STACK_CONVERSATIONS_DIR");
const bashEventsDir = requireStackVar("STACK_BASH_EVENTS_DIR");
const automationDbPath = requireStackVar("STACK_AUTOMATION_DB");
const automationStorageDir = requireStackVar("STACK_AUTOMATION_STORAGE_DIR");
const automationWorkspaceDir = requireStackVar("STACK_AUTOMATION_WORKSPACE_DIR");
// Optional: the runtime_services JSON the launcher built from the canonical
// upstream builder. Passed to the ingress app so it advertises every local
// service in /server_info, which the frontend renders into agent system
// prompts. Absent/empty when the launcher couldn't build it (e.g. the builder
// file is missing); the stack still runs, agents just lack the advertisement.
const runtimeServicesInfo =
  process.env.STACK_RUNTIME_SERVICES_INFO || null;
// Root dir for per-conversation git worktrees. Parses the operator's
// OH_CONVERSATION_WORKTREE_ROOT into an absolute directory: a value with a
// leading ~ is home-relative (the agent-server reads the value verbatim and
// would otherwise create a literal "~" directory); any other path is resolved
// against the checkout. When unset/empty the backend keeps its built-in
// default, /tmp/conversation-worktrees.
function resolveConversationWorktreeRoot(raw) {
  const value = raw && raw.trim();
  if (!value) return undefined;
  if (value.startsWith("~")) {
    return path.join(os.homedir(), value.slice(1).replace(/^\//, ""));
  }
  return path.resolve(value);
}
const conversationWorktreeRoot = resolveConversationWorktreeRoot(
  process.env.OH_CONVERSATION_WORKTREE_ROOT,
);
// Per-conversation working dir base for conversations without explicit workspace.
// Frontend reads via import.meta.env.VITE_WORKING_DIR.
// DEV honors at serve time (Vite exposes VITE_* to import.meta.env).
// PROD bakes it at build time — served bundle must be rebuilt with env set.
const viteWorkingDir = requireStackVar("STACK_VITE_WORKING_DIR");
const namespace = tag;

const NODE_ENV = process.env.NODE_ENV || "development";
const isProductionNodeEnv = NODE_ENV === "production";

const backendHost = `${backendBind}:${BACKEND_PORT}`;
const automationHost = `${automationBind}:${AUTOMATION_PORT}`;
const ingressHost = `${ingressBind}:${INGRESS_PORT}`;

// Backend URL path prefixes forwarded to the agent-server. Shared by the Vite
// dev proxy, ingress, and prod static-server to keep routing identical.
const backendRoutes = [
  "/api", "/sockets", "/server_info", "/alive", "/health", "/ready",
  "/docs", "/redoc", "/openapi.json",
];

// Automation service prefix. The proxy router matches the LONGEST prefix, so
// /api/automation reaches the automation service while the rest of /api
// keeps hitting the backend — on every proxying path (ingress in both modes,
// prod static server, and the Vite dev proxy via the ingress target).
const automationRoutes = ["/api/automation"];

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
        ...automationRoutes.map((r) => `--route ${r}=http://${automationHost}`),
        ...backendRoutes.map((r) => `--route ${r}=http://${backendHost}`),
      ].join(" "),
      env: {
        ...sharedEnv,
        // Advertise local services in /server_info (FR22a) for browsers that
        // reach this static-server origin directly in prod. Passed via env,
        // not a CLI arg (JSON has spaces; PM2 shell-joins a string args field).
        // The workspace wrapper merges it into the upstream config.
        ...(runtimeServicesInfo && { FRONTEND_RUNTIME_SERVICES_INFO: runtimeServicesInfo }),
      },
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
        // Route the dev-server's /api proxy through the single-origin ingress
        // (not the backend directly) so the automation service — served at
        // /api/automation behind the ingress — is reachable from the frontend
        // origin in dev, matching upstream's agent-canvas launcher. The
        // ingress forwards /api/automation to automation and the rest of /api
        // to the backend.
        VITE_BACKEND_HOST: ingressHost,
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
    env: {
      ...sharedEnv,
      OH_SESSION_API_KEYS_0: apiKey,
      // Exported into every agent command so agents can call the automation
      // service API the same way upstream's agent-canvas launcher does.
      OPENHANDS_AUTOMATION_API_KEY: apiKey,
      ...(conversationWorktreeRoot && { OH_CONVERSATION_WORKTREE_ROOT: conversationWorktreeRoot }),
      PYTHONUNBUFFERED: "1",
    },
    ...supervise,
    ...logFields("backend"),
  },
  {
    // OpenHands Automation service, run from packages/automation in local
    // mode: persistent local agent server, SQLite state, no cloud sandbox
    // lifecycle. The session key is its local API key (browser + the
    // dispatcher) and the KV-store secret (same zero-config default as
    // upstream's agent-canvas launcher).
    name: `automation-${tag}`,
    namespace,
    cwd: AUTOMATION_DIR,
    script: AUTOMATION_UVICORN,
    interpreter: AUTOMATION_VENV_PYTHON,
    args: [
      AUTOMATION_APP_MODULE,
      `--host ${automationBind}`,
      `--port ${AUTOMATION_PORT}`,
    ].join(" "),
    env: {
      ...sharedEnv,
      // Local mode: reach this checkout's agent-server.
      AUTOMATION_AGENT_SERVER_URL: `http://${backendHost}`,
      AUTOMATION_AGENT_SERVER_API_KEY: apiKey,
      // Browser/API clients authenticate with the shared session key.
      AUTOMATION_LOCAL_API_KEY: apiKey,
      // State: SQLite DB + local file store + per-run workspaces, all under
      // the workspace dir (gitignored).
      AUTOMATION_DB_URL: `sqlite+aiosqlite:///${automationDbPath}`,
      FILE_STORE: "local",
      LOCAL_STORAGE_PATH: automationStorageDir,
      AUTOMATION_WORKSPACE_BASE: automationWorkspaceDir,
      // Public base URL + CORS: the single origin the browser uses.
      AUTOMATION_BASE_URL: `http://${ingressHost}`,
      AUTOMATION_CORS_ORIGINS: `http://${ingressHost}`,
      // KV store: derive from the session key when the operator hasn't set
      // a dedicated one.
      ...(process.env.AUTOMATION_KV_SECRET
        ? { AUTOMATION_KV_SECRET: process.env.AUTOMATION_KV_SECRET }
        : { AUTOMATION_KV_SECRET: apiKey }),
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
    },
    ...supervise,
    ...logFields("automation"),
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
      ...automationRoutes.map((r) => `--route ${r}=http://${automationHost}`),
      ...backendRoutes.map((r) => `--route ${r}=http://${backendHost}`),
      `--default http://${frontendBind}:${FRONTEND_PORT}`,
    ].join(" "),
    env: {
      ...sharedEnv,
      // Advertise the local services in /server_info (FR22). The ingress
      // appends runtime_services to the proxied response, so the frontend
      // (which reads /server_info from this single origin in both modes)
      // renders the <RUNTIME_SERVICES> block into agent system prompts.
      // Passed via env, not a CLI arg: the JSON has spaces and PM2 shell-
      // joins a string `args` field, which would corrupt it.
      ...(runtimeServicesInfo && { INGRESS_RUNTIME_SERVICES_INFO: runtimeServicesInfo }),
    },
    ...supervise,
    ...logFields("ingress"),
  },
];

module.exports = { apps };
