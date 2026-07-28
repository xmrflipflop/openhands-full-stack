/**
 * ecosystem.config.js — PM2 process ecosystem for the openhands-full-stack
 * workspace.
 *
 * PRD: docs/prd/1_local-dev-launcher.md
 *
 * This is the single committed PM2 definition. It is SELF-DERIVING: every
 * deployment-specific value (role, app-name tag, ports, PM2 namespace, runtime
 * environment) is computed from where the repo is checked out and a tiny
 * per-checkout .dev-id file. There is no launcher script and no per-invocation
 * flag surface — `pm2 start ecosystem.config.js` is the whole command, and
 * `just dev` forwards to exactly that. NODE_ENV is derived from role
 * (prod → production, dev → development); there are no named env blocks.
 *
 * Three cooperating services, all launched strictly from THIS repository:
 *
 *   backend   OpenHands Agent Server from packages/software-agent-sdk.
 *             PM2's `script` points at the venv's installed `agent-server`
 *             console script (under packages/software-agent-sdk/.venv/bin);
 *             `interpreter` is that venv's python. `uv sync` installs the
 *             workspace members in editable mode, so every openhands-* package
 *             resolves to local sources — never a PyPI release. (FR7)
 *   frontend  Agent Canvas from packages/agent-canvas. The role selects how it
 *             is served, because the two roles run under a different NODE_ENV
 *             (FR10) and `react-router dev` cannot run under NODE_ENV=production
 *             — Vite's SSR JSX transform would import `react/jsx-runtime`
 *             (no `jsxDEV`), crashing the dev server with
 *             `jsxDEV is not a function` (FR8):
 *               • dev  → `react-router dev` (Vite dev server). Its dev proxy
 *                 targets the backend at the backend's derived port via
 *                 VITE_BACKEND_HOST. (FR8 dev)
 *               • prod → upstream `scripts/static-server.mjs` serving the
 *                 prebuilt SPA from packages/agent-canvas/build/ (regenerated
 *                 by `just setup --prod`), with history-mode SPA fallback. Its
 *                 own reverse proxy forwards the same /api, /sockets, … prefix
 *                 set as the ingress, so the prod frontend port behaves like
 *                 Vite's dev server. The session key is injected into the
 *                 served index.html at runtime via --session-api-key (not baked
 *                 into the build), preserving FR8b for the served bundle. (FR8
 *                 prod)
 *   ingress   Workspace-owned single-origin proxy (scripts/dev-local-ingress.mjs)
 *             reusing the upstream reverse-proxy internals unmodified, with a
 *             bind address added so the stack port can stay loopback by
 *             default. (FR9, docs/prd/4_ingress-host-wrapper.md)
 *
 * Role + identity derivation
 *   - Role from path: a checkout under /opt is prod (id 0); anywhere else is
 *     dev. (FR2)
 *   - Each dev checkout carries a .dev-id file (positive integer, unique per
 *     checkout, gitignored). A missing/invalid .dev-id for a non-prod checkout
 *     throws immediately — no silent port clash. (FR3)
 *   - The id is the single source of truth: the app-name tag (`prod` or
 *     `dev<N>`), the PM2 namespace, and the port block all derive from it.
 *     (FR4/FR5)
 *
 * Isolation
 *   Apps are named `<service>-<tag>` and grouped under namespace `tag`, so
 *   `pm2 restart prod`, `pm2 stop dev2`, and `pm2 logs backend-dev1` all work
 *   in the single shared PM2 registry. Multiple dev checkouts (incl. git
 *   worktrees) run concurrently with distinct ports. (FR6)
 *
 * Unprivileged
 *   Nothing binds a port below 1024 or writes outside the checkout, so the
 *   stack runs as the invoking user with no root. Privilege drop via PM2
 *   uid/gid is documented (commented) but off by default and only honoured
 *   when PM2 is started as root. (FR12)
 *
 * The id is read fresh from the filesystem on every PM2 evaluation and baked
 * into `pm2 save` snapshots, so `pm2 resurrect` restores prod + all dev
 * instances with the correct ports. (NFR2)
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");

const repoRoot = __dirname;
const SDK_DIR = path.join(repoRoot, "packages", "software-agent-sdk");
const CANVAS_DIR = path.join(repoRoot, "packages", "agent-canvas");
const UV_VENV_PYTHON = path.join(SDK_DIR, ".venv", "bin", "python");
const AGENT_SERVER_SCRIPT = path.join(SDK_DIR, ".venv", "bin", "agent-server");
const INGRESS_SCRIPT = path.join(repoRoot, "scripts", "dev-local-ingress.mjs");
// Upstream's static file server + reverse proxy. Prod serves the prebuilt SPA
// from packages/agent-canvas/build/ through this script (history-mode SPA
// fallback + /api,/sockets,… prefix proxy + runtime session-key injection).
// Not a workspace patch: the ecosystem only consumes this upstream seam.
// (FR8 prod.)
const STATIC_SERVER_SCRIPT = path.join(
  CANVAS_DIR,
  "scripts",
  "static-server.mjs",
);
const CANVAS_BUILD_DIR = path.join(CANVAS_DIR, "build");

// ── Role + identity (path → role, .dev-id → id) ──────────────────────────────
const isProd = repoRoot.startsWith("/opt/");
let id = 0; // prod = 0
if (!isProd) {
  const devIdFile = path.join(repoRoot, ".dev-id");
  if (!fs.existsSync(devIdFile)) {
    throw new Error(
      `No .dev-id file at ${devIdFile}. Create one with a unique positive ` +
        `integer per checkout, e.g.: echo 1 > ${devIdFile} (PRD FR3).`,
    );
  }
  id = Number(String(fs.readFileSync(devIdFile, "utf8")).trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `.dev-id must be a positive integer (got ${JSON.stringify(String(fs.readFileSync(devIdFile, "utf8")).trim())}).`,
    );
  }
}
// Fail fast if the prod frontend is started without its build artifact. The
// build is one-shot (not part of the PM2 lifecycle) and regenerated by
// `just setup --prod`; a missing build/ that serves nothing is a worse failure
// than a clear message at ecosystem evaluation time. (FR8 prod.)
if (isProd && !fs.existsSync(path.join(CANVAS_BUILD_DIR, "index.html"))) {
  throw new Error(
    `Production frontend requires a built SPA at ${CANVAS_BUILD_DIR}. ` +
      `Run 'just setup --prod' (or 'cd packages/agent-canvas && npm run build') ` +
      `before starting the prod stack (PRD FR8 prod).`,
  );
}
const tag = isProd ? "prod" : `dev${id}`;
const namespace = tag;

// ── Ports derived from id (FR4) ──────────────────────────────────────────────
// Base ports chosen above 1024 and distinct per id. Prod (id 0) uses the base;
// each dev checkout steps by 10 so frontend/backend/ingress sit in a compact
// block with room for the SDK's automation port if ever added.
const step = 10;
const BACKEND_PORT = 18000 + id * step; // prod 18000, dev1 18010, dev2 18020…
const FRONTEND_PORT = 3000 + id * step; // prod 3000, dev1 3010, dev2 3020…
const INGRESS_PORT = 9000 + id * step; // prod 9000, dev1 9010, dev2 9020…

// Bind addresses: loopback by default for every service. Override via env only
// for deliberate exposure; nothing here reads a flag.
const LOOPBACK = "127.0.0.1";
const backendBind = process.env.DEV_BACKEND_BIND || LOOPBACK;
const frontendBind = process.env.DEV_FRONTEND_BIND || LOOPBACK;
const ingressBind = process.env.DEV_INGRESS_BIND || LOOPBACK;

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

// ── Shared env applied to every app (all env modes) ──────────────────────────
// Session API key shared by every app. Guaranteed non-empty: an explicit
// LOCAL_BACKEND_API_KEY takes precedence; otherwise the launcher reads a key
// persisted to ~/.openhands/agent-canvas/dev-local-api-key (the home dir, so
// the key is stable across `just dev` restarts and shared with the published
// `agent-canvas` CLI and the predecessor shell launcher); if that file is
// missing or empty the launcher generates a fresh 64-hex-char (256-bit) key
// and persists it. This mirrors upstream's getOrCreatePersistedApiKeyFile()
// so the frontend never has to collect a key from the user: a non-empty
// VITE_SESSION_API_KEY is what lets makeDefaultLocalBackend() seed the
// backend registry and skip the "configure a backend" onboarding prompt
// (docs/prd/1_local-dev-launcher.md FR8b). The key file is mode 0600
// (credential) and lives under a home path that is never committed.
const persistedKeyPath =
  process.env.OH_SESSION_API_KEY_PATH ||
  path.join(os.homedir(), ".openhands", "agent-canvas", "dev-local-api-key");
function getOrCreateSessionApiKey() {
  const fromEnv = (process.env.LOCAL_BACKEND_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  try {
    const persisted = fs.readFileSync(persistedKeyPath, "utf8").trim();
    if (persisted) return persisted;
  } catch {
    /* file absent — fall through to generation */
  }

  const generated = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(persistedKeyPath), { recursive: true });
  // Write under a restrictive umask so the key file is mode 0600 (credential).
  const prevMask = process.umask(0o177);
  try {
    fs.writeFileSync(persistedKeyPath, generated, { mode: 0o600 });
  } finally {
    process.umask(prevMask);
  }
  return generated;
}
const apiKey = getOrCreateSessionApiKey();
const sharedEnv = {
  PYTHONUTF8: "1",
  DEV_REPO_ROOT: repoRoot,
  OH_SESSION_API_KEYS_0: apiKey,
  VITE_SESSION_API_KEY: apiKey,
};

