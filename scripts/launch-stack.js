#!/usr/bin/env node
/**
 * launch-stack.js — the only supported entry point for the local stack.
 *
 * PRD: docs/prd/1_local-dev-launcher.md
 *
 * Resolves every deployment-specific value (production mode, per-checkout
 * id, app-name tag, ports, bind addresses, session API key, NODE_ENV) and
 * hands the result to PM2 as environment variables that
 * `ecosystem.config.js` consumes. The ecosystem derives NOTHING: it reads
 * `STACK_*` / `NODE_ENV` and hard-errors if a required value is absent,
 * so a bare `pm2 start ecosystem.config.js` fails immediately and names
 * this launcher (FR15). Starting the stack requires this launcher.
 *
 * Responsibilities (FR1):
 *   - Parse flags (FR2).
 *   - Validate `.dev-id`: required for every checkout, incl. production;
 *     validate, never allocate (FR3).
 *   - Resolve ports: each of the six port flags defaults independently;
 *     the computed default is base + id*10, plus 5 for production (FR5).
 *   - Compose the tag `dev-<id>` / `prod-<id>` (FR4), used verbatim as the
 *     app-name suffix, PM2 namespace, and log subdirectory.
 *   - Resolve the session API key by the exact chain the old ecosystem used
 *     (LOCAL_BACKEND_API_KEY -> persisted key -> generated + persisted),
 *     MOVED here unchanged (FR8b). The ecosystem fans the resolved key out
 *     to its three consumers.
 *   - Resolve bind addresses: flag -> legacy DEV_*_BIND env -> loopback
 *     (FR17). Loopback is a security property, not a convenience.
 *   - Production preflight: abort if the prebuilt frontend is missing
 *     (FR8c). The ecosystem repeats this as a backstop.
 *   - Hand off to PM2: foreground (default) via `pm2-runtime start` with a
 *     throwaway PM2_HOME keyed on the tag; `--background` via `pm2 start`
 *     against the shared daemon (FR13). `--dry-run` prints the resolved env
 *     and starts nothing.
 *
 * No dependencies beyond Node (PM2 guarantees Node is present). Resolution
 * is a pure function (NFR6), separate from spawning, and testable without
 * PM2.
 *
 * Usage:
 *   node scripts/launch-stack.js [--fe_port N] [--be_port N] \
 *     [--ingress_port N] [--fe_bind A] [--be_bind A] [--ingress_bind A] \
 *     [--background] [--production] [--dry-run] [--stop]
 *
 * --stop: stop and delete all background stack processes for this checkout.
 *   Reads .dev-id and deletes both dev-<id> and prod-<id> namespaces from
 *   the shared PM2 daemon. Idempotent; works across branch switches because
 *   .dev-id is stable. Ignores all other flags except the implied .dev-id.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");

const LAUNCHER_PATH = __filename;
// The launcher lives under scripts/, so the repo root is its parent.
const REPO_ROOT = path.dirname(__dirname);

const PORT_BASES = { fe: 3000, be: 18000, ingress: 9000 };
const PORT_STEP = 10; // id multiplier — MUST stay larger than PROD_PORT_OFFSET.
const PROD_PORT_OFFSET = 5; // separates prod from dev of the same id.
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const LOOPBACK = "127.0.0.1";

const DEV_ID_FILE = path.join(REPO_ROOT, ".dev-id");
const CANVAS_BUILD_INDEX = path.join(
  REPO_ROOT,
  "packages",
  "agent-canvas",
  "build",
  "index.html",
);
const ECOSYSTEM_FILE = path.join(REPO_ROOT, "ecosystem.config.js");

// ── Pure resolution ──────────────────────────────────────────────────────────

function parseCli(argv) {
  const { values, tokens } = parseArgs({
    args: argv,
    options: {
      fe_port: { type: "string", short: "F" },
      be_port: { type: "string", short: "B" },
      ingress_port: { type: "string", short: "I" },
      fe_bind: { type: "string" },
      be_bind: { type: "string" },
      ingress_bind: { type: "string" },
      background: { type: "boolean", default: false },
      production: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      stop: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  return values;
}

function readDevId(devIdFile) {
  if (!fs.existsSync(devIdFile)) {
    throw new Error(
      `No .dev-id file at ${devIdFile}. Every checkout — including ` +
        `production — now requires a .dev-id with a unique positive ` +
        `integer. Run 'just setup' (which allocates one), or create it ` +
        `manually, e.g.: echo 1 > ${devIdFile}.`,
    );
  }
  const raw = String(fs.readFileSync(devIdFile, "utf8")).trim();
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `.dev-id must be a positive integer (got ${JSON.stringify(raw)} at ` +
        `${devIdFile}). The launcher validates .dev-id; it never allocates ` +
        `one.`,
    );
  }
  return id;
}

/**
 * Resolve the session API key by the exact chain the old ecosystem used
 * (MOVED here unchanged — FR8b). Precedence:
 *   (1) LOCAL_BACKEND_API_KEY env var;
 *   (2) the persisted key at OH_SESSION_API_KEY_PATH (default
 *       ~/.openhands/agent-canvas/dev-local-api-key); if missing/empty,
 *   (3) generate a fresh 256-bit (64-hex-char) key with the CSPRNG and
 *       persist it mode 0600 under that home path (never committed).
 */
