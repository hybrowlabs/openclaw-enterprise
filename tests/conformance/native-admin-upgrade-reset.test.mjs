import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import https from "node:https";
import { EventEmitter } from "node:events";
import test from "node:test";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const Fastify = require("fastify");

test("a client reset during native-admin upgrade admission does not crash", async () => {
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId: "inst_native_admin_upgrade",
    publicOrigin: undefined,
    factory: {
      create() {
        return {};
      },
    },
    getController() {
      return undefined;
    },
    selectedIAMDriver() {
      throw new Error("unused");
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      admissionVerifier: {
        verify() {
          return new Promise(() => {});
        },
      },
    },
    nativeAdmin: { enabled: false, domain: "agents.example.test" },
    nativeAdminGatewayApiKey: undefined,
    webSocketLeaseIntervalMs: undefined,
    auditSink: { async append() {} },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: agent-a.agents.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        setTimeout(() => {
          socket.resetAndDestroy();
          setTimeout(resolve, 300);
        }, 80);
      });
    });
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});

// These cases exercise the registered upgrade listener and shutdown hook without
// binding a port. Only the external decision, audit sink and HTTPS transport are controlled.
function pendingValue() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function settleCallbacks() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class AdmissionSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  writableEnded = false;
  writableLength = 0;
  writes = [];

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  end() {
    this.writableEnded = true;
    return this;
  }

  write(value) {
    this.writes.push(value);
    return true;
  }

  pipe(destination) {
    return destination;
  }
}

function denialOwner(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const installationId = "inst_native_admin_audit";
  const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  const revision = {
    id: "rev_a",
    configuration: {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
    },
  };
  const denied = new Error("The exact platform operation was not authorized.");
  denied.name = "AuthorizationDeniedError";
  denied.authorization = {
    action: "administer",
    resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
  };
  const audits = [];
  const warnings = [];
  const upstreams = [];
  const hooks = new Map();
  const app = {
    server: new EventEmitter(),
    log: { warn: (event) => warnings.push(event) },
    addHook: (name, callback) => hooks.set(name, callback),
  };
  // A missing interception fails before any external network request can occur.
  t.mock.method(https, "request", () => {
    const upstream = new AdmissionSocket();
    upstreams.push(upstream);
    return upstream;
  });
  const access = createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getAdministerableActiveAgentRevision() {
        return overrides.authorize?.({ agent, revision, denied }) ?? Promise.reject(denied);
      },
      selectedDriver: () => ({ getGatewayEndpoint: () => "wss://gateway.example.test" }),
    }),
    selectedIAMDriver: () => ({
      id: "iam_test",
      async lookupIdentity() {
        return {
          kind: "principal",
          id: "actor_1",
          issuer: "https://issuer.example",
          subject: "user-1",
        };
      },
    }),
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
    nativeAdminGatewayApiKey: overrides.transport ?? (async () => "synthetic"),
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      append(event) {
        audits.push(event);
        return overrides.append?.(event) ?? Promise.resolve();
      },
    },
  });
  const request = () => ({
    method: "GET",
    url: "/",
    headers: { host, origin, "sec-websocket-key": "synthetic", "sec-websocket-version": "13" },
    socket: { remoteAddress: "127.0.0.1" },
    destroyed: false,
  });
  return {
    access,
    audits,
    warnings,
    upstreams,
    denied,
    request,
    denials: () => audits.filter((event) => event.kind === "authorization_denial"),
    shutdown: () => hooks.get("preClose")(),
    upgrade() {
      const socket = new AdmissionSocket();
      app.server.emit("upgrade", request(), socket, Buffer.alloc(0));
      return socket;
    },
  };
}

test("native-admin denial ownership closes before a delayed or rejected append", async (t) => {
  const append = pendingValue();
  const owner = denialOwner(t, { append: () => append.promise });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.denials()[0].actor.principalId, "actor_1");
    assert.equal(owner.denials()[0].authorization.action, "administer");
    append.reject(new Error("synthetic sink failure"));
    await settleCallbacks();
    assert.equal(owner.warnings[0].event, "native_admin.websocket_denial_audit_failed");
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    append.resolve();
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

for (const boundary of ["timeout", "disconnect", "shutdown-wait-expiry"]) {
  test(`native-admin denial ownership consumes a denial after ${boundary}`, async (t) => {
    const admission = pendingValue();
    const owner = denialOwner(t, { authorize: () => admission.promise });
    const socket = owner.upgrade();
    let closing;
    try {
      await settleCallbacks();
      if (boundary === "disconnect") {
        socket.destroy();
      } else {
        if (boundary === "shutdown-wait-expiry") {
          closing = owner.shutdown();
          await settleCallbacks();
        }
        t.mock.timers.tick(5_000);
        await settleCallbacks();
        if (closing) {
          await closing;
          assert.equal(owner.warnings[0].event, "native_admin.pending_work_unresolved");
          assert.equal(owner.warnings[0].pending, 1);
        }
      }
      assert.equal(socket.destroyed, true);
      admission.reject(owner.denied);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.denials()[0].resource.id, "agent_a");
      assert.equal(owner.upstreams.length, 0);
    } finally {
      admission.reject(owner.denied);
      socket.destroy();
      await settleCallbacks();
      await (closing ?? owner.shutdown());
    }
  });
}

