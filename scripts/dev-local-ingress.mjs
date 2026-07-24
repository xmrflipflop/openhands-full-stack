#!/usr/bin/env node
/**
 * dev-local-ingress.mjs — workspace-owned ingress runner for dev-local.sh.
 *
 * The upstream standalone ingress (packages/agent-canvas/scripts/ingress.mjs)
 * has no bind-address option: it listens on all interfaces. This wrapper
 * reuses the upstream routing and proxy internals (proxy-utils.mjs, consumed
 * unmodified) and adds only a --host option so the launcher can keep the
 * stack port loopback-only by default.
 *
 * If upstream's ingress ever grows a bind-address option, retire this file
 * and call it directly.
 *
 * PRD: docs/prd/1_local-dev-launcher.md
 *
 * Usage:
 *   node scripts/dev-local-ingress.mjs \
 *     --port 9000 --host 127.0.0.1 \
 *     --route "/api=http://127.0.0.1:18000" \
 *     --default "http://127.0.0.1:8000"
 */

import { createServer } from "node:http";
import process from "node:process";

import {
  createProxyHandlers,
  createRouter,
  isBenignSocketError,
} from "../packages/agent-canvas/scripts/proxy-utils.mjs";

function parseArgs(argv) {
  const config = {
    port: 9000,
    host: "127.0.0.1",
    routes: {},
    defaultBackend: null,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "-p":
      case "--port":
        config.port = parseInt(argv[++i], 10);
        break;
      case "--host":
        config.host = argv[++i];
        break;
      case "-r":
      case "--route": {
        const value = argv[++i] ?? "";
        const sep = value.indexOf("=");
        if (sep <= 0) {
          console.error(`Invalid --route (expected /path=url): ${value}`);
          process.exit(1);
        }
        config.routes[value.slice(0, sep)] = value.slice(sep + 1);
        break;
      }
      case "-d":
      case "--default":
        config.defaultBackend = argv[++i];
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  if (!Number.isInteger(config.port) || config.port <= 0) {
    console.error(`Invalid --port: ${config.port}`);
    process.exit(1);
  }
  if (Object.keys(config.routes).length === 0 && !config.defaultBackend) {
    console.error("No routes configured. Use --route and/or --default.");
    process.exit(1);
  }

  return config;
}

const config = parseArgs(process.argv.slice(2));
const route = createRouter(config.routes, config.defaultBackend);
const proxy = createProxyHandlers({
  label: `ingress:${config.host}:${config.port}`,
});
const uninstallDiagnostics = proxy.installDiagnostics();

const server = createServer((req, res) => {
  const backend = route(req.url ?? "/");
  if (!backend) {
    res.writeHead(503);
    res.end("No backend configured for this route");
    return;
  }
  proxy.proxyHttp(req, res, backend);
});

server.on("upgrade", (req, socket, head) => {
  const backend = route(req.url ?? "/");
  if (!backend) {
    socket.destroy();
    return;
  }
  proxy.proxyWebSocket(req, socket, head, backend);
});

server.on("clientError", (err, socket) => {
  if (!isBenignSocketError(err)) {
    console.error("Client error:", err.message);
  }
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } else {
    socket.destroy();
  }
});

// The upstream proxy internals (httpxy's timeout option) add one "timeout"
// listener to the TCP socket per proxied request. Keep-alive connections
// serve many requests per socket, so Node's default 10-listener cap emits a
// benign MaxListenersExceededWarning. Lift the cap per connection; listeners
// are freed when the socket closes. Remove if fixed upstream.
server.on("connection", (socket) => socket.setMaxListeners(0));

server.on("close", uninstallDiagnostics);

server.listen(config.port, config.host, () => {
  console.log(`Ingress listening on http://${config.host}:${config.port}/`);
  const sorted = Object.entries(config.routes).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [path, backend] of sorted) {
    console.log(`  ${path} -> ${backend}`);
  }
  if (config.defaultBackend) {
    console.log(`  * (default) -> ${config.defaultBackend}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