// NODE_ENV is derived from role: prod → "production", dev → "development".
// It is the ONLY env-mode variable any application code reads (the frontend
// uses it for i18n debug logging and an isDevMode flag; the backend ignores it).
// No DEV_ENV_NAME / env_staging / env_production blocks: the earlier named-
// environment machinery was removed because those values were set but never
// consumed (see docs/prd/1_local-dev-launcher.md FR10).
const NODE_ENV = isProd ? "production" : "development";


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

// ── Frontend app: role selects dev-server (dev) vs served SPA (prod) ────────
// NODE_ENV differs by role (FR10), and the Vite dev server cannot run under
// NODE_ENV=production (jsxDEV runtime mismatch — see header). So the two roles
// serve the frontend through different upstream seams, neither of which this
// workspace patches: dev runs `react-router dev`; prod runs the upstream static
// server against the prebuilt `build/` directory. Both keep the single-origin
// contract: dev via the Vite dev proxy, prod via the static server's own
// reverse proxy (same `backendRoutes` prefix set as the ingress). (FR8.)
const frontendApp = isProd
  ? {
      name: `frontend-${tag}`,
      namespace,
      cwd: CANVAS_DIR,
      script: STATIC_SERVER_SCRIPT,
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
      env: { ...sharedEnv, NODE_ENV },
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
        NODE_ENV,
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
    env: { ...sharedEnv, NODE_ENV, PYTHONUNBUFFERED: "1" },
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
    env: { ...sharedEnv, NODE_ENV },
    ...supervise,
    ...logFields("ingress"),
  },
];

module.exports = { apps };
