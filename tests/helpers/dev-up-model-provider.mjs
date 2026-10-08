import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { availablePort } from "./available-port.mjs";
import {
  configureModelProviderDNS,
  createModelProviderFiles,
  writeModelProviderTrust,
} from "./runtime-model-provider.mjs";

const repository = resolve(import.meta.dirname, "../..");
const ownerLabel = "dev.openclaw.model-provider-owner";
const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const nodeBaseImage =
  "docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";

function execute(command, args, { env, input, timeout = 120_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: repository, env, timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
        } else {
          resolveRun({ stdout, stderr });
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function waitFor(description, operation, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result.done) {
      return result.value;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// This owner exists before any creation request. The caller registers cleanup
// before prepare(), and retains this directory if either cluster or fixture
// teardown fails. The journal also covers creation with a lost engine response.
export function createDevUpModelProvider({ directory, cluster, environment, run = execute }) {
  const owner = randomUUID();
  const prefix = `oce-dev-provider-${owner.slice(0, 8)}`;
  const resources = [];
  const env = { ...environment };
  const journal = join(directory, "resources.json");
  const modelDirectory = join(directory, "model");
  const network = `${prefix}-network`;
  const provider = `${prefix}-endpoint`;
  const node = `k3d-${cluster}-server-0`;
  // Match ordinary public-address model egress without opening NetworkPolicy.
  // This route exists only on the internal Docker network attached to our node.
  const octets = randomBytes(2);
  const subnetBase = `11.${octets[0]}.${octets[1]}`;
  const modelAddress = `${subnetBase}.2`;
  const nodeAddress = `${subnetBase}.3`;
  const command = (program, args, options = {}) => run(program, args, { env, ...options });
  const docker = (args, options) => command("docker", args, options);
  const record = async () => {
    const temporary = `${journal}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ owner, cluster, dockerHost: env.DOCKER_HOST, resources }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, journal);
  };

  async function inspect(kind, name) {
    try {
      return JSON.parse((await docker([kind, "inspect", name])).stdout)[0];
    } catch (error) {
      // A transport/permission failure is not evidence of absence.
      const detail = error.stderr?.trim() ?? "";
      if (
        /No such (?:object|container|network|image):/.test(detail) ||
        (kind === "network" && detail === `Error response from daemon: network ${name} not found`)
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function reserve(kind, name) {
    assert.equal(await inspect(kind, name), undefined, `Fixture resource already exists: ${name}`);
    resources.push({ kind, name });
    await record();
  }

  function owned(resource, value) {
    assert.ok(value, `Fixture resource missing: ${resource.name}`);
    const labels = resource.kind === "network" ? value.Labels : value.Config?.Labels;
    assert.equal(labels?.[ownerLabel], owner, `Refusing unowned ${resource.kind} ${resource.name}`);
    return value;
  }

  async function imageConfig(image) {
    const value = await inspect("image", image);
    assert.ok(value, `Image missing: ${image}`);
    return value.Config;
  }

  async function prepare() {
    assert.equal(
      env.OCC_DEVELOPMENT_CONTAINER_ENGINE,
      "docker",
      "Provider fixture requires Docker",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Pin the same local engine endpoint the launcher will record. Do not
    // mutate the selected Docker context or any process-global environment.
    if (!env.DOCKER_HOST || env.DOCKER_CONTEXT) {
      const context = env.DOCKER_CONTEXT ?? (await docker(["context", "show"])).stdout.trim();
      const contexts = JSON.parse((await docker(["context", "inspect", context])).stdout);
      assert.equal(contexts.length, 1);
      env.DOCKER_HOST = contexts[0].Endpoints.docker.Host;
    }
    assert.match(env.DOCKER_HOST, /^unix:\/\/\//);
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    await record();
    const revision = (await command("git", ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    assert.match(revision, /^[a-f0-9]{40}$/);
    await createModelProviderFiles({ directory: modelDirectory, caName: prefix, run: command });
    const launcherPorts = new Set([
      env.OPENCLAW_DEV_PORT,
      env.OCC_DEVELOPMENT_BROWSER_PORT,
      env.OCC_DEVELOPMENT_KUBERNETES_API_PORT,
    ]);
    let registryPort = await availablePort();
    while (launcherPorts.has(String(registryPort))) {
      registryPort = await availablePort();
    }
    const registry = `127.0.0.1:${registryPort}`;
    const registryName = `${prefix}-registry`;
    await reserve("container", registryName);
    await docker([
      "run",
      "--detach",
      "--name",
      registryName,
      "--label",
      `${ownerLabel}=${owner}`,
      "--publish",
      `${registry}:5000`,
      registryImage,
    ]);
    const controllerTag = `${registry}/${prefix}/controller:${revision}`;
    const baseTag = `${registry}/${prefix}/runtime-base:${revision}`;
    const runtimeTag = `${registry}/${prefix}/runtime:${revision}`;
    // Same recipes and revision inputs as FirstAgentSmoke. Tags are private to
    // this invocation; the launcher receives only the resulting digest pair.
    for (const tag of [controllerTag, baseTag, runtimeTag]) {
      await reserve("image", tag);
    }
    const cache = (role) =>
      env.GITHUB_ACTIONS === "true" && env.ACTIONS_RUNTIME_TOKEN && env.ACTIONS_RESULTS_URL
        ? [
            "--cache-from",
            `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
          ]
        : // The ordinary launcher builds on the engine's default builder. Reuse
          // those layers when this lane has no hosted cache credentials.
          ["--builder", "default"];
    const builds = await Promise.allSettled([
      docker(
        [
          "buildx",
          "build",
          "--load",
          ...cache("controller"),
          "--pull=false",
          "--target",
          "runtime",
          "--build-arg",
          `NODE_BASE_IMAGE=${nodeBaseImage}`,
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--label",
          `${ownerLabel}=${owner}`,
          "--tag",
          controllerTag,
          ".",
        ],
        { timeout: 600_000 },
      ),
      docker(
        [
          "buildx",
          "build",
          "--load",
          ...cache("runtime"),
          "--pull=false",
          "--file",
          "deploy/runtime/Dockerfile",
          "--build-arg",
          `OCC_BUILD_REVISION=${revision}`,
          "--label",
          `${ownerLabel}=${owner}`,
          "--tag",
          baseTag,
          ".",
        ],
        { timeout: 600_000 },
      ),
    ]);
    const failures = builds
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Checkout image builds failed");
    }
    const context = join(directory, "runtime-trust");
    await writeModelProviderTrust({ context, caPath: join(modelDirectory, "ca.pem") });
    await docker([
      "buildx",
      "build",
      "--builder",
      "default",
      "--load",
      "--build-arg",
      `RUNTIME_IMAGE=${baseTag}`,
      "--tag",
      runtimeTag,
      context,
    ]);
    const base = await imageConfig(baseTag);
    const trusted = await imageConfig(runtimeTag);
    for (const key of ["Labels", "User", "Entrypoint", "Cmd", "WorkingDir"]) {
      assert.deepEqual(trusted[key], base[key], `Runtime trust layer changed ${key}`);
    }
    const push = async (tag) => {
      await docker(["push", tag], { timeout: 120_000 });
      const image = await inspect("image", tag);
      assert.equal(image.Config.Labels["org.opencontainers.image.revision"], revision);
      const digest = image.RepoDigests.find((ref) =>
        ref.startsWith(`${tag.slice(0, tag.lastIndexOf(":"))}@`),
      );
      assert.match(digest ?? "", /@sha256:[a-f0-9]{64}$/);
      return digest;
    };
    const controllerImage = await push(controllerTag);
    const runtimeImage = await push(runtimeTag);
    await reserve("network", network);
    await docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      `${subnetBase}.0/29`,
      "--label",
      `${ownerLabel}=${owner}`,
      network,
    ]);
    await reserve("container", provider);
    await docker([
      "run",
      "--detach",
      "--name",
      provider,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      network,
      "--ip",
      modelAddress,
      "--sysctl",
      "net.ipv4.ip_unprivileged_port_start=0",
      "--volume",
      `${modelDirectory}:/fixture:ro`,
      "--env",
      "PROBE_ENDPOINT_MODE=answer",
      "--env",
      "PROBE_ENDPOINT_HOST=0.0.0.0",
      "--entrypoint",
      "node",
      runtimeImage,
      "/fixture/endpoint.mjs",
    ]);
    await waitFor(
      "provider listener",
      async () => ({ done: (await events()).some(({ event }) => event === "listening") }),
      60_000,
    );
    return {
      DOCKER_HOST: env.DOCKER_HOST,
      OCC_DEVELOPMENT_CONTROLLER_IMAGE: controllerImage,
      OCC_KUBERNETES_RUNTIME_IMAGE: runtimeImage,
    };
  }

  async function route(stateDirectory) {
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.cluster, cluster);
    assert.equal(state.containerEngine, "docker");
    assert.equal(state.dockerHost, env.DOCKER_HOST);
    const server = await inspect("container", node);
    assert.equal(server?.Config?.Labels?.["k3d.cluster"], cluster, "Refusing unrelated k3d node");
    await docker(["network", "connect", "--ip", nodeAddress, network, server.Id]);
    await configureModelProviderDNS({
      kubectl: (args, options) =>
        command(
          "kubectl",
          [
            "--kubeconfig",
            join(stateDirectory, "kubeconfig"),
            "--context",
            `k3d-${cluster}`,
            ...args,
          ],
          options,
        ),
      waitFor,
      modelAddress,
      platformNamespace: state.platformNamespace,
      serverFile: `${prefix}.server`,
    });
  }

  async function events() {
    const value = owned(
      { kind: "container", name: provider },
      await inspect("container", provider),
    );
    const { stdout } = await docker(["logs", value.Id]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  }

  async function assertAnswered() {
    const observed = await events();
    const answer = observed.find(
      ({ event, status, at, transport }) =>
        event === "turn-answered" &&
        status === 200 &&
        Number.isSafeInteger(at) &&
        ["https", "websocket"].includes(transport),
    );
    const request = observed.find(
      ({ event, turn, at, transport }) =>
        event === "request" &&
        turn === true &&
        Number.isSafeInteger(at) &&
        at <= answer?.at &&
        transport === answer?.transport,
    );
    assert.ok(request && answer, "Dedicated startup did not receive a completed fixture response");
    // Whitelist receipts: never serialize request bodies, headers or auth values.
    return {
      requestAt: request.at,
      completedAt: answer.at,
      transport: answer.transport,
      status: answer.status,
    };
  }

  async function cleanup() {
    const failures = [];
    for (const resource of [...resources].reverse()) {
      try {
        const value = await inspect(resource.kind, resource.name);
        if (value) {
          owned(resource, value);
          if (resource.kind === "network") {
            for (const [id, endpoint] of Object.entries(value.Containers ?? {})) {
              assert.equal(
                endpoint.Name,
                node,
                "Refusing to disconnect an unrelated network member",
              );
              const server = await inspect("container", id);
              assert.equal(server?.Config?.Labels?.["k3d.cluster"], cluster);
              await docker(["network", "disconnect", value.Id, id]);
            }
          }
          // Remove image tags without force; cached base/registry images are
          // never registered here and remain on the engine.
          await docker([
            resource.kind,
            "rm",
            ...(resource.kind === "container" ? ["--force"] : []),
            resource.kind === "image" ? resource.name : value.Id,
          ]);
        }
        resources.splice(resources.indexOf(resource), 1);
        await record();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `Provider cleanup failed; recovery journal retained at ${journal}`,
      );
    }
  }

  return { prepare, route, assertAnswered, cleanup };
}
