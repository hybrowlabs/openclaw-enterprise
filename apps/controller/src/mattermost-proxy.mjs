import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

// HTTP CONNECT proxy for exactly one Mattermost host on port 443 (HYBA-2011). Derived from slack-proxy.mjs;
// the allowlist is one exact host name: no suffixes, wildcards or IP literals.

const DEFAULT_PORT = 3128;
const CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 2_000;
const HOST_NAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseAllowedHost(value) {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HOST_NAME.test(host)) {
    throw new Error(
      "OCC_MATTERMOST_PROXY_ALLOWED_HOST must be one exact DNS host name (no wildcard, port, path or IP address).",
    );
  }
  return host;
}

function parsePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("OCC_MATTERMOST_PROXY_PORT must be an integer TCP port.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OCC_MATTERMOST_PROXY_PORT must be between 0 and 65535.");
  }
  return port;
}

function parseConnectTarget(target) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(target ?? "");
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host: match[1].toLowerCase(), port };
}

function closeOnSocketError(socket) {
  let closing = false;
  socket.on("error", () => {
    if (closing) {
      return;
    }
    closing = true;
    socket.destroy();
  });
}

function reject(socket, statusCode, message) {
  socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
}

export function createMattermostProxyServer({
  allowedHost,
  createUpstream = ({ host, port }) => net.connect({ host, port }),
} = {}) {
  const allowed = parseAllowedHost(allowedHost);
  const server = createServer((request, response) => {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("CONNECT required\n");
  });

  server.on("connect", (request, clientSocket, head) => {
    // Attach this before reject(). A refused CONNECT that resets emits
    // EPIPE or ECONNRESET while the 403 is written; without a listener
    // that error exits the process.
    closeOnSocketError(clientSocket);
    const target = parseConnectTarget(request.url);
    if (target === undefined || target.port !== 443 || target.host !== allowed) {
      reject(clientSocket, 403, "Forbidden");
      return;
    }
    const upstream = createUpstream(target);
    let connected = false;
    upstream.setTimeout(CONNECT_TIMEOUT_MS);
    upstream.once("connect", () => {
      connected = true;
      upstream.setTimeout(0);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream connection timeout")));
    upstream.once("error", () => {
      if (connected) {
        clientSocket.destroy();
        return;
      }
      reject(clientSocket, 502, "Bad Gateway");
    });
    upstream.once("close", () => clientSocket.destroy());
    clientSocket.once("close", () => upstream.destroy());
    clientSocket.once("error", () => upstream.destroy());
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowedHost = parseAllowedHost(process.env.OCC_MATTERMOST_PROXY_ALLOWED_HOST);
  const port = parsePort(process.env.OCC_MATTERMOST_PROXY_PORT);
  const server = createMattermostProxyServer({ allowedHost });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // The proxy runs as PID 1 in its Pod, where the kernel drops a SIGTERM that has no
  // handler; the Pod would then wait out its termination grace for SIGKILL. Stop
  // listening at once and give short Web API calls a moment to finish. Tunnels are
  // long-lived Socket Mode connections that never drain, so then close them: Slack
  // clients reconnect through the Service to a ready replacement.
  const shutdown = () => {
    server.close();
    const destroyAll = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }, SHUTDOWN_DRAIN_MS);
    destroyAll.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const selectedPort = typeof address === "object" && address !== null ? address.port : port;
    process.stderr.write(`Mattermost proxy listening on ${selectedPort} for ${allowedHost}:443\n`);
  });
}
