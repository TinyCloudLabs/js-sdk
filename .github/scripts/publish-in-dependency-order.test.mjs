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

// A fake npm registry. `packument` and `tarball` give each request's status by its 0-based poll count for that URL kind.
function fakeRegistry({ name = "@x/a", version = "1.0.0", packument, tarball }) {
  const events = [];
  const seen = new Set();
  const counts = { packument: 0, tarball: 0 };
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    const cb = parsed.searchParams.get("cb");
    assert.ok(cb && !seen.has(cb), `every request carries its own cache-busting query: ${url}`);
    seen.add(cb);
    if (parsed.pathname === `/${name}`) {
      assert.equal(init.headers.accept, "application/vnd.npm.install-v1+json");
      assert.equal(init.headers["cache-control"], "no-cache");
      const status = packument(counts.packument++);
      events.push(`packument ${status}`);
      if (status === "not-json") return { status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON"); } };
      if (status === "unlisted") return { status: 200, json: async () => ({ versions: { "0.9.0": {} } }) };
      if (status === "listed") return { status: 200, json: async () => ({ versions: { [version]: {} } }) };
      return { status, json: async () => ({ error: "Not found" }) };
    }
    assert.equal(parsed.pathname, `/${name}/-/${name.split("/")[1]}-${version}.tgz`);
    assert.equal(init.method, "HEAD");
    assert.equal(init.headers["cache-control"], "no-cache");
    const status = tarball(counts.tarball++);
    events.push(`tarball ${status}`);
    return { status };
  };
  return { fetchFn, events, counts };
}

function clock() {
  const state = { time: 0, sleeps: [] };
  return {
    state,
    now: () => state.time,
    sleep: async (ms) => { state.sleeps.push(ms); state.time += ms; },
  };
}

test("a registry that 404s, then lists the version, then serves the tarball: the tarball is asked for only after the packument lists it", async () => {
  const { fetchFn, events } = fakeRegistry({
    packument: (n) => (n < 3 ? 404 : n < 5 ? "unlisted" : "listed"),
    tarball: (n) => (n < 2 ? 404 : 200),
  });
  const time = clock();
  const result = await waitForTarballs(["@x/a@1.0.0"], { fetchFn, sleep: time.sleep, now: time.now, log: () => {} });
  assert.deepEqual(result.served, ["@x/a@1.0.0"]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(events, [
    "packument 404", "packument 404", "packument 404", "packument unlisted", "packument unlisted",
    "packument listed", "tarball 404", "tarball 404", "tarball 200",
  ]);
  assert.ok(time.state.time < 30 * 60_000);
});

test("polls back off from 15 s to 60 s", async () => {
  const { fetchFn } = fakeRegistry({ packument: () => 404, tarball: () => 404 });
  const time = clock();
  await waitForTarballs(["@x/a@1.0.0"], { fetchFn, sleep: time.sleep, now: time.now, timeoutMs: 10 * 60_000, log: () => {} });
  const { sleeps } = time.state;
  assert.deepEqual(sleeps.slice(0, 5), [15_000, 22_500, 33_750, 50_625, 60_000]);
  assert.ok(sleeps.every((ms) => ms <= 60_000), "no wait longer than 60 s");
});

test("a version is declared missing only after the whole 30-minute window, with a last poll at the deadline", async () => {
  const { fetchFn, counts } = fakeRegistry({ packument: () => 404, tarball: () => 404 });
  const time = clock();
  const result = await waitForTarballs(["@x/a@1.0.0"], { fetchFn, sleep: time.sleep, now: time.now, log: () => {} });
  assert.equal(time.state.time, 30 * 60_000);
  assert.deepEqual(result.missing, [{ id: "@x/a@1.0.0", status: "packument 404" }]);
  assert.equal(counts.tarball, 0, "the tarball is never asked for while the packument does not list the version");
  assert.ok(counts.packument > 30);
});

test("a version that is listed but whose tarball never appears is reported with the tarball status", async () => {
  const { fetchFn } = fakeRegistry({ packument: () => "listed", tarball: () => 404 });
  const time = clock();
  const result = await waitForTarballs(["@x/a@1.0.0"], { fetchFn, sleep: time.sleep, now: time.now, timeoutMs: 5 * 60_000, log: () => {} });
  assert.deepEqual(result.missing, [{ id: "@x/a@1.0.0", status: "tarball 404" }]);
  assert.equal(time.state.time, 5 * 60_000);
});

test("an unreadable packument or a network error counts as not listed and is reported", async () => {
  const time = clock();
  const bad = fakeRegistry({ packument: () => "not-json", tarball: () => 200 });
  assert.deepEqual(
    (await waitForTarballs(["@x/a@1.0.0"], { fetchFn: bad.fetchFn, sleep: time.sleep, now: time.now, timeoutMs: 20_000, log: () => {} })).missing,
    [{ id: "@x/a@1.0.0", status: "packument is not valid JSON" }],
  );
  const down = await waitForTarballs(["@x/a@1.0.0"], {
    fetchFn: async () => { throw new Error("ECONNRESET"); }, sleep: time.sleep, now: time.now, timeoutMs: 20_000, log: () => {},
  });
  assert.deepEqual(down.missing, [{ id: "@x/a@1.0.0", status: "packument error: ECONNRESET" }]);
});

test("several versions are tracked independently; a served one is not asked for again", async () => {
  const requests = [];
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push(`${init.method ?? "GET"} ${parsed.pathname}`);
    if (init.method === "HEAD") return { status: 200 };
    const name = decodeURIComponent(parsed.pathname.slice(1));
    const late = name === "@x/b" && requests.filter((r) => r === "GET /@x/b").length < 3;
    return { status: 200, json: async () => ({ versions: late ? {} : { "1.0.0": {} } }) };
  };
  const time = clock();
  const result = await waitForTarballs(["@x/a@1.0.0", "@x/b@1.0.0"], { fetchFn, sleep: time.sleep, now: time.now, log: () => {} });
  assert.deepEqual(result.served, ["@x/a@1.0.0", "@x/b@1.0.0"]);
  assert.equal(requests.filter((r) => r === "GET /@x/a").length, 1);
  assert.equal(requests.filter((r) => r === "HEAD /@x/a/-/a-1.0.0.tgz").length, 1);
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