function resolveSessionApiKey() {
  const fromEnv = (process.env.LOCAL_BACKEND_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const persistedKeyPath =
    process.env.OH_SESSION_API_KEY_PATH ||
    path.join(os.homedir(), ".openhands", "agent-canvas", "dev-local-api-key");

  try {
    const persisted = fs.readFileSync(persistedKeyPath, "utf8").trim();
    if (persisted) return persisted;
  } catch {
    /* file absent — fall through to generation */
  }

  const { randomBytes } = require("node:crypto");
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

function computeDefaultPort(service, id, isProduction) {
  const base = PORT_BASES[service];
  const offset = id * PORT_STEP + (isProduction ? PROD_PORT_OFFSET : 0);
  return base + offset;
}

function validatePort(service, value, source) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX) {
    throw new Error(
      `Invalid ${service} port from ${source}: ${JSON.stringify(value)}. ` +
        `Must be an integer in ${PORT_MIN}-${PORT_MAX}.`,
    );
  }
  return n;
}

/**
 * Resolve one service's port. The flag value wins; otherwise the formula
 * default is used (each of the six port flags defaults independently).
 */
function resolvePort(service, flagValue, id, isProduction) {
  if (flagValue !== undefined) {
    return validatePort(service, flagValue, `--${service}_port`);
  }
  const computed = computeDefaultPort(service, id, isProduction);
  return validatePort(service, computed, `default (base+id*step${isProduction ? "+prod-offset" : ""})`);
}

function resolveBind(service, flagValue) {
  // Precedence: flag, then the legacy DEV_*_BIND env (kept for continuity
  // with existing shell profiles), then loopback (a security property).
  if (flagValue !== undefined && flagValue !== "") return flagValue;
  const legacyEnvName = `DEV_${service.toUpperCase()}_BIND`;
  const fromLegacy = process.env[legacyEnvName];
  if (fromLegacy && fromLegacy.trim()) return fromLegacy.trim();
  return LOOPBACK;
}

function productionPreflight(isProduction) {
  if (!isProduction) return;
  if (!fs.existsSync(CANVAS_BUILD_INDEX)) {
    throw new Error(
      `Production requires a built frontend SPA at ` +
        `${path.dirname(CANVAS_BUILD_INDEX)} (missing ${CANVAS_BUILD_INDEX}). ` +
        `Run 'just setup --production' (or 'cd packages/agent-canvas && npm run build') ` +
        `before starting the production stack.`,
    );
  }
}

/**
 * Pure resolution of everything the stack needs. Imported/exported so it is
 * testable without PM2 (NFR6).
 * @returns {{fePort:number,bePort:number,ingressPort:number,
 *   feBind:string,beBind:string,ingressBind:string,
 *   tag:string,namespace:string,sessionApiKey:string,
 *   nodeEnv:string,isProduction:boolean,background:boolean,dryRun:boolean,
 *   pm2Home:(string|undefined)}}
 */
function resolve(values) {
  const isProduction = values.production === true;
  const background = values.background === true;
  const dryRun = values["dry-run"] === true;

  const id = readDevId(DEV_ID_FILE);
  const tag = `${isProduction ? "prod" : "dev"}-${id}`;
  const nodeEnv = isProduction ? "production" : "development";

  const fePort = resolvePort("fe", values.fe_port, id, isProduction);
  const bePort = resolvePort("be", values.be_port, id, isProduction);
  const ingressPort = resolvePort("ingress", values.ingress_port, id, isProduction);

  const feBind = resolveBind("fe", values.fe_bind);
  const beBind = resolveBind("be", values.be_bind);
  const ingressBind = resolveBind("ingress", values.ingress_bind);

  productionPreflight(isProduction);
  const sessionApiKey = resolveSessionApiKey();

  // Foreground (default) uses a throwaway PM2_HOME keyed on the tag so the
  // foreground run never touches the shared ~/.pm2 daemon. Background uses
  // the shared daemon and sets no PM2_HOME. (FR13.)
  const pm2Home = background ? undefined : `/tmp/pm2-fg-${tag}`;

  return {
    fePort,
    bePort,
    ingressPort,
    feBind,
    beBind,
    ingressBind,
    tag,
    namespace: tag,
    sessionApiKey,
    nodeEnv,
    isProduction,
    background,
    dryRun,
    pm2Home,
  };
}

/**
 * The environment the ecosystem consumes (FR interface). All required
 * vars are emitted; the ecosystem hard-errors if any required one is missing
 * (naming this launcher). NODE_ENV is always set (defaults to development).
 */
