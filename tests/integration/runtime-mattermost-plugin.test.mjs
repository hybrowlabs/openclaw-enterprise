import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(new URL("../../deploy/runtime/Dockerfile", import.meta.url), "utf8");
const assets = await readFile(
  new URL("../../scripts/build-runtime-assets.mjs", import.meta.url),
  "utf8",
);

test("runtime image builds, prunes to and checks the Mattermost plugin with Codex and Slack", () => {
  assert.match(
    dockerfile,
    /OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS=codex,mattermost,slack\b/,
    "build plugin list",
  );
  assert.match(
    dockerfile,
    /OPENCLAW_EXTENSIONS=codex,mattermost,slack node scripts\/prune-docker-plugin-dist\.mjs/,
    "prune plugin list",
  );
  assert.match(
    dockerfile,
    /for \(const plugin of \["codex", "mattermost", "slack"\]\)/,
    "dependency link loop",
  );
  assert.match(
    dockerfile,
    /test -f \/app\/dist\/extensions\/mattermost\/openclaw\.plugin\.json/,
    "plugin presence check",
  );
});

test("runtime inputs and provenance select the same plugin set", () => {
  assert.match(assets, /"codex,mattermost,slack",/, "inputs plugin selection");
  assert.match(assets, /plugins: \["codex", "mattermost", "slack"\]/, "provenance plugins");
});

test("the runtime build can be given an explicit tsdown heap (rootless builders hide the cgroup limit)", () => {
  assert.match(dockerfile, /^ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=""$/m, "build arg with an empty default");
  assert.match(
    dockerfile,
    /OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB="\$OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB"[\s\S]*?pnpm build:docker/,
    "passed to pnpm build:docker",
  );
});

test("the Mattermost proxy-routing patch is applied to the pinned OpenClaw source by hash", async () => {
  const { createHash } = await import("node:crypto");
  const patch = await readFile(
    new URL("../../deploy/runtime/openclaw-mattermost-proxy.patch", import.meta.url),
  );
  const hash = createHash("sha256").update(patch).digest("hex");
  assert.match(
    dockerfile,
    new RegExp(
      `COPY deploy/runtime/openclaw-mattermost-proxy\\.patch /tmp/openclaw-mattermost-proxy\\.patch\\nRUN echo '${hash}  /tmp/openclaw-mattermost-proxy\\.patch' \\| sha256sum --check --strict \\\\\\n    && git apply /tmp/openclaw-mattermost-proxy\\.patch`,
    ),
    "COPY + sha256 check + git apply, with the current patch hash",
  );
  const text = patch.toString("utf8");
  assert.match(text, /withTrustedEnvProxyGuardedFetchMode/, "REST goes through the env proxy");
  assert.match(text, /resolveMattermostWebSocketAgent/, "WebSocket goes through the env proxy");
  assert.doesNotMatch(text, /dangerouslyAllowPrivateNetwork/, "no private-network opt-in");
});
