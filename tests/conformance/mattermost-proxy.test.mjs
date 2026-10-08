import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  createMattermostProxyServer,
  parseAllowedHost,
} from "../../apps/controller/src/mattermost-proxy.mjs";

const WAIT_MS = 10_000;
const options = { timeout: 60_000 };

function bound(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within ${WAIT_MS} ms`)), WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

async function head(port, request) {
  const socket = net.connect({ host: "127.0.0.1", port });
  let response = "";
  try {
    await bound(
      new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => socket.write(request));
        socket.on("data", (chunk) => {
          response += chunk;
          if (response.includes("\r\n\r\n")) resolve();
        });
        socket.once("end", resolve);
      }),
      "proxy response",
    );
    return response;
  } finally {
    socket.destroy();
  }
}

const connect = (port, target) =>
  head(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

test("the allowed host must be one exact host name", () => {
  assert.equal(parseAllowedHost("chat.hybrowlabs.com"), "chat.hybrowlabs.com");
  assert.equal(parseAllowedHost("Chat.Hybrowlabs.COM"), "chat.hybrowlabs.com");
  for (const bad of [
    undefined,
    "",
    "*.hybrowlabs.com",
    ".hybrowlabs.com",
    "hybrowlabs.com:443",
    "chat.hybrowlabs.com,example.com",
    "chat.hybrowlabs.com/path",
    "10.0.0.1",
    "localhost",
    "x@chat.hybrowlabs.com",
  ]) {
    assert.throws(() => parseAllowedHost(bad), /OCC_MATTERMOST_PROXY_ALLOWED_HOST/, String(bad));
  }
});

test("CONNECT to the one allowed host on 443 relays bytes; everything else is refused", options, async (t) => {
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("fixture-upstream");
  });
  const upstreamPort = await listen(t, upstream);
  const dialed = [];
  const proxy = createMattermostProxyServer({
    allowedHost: "chat.hybrowlabs.com",
    createUpstream: ({ host, port }) => {
      dialed.push(`${host}:${port}`);
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
  });
  const port = await listen(t, proxy);

  for (const target of ["chat.hybrowlabs.com:443", "Chat.Hybrowlabs.COM:443"]) {
    const socket = net.connect({ host: "127.0.0.1", port });
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    await bound(new Promise((resolve) => socket.once("connect", resolve)), "connect");
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    await bound(new Promise((resolve) => socket.once("close", resolve)), `${target} close`);
    assert.match(received, /^HTTP\/1\.1 200 Connection Established\r\n\r\nfixture-upstream$/, target);
  }
  assert.deepEqual(dialed, ["chat.hybrowlabs.com:443", "chat.hybrowlabs.com:443"]);

  for (const target of [
    "example.com:443",
    "slack.com:443",
    "hybrowlabs.com:443",
    "evilchat.hybrowlabs.com:443",
    "x.chat.hybrowlabs.com:443",
    "chat.hybrowlabs.com.evil.example:443",
    "chat.hybrowlabs.com:80",
    "chat.hybrowlabs.com:8443",
    "chat.hybrowlabs.com",
    "x@chat.hybrowlabs.com:443",
    "chat.hybrowlabs.com:443@evil.example",
    "chat.hybrowlabs.com:443/x",
    "chat.hybrowlabs.com:443x",
    "103.205.140.189:443",
    "127.0.0.1:443",
    "169.254.169.254:80",
  ]) {
    assert.match(await connect(port, target), /^HTTP\/1\.1 403 Forbidden\r\n/, target);
  }
  assert.equal(dialed.length, 2, "a refused CONNECT never dials anything");
});

test("plain HTTP requests are not proxied", options, async (t) => {
  const proxy = createMattermostProxyServer({ allowedHost: "chat.hybrowlabs.com" });
  const port = await listen(t, proxy);
  assert.match(
    await head(port, "GET http://chat.hybrowlabs.com/ HTTP/1.1\r\nHost: chat.hybrowlabs.com\r\n\r\n"),
    /^HTTP\/1\.1 405 /,
  );
});

test("an unreachable upstream gets 502 and the proxy keeps serving", options, async (t) => {
  const proxy = createMattermostProxyServer({
    allowedHost: "chat.hybrowlabs.com",
    createUpstream: () => net.connect({ host: "127.0.0.1", port: 1 }),
  });
  const port = await listen(t, proxy);
  assert.match(await connect(port, "chat.hybrowlabs.com:443"), /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  assert.match(await connect(port, "example.com:443"), /^HTTP\/1\.1 403 Forbidden\r\n/);
});

test("a refused CONNECT that the client resets leaves the proxy running", options, async (t) => {
  const proxy = createMattermostProxyServer({ allowedHost: "chat.hybrowlabs.com" });
  const port = await listen(t, proxy);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const socket = net.connect({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
    socket.resetAndDestroy();
  }
  assert.match(await connect(port, "example.com:443"), /^HTTP\/1\.1 403 Forbidden/);
});

test("the proxy starts when launched through a symlink (a Kubernetes ConfigMap mount)", options, async (t) => {
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "mattermost-proxy-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "mattermost-proxy.mjs");
  await symlink(new URL("../../apps/controller/src/mattermost-proxy.mjs", import.meta.url).pathname, link);
  const child = spawn(process.execPath, [link], {
    env: { ...process.env, OCC_MATTERMOST_PROXY_ALLOWED_HOST: "chat.hybrowlabs.com", OCC_MATTERMOST_PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const port = await bound(
    new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = /Mattermost proxy listening on (\d+) for chat\.hybrowlabs\.com:443/.exec(stderr);
        if (match) resolve(Number(match[1]));
      });
      child.once("close", (code) => reject(new Error(`proxy exited ${code} without listening: ${stderr}`)));
    }),
    "proxy start through a symlink",
  );
  assert.match(await connect(port, "example.com:443"), /^HTTP\/1\.1 403 Forbidden/);
});