test("native-admin denial ownership drains admission through append under one deadline", async (t) => {
  const admission = pendingValue();
  const append = pendingValue();
  const owner = denialOwner(t, {
    authorize: () => admission.promise,
    append: () => append.promise,
  });
  const socket = owner.upgrade();
  let finished = false;
  await settleCallbacks();
  const closing = owner.shutdown().then(() => {
    finished = true;
  });
  try {
    await settleCallbacks();
    assert.equal(finished, false);
    t.mock.timers.tick(4_000);
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
    assert.equal(finished, false);
    // The transition to append must not get a second five-second shutdown budget.
    t.mock.timers.tick(1_000);
    await settleCallbacks();
    assert.equal(finished, true);
    assert.equal(owner.warnings[0].pending, 1);
    append.resolve();
    await settleCallbacks();
    await owner.shutdown();
    assert.equal(owner.warnings.length, 1);
    assert.equal(owner.denials().length, 1);
  } finally {
    admission.reject(owner.denied);
    append.resolve();
    socket.destroy();
    await settleCallbacks();
    await closing;
  }
});

for (const boundary of ["timeout", "disconnect", "shutdown"]) {
  test(`native-admin denial ownership never opens a gateway after ${boundary}`, async (t) => {
    const admission = pendingValue();
    let selection;
    const owner = denialOwner(t, {
      authorize(input) {
        selection = input;
        return admission.promise;
      },
    });
    const socket = owner.upgrade();
    let closing;
    try {
      await settleCallbacks();
      if (boundary === "timeout") {
        t.mock.timers.tick(5_000);
        await settleCallbacks();
      } else if (boundary === "disconnect") {
        socket.destroy();
      } else {
        closing = owner.shutdown();
        await settleCallbacks();
      }
      admission.resolve(selection);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.upstreams.length, 0);
      assert.equal(owner.denials().length, 0);
    } finally {
      admission.resolve(selection);
      socket.destroy();
      await settleCallbacks();
      await (closing ?? owner.shutdown());
    }
  });
}

test("native-admin denial ownership closes a denied lease before append settles", async (t) => {
  const append = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
    authorize(input) {
      reads += 1;
      return reads === 1 ? Promise.resolve(input) : Promise.reject(input.denied);
    },
    append(event) {
      return event.kind === "authorization_denial" ? append.promise : Promise.resolve();
    },
  });
  const socket = owner.upgrade();
  const upstreamSocket = new AdmissionSocket();
  try {
    await settleCallbacks();
    assert.equal(owner.upstreams.length, 1);
    owner.upstreams[0].emit(
      "upgrade",
      { statusCode: 101, headers: {} },
      upstreamSocket,
      Buffer.alloc(0),
    );
    await settleCallbacks();
    assert.ok(socket.writes.join("").startsWith("HTTP/1.1 101"));
    t.mock.timers.tick(25_000);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(upstreamSocket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    append.resolve();
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
  } finally {
    append.resolve();
    socket.destroy();
    upstreamSocket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership retains HTTP audit failure and timeout responses", async (t) => {
  const admission = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
    authorize({ denied }) {
      reads += 1;
      return reads === 1 ? Promise.reject(denied) : admission.promise;
    },
    append: () => Promise.reject(new Error("synthetic sink failure")),
  });
  const reply = () => ({
    request: { id: "request_test" },
    header() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  });
  try {
    const timely = reply();
    const raw = owner.request();
    await owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, timely);
    assert.equal(timely.statusCode, 503);
    assert.equal(timely.body.error.code, "DEPENDENCY_UNAVAILABLE");
    const late = reply();
    const pending = owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, late);
    await settleCallbacks();
    t.mock.timers.tick(5_000);
    await pending;
    assert.equal(late.statusCode, 503);
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 2);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    admission.reject(owner.denied);
    await settleCallbacks();
    await owner.shutdown();
  }
});

for (const order of ["denial-first", "deadline-first"]) {
  test(`native-admin denial ownership attempts one audit at the deadline (${order})`, async (t) => {
    const admission = pendingValue();
    const owner = denialOwner(t, { authorize: () => admission.promise });
    if (order === "denial-first") {
      setTimeout(() => admission.reject(owner.denied), 5_000);
    }
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      if (order === "deadline-first") {
        setTimeout(() => admission.reject(owner.denied), 5_000);
      }
      t.mock.timers.tick(5_000);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.upstreams.length, 0);
      t.mock.timers.tick(5_000);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
    } finally {
      admission.reject(owner.denied);
      socket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });
}

