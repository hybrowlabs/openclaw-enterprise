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
