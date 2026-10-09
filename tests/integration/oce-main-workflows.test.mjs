import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("../../.github/workflows/", import.meta.url).pathname;

test("main carries exactly the gated OCE image workflow", () => {
  assert.deepEqual(readdirSync(dir).sort(), ["oce-image-gated.yml"]);
});

test("the only workflow starts by hand and has no automatic trigger", () => {
  const text = readFileSync(`${dir}oce-image-gated.yml`, "utf8");
  const on = text.slice(text.indexOf("\non:"), text.indexOf("\npermissions:"));
  const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ["workflow_dispatch"]);
});