test("native-admin denial ownership audits a lease denial after its timeout closes the connection", async (t) => {
  const renewal = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
    authorize(input) {
      reads += 1;
      return reads === 1 ? Promise.resolve(input) : renewal.promise;
    },
  });
  const socket = owner.upgrade();
  const upstreamSocket = new AdmissionSocket();
  try {
    await settleCallbacks();
    owner.upstreams[0].emit(
      "upgrade",
      { statusCode: 101, headers: {} },
      upstreamSocket,
      Buffer.alloc(0),
    );
    await settleCallbacks();
    t.mock.timers.tick(25_000);
    await settleCallbacks();
    assert.equal(reads, 2);
    t.mock.timers.tick(5_000);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    renewal.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.denials()[0].details.nativeAdmin.revisionId, "rev_a");
  } finally {
    renewal.reject(owner.denied);
    socket.destroy();
    upstreamSocket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership preserves reset handling while transport is pending", async (t) => {
  const transport = pendingValue();
  const owner = denialOwner(t, {
    authorize: (selection) => Promise.resolve(selection),
    transport: () => transport.promise,
  });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    socket.emit("error", new Error("synthetic reset"));
    transport.resolve("synthetic");
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    transport.resolve("synthetic");
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership preserves reset handling during admission", async (t) => {
  const admission = pendingValue();
  const owner = denialOwner(t, { authorize: () => admission.promise });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    socket.emit("error", new Error("synthetic reset"));
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    admission.reject(owner.denied);
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership keeps dependency failures distinct from denials", async (t) => {
  const unavailable = new Error("synthetic unavailable dependency");
  unavailable.name = "DependencyUnavailableError";
  const owner = denialOwner(t, { authorize: () => Promise.reject(unavailable) });
  const socket = owner.upgrade();
  await settleCallbacks();
  assert.equal(socket.destroyed, true);
  assert.equal(owner.denials().length, 0);
  assert.equal(owner.upstreams.length, 0);
  await owner.shutdown();
});

test("native-admin denial ownership preserves a timely HTTP denial response", async (t) => {
  const owner = denialOwner(t);
  const raw = owner.request();
  const reply = {
    request: { id: "request_test" },
    header() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  };
  await owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, reply);
  assert.equal(reply.statusCode, 403);
  assert.equal(reply.body.error.code, "FORBIDDEN");
  assert.equal(owner.denials().length, 1);
  assert.equal(owner.upstreams.length, 0);
  await owner.shutdown();
});

test("a client reset during a pending native-admin denial still records the denial", async () => {
  const installationId = "inst_native_admin_upgrade";
  const agent = { id: "agent_a", namespaceId: "ns_a" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const audits = [];
  let rejectAdmission = () => {};
  let admissionEntered = false;
  const admissionGate = new Promise((_resolve, reject) => {
    rejectAdmission = reject;
  });
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: {
      create(input) {
        return input;
      },
    },
    getController() {
      return {
        async resolveAgentReference(predicate) {
          return predicate(agent) ? agent : undefined;
        },
        getAdministerableActiveAgentRevision() {
          admissionEntered = true;
          return admissionGate;
        },
      };
    },
    selectedIAMDriver() {
      return {
        id: "iam_test",
        async lookupIdentity() {
          return {
            kind: "principal",
            id: "actor_1",
            issuer: "https://issuer.example",
            subject: "user-1",
          };
        },
      };
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
    nativeAdminGatewayApiKey: "gateway-test-key",
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      async append(event) {
        audits.push(event);
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
        const waitUntil = Date.now() + 1000;
        const waitForAdmission = () => {
          if (admissionEntered || Date.now() > waitUntil) {
            socket.resetAndDestroy();
            setTimeout(resolve, 50);
            return;
          }
          setTimeout(waitForAdmission, 10);
        };
        setTimeout(waitForAdmission, 20);
      });
    });
    const denied = new Error("The exact platform operation was not authorized.");
    denied.name = "AuthorizationDeniedError";
    denied.authorization = {
      action: "openclaw.agents.native_admin.proxy.authorize",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    rejectAdmission(denied);
    const auditDeadline = Date.now() + 1000;
    while (audits.length === 0 && Date.now() < auditDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(admissionEntered, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, "authorization_denial");
    assert.equal(audits[0].actor.principalId, "actor_1");
    assert.equal(audits[0].outcome, "denied");
    assert.equal(audits[0].details.nativeAdmin.reason, "authorization_denied");
    assert.equal(audits[0].details.nativeAdmin.host, host);
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});
