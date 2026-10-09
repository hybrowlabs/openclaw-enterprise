import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const validator = new URL("../../scripts/ci/oce-trivy-allowlist.sh", import.meta.url).pathname;
const workflowPath = new URL("../../.github/workflows/oce-image-gated.yml", import.meta.url).pathname;
const scope = "ghcr.io/hybrowlabs/oce-runtime:hyba2011-test";
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const entry = (id, expiry = day(20)) =>
  `# scope: ${scope}\nvulnerabilities:\n  - id: ${id}\n    statement: "EXCEPT. proof."\n    expired_at: ${expiry}\n`;

function run(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "allow-"));
  const result = spawnSync("bash", [validator], {
    cwd: dir,
    env: { PATH: process.env.PATH, TRIVY_IGNORE_YAML: yaml, ALLOWLIST_SCOPE: scope },
    encoding: "utf8",
  });
  return { ...result, dir, wrote: existsSync(join(dir, "trivy-allowlist.yaml")) };
}

test("validator script exists", () => assert.ok(existsSync(validator)));

test("empty allowlist is accepted and writes no file", () => {
  const r = run("");
  assert.equal(r.status, 0);
  assert.equal(r.wrote, false);
});

test("a valid allowlist is accepted and written", () => {
  const r = run(entry("CVE-2025-7458"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.wrote, true);
});

for (const [name, yaml] of [
  ["wrong scope", entry("CVE-2025-7458").replace("hyba2011-test", "other")],
  ["missing scope", entry("CVE-2025-7458").split("\n").slice(1).join("\n")],
  ["expired entry", entry("CVE-2025-7458", day(-1))],
  ["expiry beyond 30 days", entry("CVE-2025-7458", day(45))],
  ["missing expired_at", entry("CVE-2025-7458").replace(/ {4}expired_at.*\n/, "")],
  ["node-tar CVE-2026-59873 (fix exists)", entry("CVE-2026-59873")],
  ["proxy-addr CVE-2026-90711 (fix exists)", entry("CVE-2026-90711")],
  ["unknown key", entry("CVE-2025-7458").replace("    expired_at", "    severity: CRITICAL\n    expired_at")],
  ["garbage line", entry("CVE-2025-7458") + "rm -rf /\n"],
  ["no entries", `# scope: ${scope}\nvulnerabilities:\n`],
  ["CRLF line endings", entry("CVE-2025-7458").replace(/\n/g, "\r\n")],
]) {
  test(`rejects ${name}`, () => {
    const r = run(yaml);
    assert.notEqual(r.status, 0, `${name} was accepted`);
    assert.equal(r.wrote, false, "a rejected allowlist must not leave a file behind");
  });
}

test("the workflow file exists", () => assert.ok(existsSync(workflowPath)));

const wf = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

test("workflow is manual only, no pull_request or push triggers", () => {
  assert.match(wf, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(wf, /^ {2}(pull_request|pull_request_target|push|schedule|issues|issue_comment):/m);
});

test("workflow permissions are contents read and packages write only", () => {
  assert.match(wf, /^permissions:\n {2}contents: read\n {2}packages: write\n/m);
  assert.doesNotMatch(wf, /(id-token|actions|issues|pull-requests|checks|statuses|security-events): (write|read)/);
});

test("every action is pinned to a full commit sha", () => {
  const uses = [...wf.matchAll(/^\s*-?\s*uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned by sha`);
  for (const u of uses) assert.match(u, /^actions\//, `${u} is not a GitHub-owned action`);
});

test("source must be a full sha reachable from a hybrow/* branch", () => {
  assert.match(wf, /source_sha/);
  assert.match(wf, /\[0-9a-f\]\{40\}/);
  assert.match(wf, /origin\/hybrow\/\*/);
});

test("gates run in order: tests, plugin gate, sbom, scan, then push, then rescan of the pushed digest", () => {
  const order = ["Unit tests", "Build runtime", "Build controller", "Plugin gate", "SBOM and scan", "Layer check", "Push", "Scan pushed digests"];
  let at = -1;
  for (const name of order) {
    const i = wf.indexOf(`name: ${name}`);
    assert.ok(i > at, `step "${name}" missing or out of order`);
    at = i;
  }
});

test("the workflow uses the shared validator and the CRITICAL gate fails the job", () => {
  assert.match(wf, /scripts\/ci\/oce-trivy-allowlist\.sh/);
  assert.match(wf, /--severity CRITICAL --exit-code 1/);
  assert.match(wf, /gateway lists the mattermost channel/);
  assert.match(wf, /\/app\/dist\/extensions\/mattermost\/openclaw\.plugin\.json/);
});

test("nothing is pushed before the scan gate, never :latest, digest read back", () => {
  assert.ok(wf.indexOf("--severity CRITICAL --exit-code 1") < wf.indexOf("docker push"), "scan before push");
  assert.doesNotMatch(wf, /:latest/);
  assert.match(wf, /imagetools inspect|docker buildx imagetools/);
});

test("login uses the run token on ghcr.io only and is removed", () => {
  assert.match(wf, /docker login ghcr\.io -u "\$GITHUB_ACTOR" --password-stdin/);
  assert.match(wf, /docker logout ghcr\.io/);
  assert.doesNotMatch(wf, /secrets\.(?!GITHUB_TOKEN)/);
});

test("no step prints the environment or enables shell tracing", () => {
  assert.doesNotMatch(wf, /^\s*(env|printenv|set -x)\s*$/m);
  assert.doesNotMatch(wf, /set -[a-z]*x/);
});

test("evidence is uploaded as run artifacts", () => {
  assert.match(wf, /upload-artifact@[0-9a-f]{40}/);
  for (const f of ["sbom-runtime.spdx.json", "trivy-runtime.json", "layer-check.txt"]) assert.match(wf, new RegExp(f.replace(".", "\\.")));
});

test("the job is time-limited and the image source is the repo root Dockerfiles", () => {
  assert.match(wf, /timeout-minutes: \d+/);
  assert.match(wf, /-f deploy\/runtime\/Dockerfile/);
  assert.match(wf, /-f Dockerfile --target runtime/);
});