function buildStackEnv(r) {
  return {
    STACK_FE_PORT: String(r.fePort),
    STACK_BE_PORT: String(r.bePort),
    STACK_INGRESS_PORT: String(r.ingressPort),
    STACK_FE_BIND: r.feBind,
    STACK_BE_BIND: r.beBind,
    STACK_INGRESS_BIND: r.ingressBind,
    STACK_TAG: r.tag,
    STACK_SESSION_API_KEY: r.sessionApiKey,
    NODE_ENV: r.nodeEnv,
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

function describeLaunch(r) {
  const runner = r.background ? "pm2" : "pm2-runtime";
  const envLines = Object.entries(buildStackEnv(r))
    .map(([k, v]) => `  ${k}=${v}`)
    .join("\n");
  const pm2HomeLine = r.pm2Home ? `  PM2_HOME=${r.pm2Home} (throwaway)` : `  PM2_HOME=<shared ~/.pm2>`;
  return [
    `[run-stack] runner: ${runner} start ecosystem.config.js`,
    `[run-stack] mode: ${r.isProduction ? "production" : "development"} / ${r.background ? "background" : "foreground"}`,
    `[run-stack] tag:  ${r.tag}`,
    `[run-stack] env:`,
    envLines,
    pm2HomeLine,
  ].join("\n");
}

function spawnPm2(r) {
  const runner = r.background ? "pm2" : "pm2-runtime";
  const childEnv = { ...process.env, ...buildStackEnv(r) };
  if (r.pm2Home) childEnv.PM2_HOME = r.pm2Home;

  const child = spawn(runner, ["start", ECOSYSTEM_FILE], {
    stdio: "inherit",
    env: childEnv,
  });
  child.on("error", (err) => {
    console.error(`[run-stack] failed to spawn ${runner}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[run-stack] ${runner} stopped by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

// ── Entry ────────────────────────────────────────────────────────────────────

/**
 * Stop and delete all background stack processes for the current checkout's .dev-id.
 *
 * Reads .dev-id and deletes both `dev-<id>` and `prod-<id>` namespaces from
 * the shared PM2 daemon.  Idempotent: exits 0 if nothing was running.
 *
 * This works across branch switches because .dev-id is stable (gitignored).
 * Even if the tag changed (e.g. someone flipped --production), every possible
 * namespace for this checkout is cleaned.
 */
function stopBackgroundStack(id) {
  const namespaces = [`dev-${id}`, `prod-${id}`];
  let anyStoped = false;

  return namespaces.reduce((promiseChain, ns) => {
    return promiseChain.then(() => {
      return new Promise((resolve, reject) => {
        const child = spawn("pm2", ["delete", ns], { stdio: ["inherit", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", (err) => {
          if (err.code === "ENOENT") {
            console.error("[stop] pm2 is not installed. Cannot stop background processes.");
            return reject(new Error("pm2 not found"));
          }
          return reject(err);
        });
        child.on("exit", (code) => {
          const out = (stdout + stderr).trim();
          if (code === 0 && out.includes("delete")) {
            console.log(`[stop] namespace removed: ${ns}`);
            anyStoped = true;
          } else if (out.includes("not found") || out.includes("No process")) {
            // Normal: namespace exists but nothing in it, or namespace absent
            console.log(`[stop] nothing stopped in namespace: ${ns}`);
          } else if (code === 0) {
            console.log(`[stop] nothing stopped in namespace: ${ns}`);
          } else {
            // pm2 could be down, etc. — not fatal
            console.log(`[stop] ${ns}: ${out || "pm2 may not be running"}`);
          }
          resolve();
        });
      });
    });
  }, Promise.resolve()).then(() => {
    if (anyStoped) {
      console.log("[stop] done — background processes for id " + id + " removed.");
    } else {
      console.log(`[stop] no background processes to stop for id ${id}.`);
    }
  });
}

function main() {
  let values;
  try {
    values = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`[run-stack] flag error: ${err.message}`);
    console.error(
      `Usage: node scripts/launch-stack.js [--fe_port N] [--be_port N] ` +
        `[--ingress_port N] [--fe_bind A] [--be_bind A] [--ingress_bind A] ` +
        `[--background] [--production] [--dry-run] [--stop]`,
    );
    process.exit(2);
  }

  // --stop bypasses all port/mode resolution; it only needs .dev-id
  if (values.stop) {
    let id;
    try {
      id = readDevId(DEV_ID_FILE);
    } catch (err) {
      console.error(`[stop] ${err.message}`);
      process.exit(1);
    }
    stopBackgroundStack(id).catch(() => { process.exit(1); });
    return;
  }

  let r;
  try {
    r = resolve(values);
  } catch (err) {
    console.error(`[run-stack] ${err.message}`);
    process.exit(1);
  }

  if (r.dryRun) {
    console.log(describeLaunch(r));
    return;
  }

  console.error(describeLaunch(r));
  spawnPm2(r);
}

module.exports = {
  resolve,
  buildStackEnv,
  computeDefaultPort,
  validatePort,
  resolveBind,
  PORT_BASES,
  PORT_STEP,
  PROD_PORT_OFFSET,
  PORT_MIN,
  PORT_MAX,
};

if (require.main === module) {
  main();
}
