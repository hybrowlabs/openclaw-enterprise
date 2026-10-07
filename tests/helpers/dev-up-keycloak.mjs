import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { availablePort } from "./available-port.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

// Each scenario owns a fresh cluster and state directory. Failed teardown must
// leave the recorded endpoint and credentials available for an explicit retry.
export async function keycloakLauncher(t) {
  const root = await mkdtemp(join(tmpdir(), "oce-dev-keycloak-"));
  const stateDirectory = join(root, "state");
  t.after(async () => {
    if (existsSync(stateDirectory)) {
      try {
        await dev("down");
      } catch (error) {
        throw new Error(`Cleanup failed; recovery state retained at ${stateDirectory}`, {
          cause: error,
        });
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const cluster = `occ-dev-keycloak-${randomUUID().slice(0, 8)}`;
  const ports = new Set([443]);
  while (ports.size < 4) {
    ports.add(await availablePort());
  }
  const [, apiPort, kubernetesPort, browserPort] = [...ports];
  const environment = {
    ...process.env,
    OCC_DEVELOPMENT_SIGN_IN: "keycloak",
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
    OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
    OPENCLAW_DEV_PORT: String(apiPort),
    OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
  };
  for (const key of [
    "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY",
    "OPENAI_API_KEY",
    "OPENAI_API_KEY_FILE",
    "CODEX_API_KEY",
    "CODEX_API_KEY_FILE",
  ]) {
    delete environment[key];
  }
  const run = (program, args, env = environment, timeout = 300_000) =>
    execute(program, args, { cwd: repository, env, timeout, maxBuffer: 16 * 1024 * 1024 });
  const dev = async (action, env = environment) => {
    try {
      return await run(
        join(repository, "bin/occ"),
        ["dev", action],
        env,
        action === "up" ? 1_100_000 : 300_000,
      );
    } finally {
      const statePath = join(stateDirectory, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        // Later observations use the engine endpoint the launcher actually selected.
        environment.DOCKER_HOST = state.dockerHost;
      }
    }
  };

  const kubectl = (args) =>
    run("kubectl", [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
      ...args,
    ]);
  const assertCluster = async (present) => {
    const clusters = JSON.parse((await run("k3d", ["cluster", "list", "-o", "json"])).stdout);
    assert.equal(
      clusters.some(({ name }) => name === cluster),
      present,
    );
  };
  return {
    root,
    stateDirectory,
    cluster,
    browserPort,
    environment,
    run,
    dev,
    kubectl,
    assertCluster,
    consoleHost: `console.${cluster}.oce.localhost`,
    keycloakHost: `keycloak.${cluster}.oce.test`,
    read: (name) => readFile(join(stateDirectory, name), "utf8"),
  };
}

// Dial the owned publication while verifying its real DNS identity and CA.
// No host-file edits or global trust changes are needed for this automation.
export function publishedJSON(
  { hostname, port, ca },
  path,
  { method = "GET", headers = {}, body, expectedStatus = 200 } = {},
) {
  return new Promise((resolveResponse, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        ca,
        path,
        method,
        headers: { host: port === 443 ? hostname : `${hostname}:${port}`, ...headers },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, expectedStatus);
            const payload = Buffer.concat(chunks).toString("utf8");
            resolveResponse(payload === "" ? null : JSON.parse(payload));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
