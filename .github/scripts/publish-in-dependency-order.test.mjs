import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dependencyLayers,
  publishInOrder,
  tarballUrl,
  waitForTarballs,
  withLayersHidden,
  withoutVersions,
} from "./publish-in-dependency-order.mjs";

const pkg = (name, requires = []) => ({ name, dir: `packages/${name.split("/")[1]}`, requires: requires.map((dep) => [dep, "workspace:*"]) });
const names = (layers) => layers.map((layer) => layer.map((p) => p.name));

test("a package comes after every package it requires, whatever the listing order", () => {
  const layers = dependencyLayers([
    pkg("@x/courier", ["@x/sdk-core", "@x/operations"]),
    pkg("@x/cli", ["@x/courier", "@x/node-sdk"]),
    pkg("@x/node-sdk", ["@x/sdk-core"]),
    pkg("@x/operations", ["@x/sdk-core"]),
    pkg("@x/sdk-core"),
  ]);
  assert.deepEqual(names(layers), [["@x/sdk-core"], ["@x/node-sdk", "@x/operations"], ["@x/courier"], ["@x/cli"]]);
});

test("requirements outside the published set and self-references do not hold a package back", () => {
  assert.deepEqual(names(dependencyLayers([pkg("@x/a", ["left-pad", "@x/a"])])), [["@x/a"]]);
});

test("packages that require each other in a cycle are refused", () => {
  assert.throws(() => dependencyLayers([pkg("@x/a", ["@x/b"]), pkg("@x/b", ["@x/a"])]), /cycle: @x\/a, @x\/b/);
});

test("the tarball URL is the one npm install fetches", () => {
  assert.equal(
    tarballUrl("@tinycloud/courier", "0.6.0-beta.35"),
    "https://registry.npmjs.org/@tinycloud/courier/-/courier-0.6.0-beta.35.tgz",
  );
});

test("waiting returns once every tarball answers 200, and names the ones that never do", async () => {
  const answers = new Map([
    ["https://registry.npmjs.org/@x/a/-/a-1.0.0.tgz", [404, 404, 200]],
    ["https://registry.npmjs.org/@x/b/-/b-1.0.0.tgz", [404]],
  ]);
  let clock = 0;
  const calls = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.method, "HEAD");
    calls.push(url);
    const queue = answers.get(url);
    return { status: queue.length > 1 ? queue.shift() : queue[0] };
  };
  const result = await waitForTarballs(["@x/a@1.0.0", "@x/b@1.0.0"], {
    fetchFn,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    intervalMs: 10,
    timeoutMs: 100,
    log: () => {},
  });
  assert.deepEqual(result.served, ["@x/a@1.0.0"]);
  assert.deepEqual(result.missing, [{ id: "@x/b@1.0.0", status: 404 }]);
  assert.equal(calls.filter((url) => url.includes("/a/")).length, 3, "a served tarball is not asked again");
});

test("a network error counts as not served and is reported", async () => {
  let clock = 0;
  const result = await waitForTarballs(["@x/a@1.0.0"], {
    fetchFn: async () => { throw new Error("ECONNRESET"); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    intervalMs: 10,
    timeoutMs: 20,
    log: () => {},
  });
  assert.deepEqual(result.missing, [{ id: "@x/a@1.0.0", status: "error: ECONNRESET" }]);
});

const accepted = (...ids) =>
  `🦋  success packages published successfully:\n${ids.map((id) => `🦋  ${id}`).join("\n")}\n🦋  Creating git tags...\n${ids.map((id) => `🦋  New tag:  ${id}`).join("\n")}\n`;

test("each layer is published only after the previous layer's tarballs are served", async () => {
  const layers = dependencyLayers([pkg("@x/courier", ["@x/sdk-core"]), pkg("@x/sdk-core")]);
  const events = [];
  const result = await publishInOrder({
    layers,
    log: () => {},
    publishLayer: async (layer) => {
      events.push(`publish ${layer.map((p) => p.name)}`);
      return { status: 0, output: accepted(...layer.map((p) => `${p.name}@1.0.0`)) };
    },
    waitFor: async (ids) => {
      events.push(`wait ${ids}`);
      return { served: ids, missing: [] };
    },
  });
  assert.deepEqual(events, ["publish @x/sdk-core", "wait @x/sdk-core@1.0.0", "publish @x/courier", "wait @x/courier@1.0.0"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.unverified, []);
});

test("a layer whose tarball never appears stops the run before its dependents are published", async () => {
  const layers = dependencyLayers([pkg("@x/courier", ["@x/sdk-core"]), pkg("@x/sdk-core")]);
  const published = [];
  const result = await publishInOrder({
    layers,
    log: () => {},
    publishLayer: async (layer) => {
      published.push(...layer.map((p) => p.name));
      return { status: 0, output: accepted(...layer.map((p) => `${p.name}@1.0.0`)) };
    },
    waitFor: async (ids) => ({ served: [], missing: ids.map((id) => ({ id, status: 404 })) }),
  });
  assert.deepEqual(published, ["@x/sdk-core"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.unverified, ["@x/sdk-core@1.0.0"]);
});

test("a failed layer stops the run, but what npm did accept is still checked", async () => {
  const layers = dependencyLayers([pkg("@x/courier", ["@x/a", "@x/b"]), pkg("@x/a"), pkg("@x/b")]);
  const waited = [];
  const result = await publishInOrder({
    layers,
    log: () => {},
    publishLayer: async () => ({ status: 1, output: accepted("@x/a@1.0.0") }),
    waitFor: async (ids) => {
      waited.push(...ids);
      return { served: ids, missing: [] };
    },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(waited, ["@x/a@1.0.0"]);
});

test("the announce log drops only the versions npm never served", () => {
  const log = accepted("@x/a@1.0.0", "@x/b@1.0.0");
  const announce = withoutVersions(log, ["@x/b@1.0.0"]);
  assert.match(announce, /@x\/a@1\.0\.0/);
  assert.doesNotMatch(announce, /@x\/b@1\.0\.0/);
  assert.equal(withoutVersions(log, []), log);
});

test("only the current layer is public while it publishes, and package.json is restored byte for byte", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "publish-order-"));
  try {
    const layers = dependencyLayers([pkg("@x/courier", ["@x/sdk-core"]), pkg("@x/sdk-core")]);
    const manifests = {};
    for (const { name, dir } of layers.flat()) {
      mkdirSync(join(cwd, dir), { recursive: true });
      manifests[dir] = `{"name":"${name}","version":"1.0.0"}`;
      writeFileSync(join(cwd, dir, "package.json"), manifests[dir]);
    }
    const seen = {};
    await withLayersHidden(layers, 0, async () => {
      for (const { dir } of layers.flat()) seen[dir] = JSON.parse(readFileSync(join(cwd, dir, "package.json"), "utf8")).private;
    }, { cwd });
    assert.deepEqual(seen, { "packages/sdk-core": undefined, "packages/courier": true });
    await withLayersHidden(layers, 1, async () => {
      for (const { dir } of layers.flat()) seen[dir] = JSON.parse(readFileSync(join(cwd, dir, "package.json"), "utf8")).private;
    }, { cwd });
    assert.deepEqual(seen, { "packages/sdk-core": true, "packages/courier": undefined });
    for (const [dir, raw] of Object.entries(manifests)) assert.equal(readFileSync(join(cwd, dir, "package.json"), "utf8"), raw);

    await assert.rejects(withLayersHidden(layers, 0, async () => { throw new Error("boom"); }, { cwd }), /boom/);
    for (const [dir, raw] of Object.entries(manifests)) assert.equal(readFileSync(join(cwd, dir, "package.json"), "utf8"), raw);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
