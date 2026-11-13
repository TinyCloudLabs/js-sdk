#!/usr/bin/env node
// Publish the workspace to npm one dependency layer at a time.
//
// `changeset publish` starts every unpublished package at once, so a package
// can become installable before a package it requires: @tinycloud/courier
// 0.6.0-beta.35 was live a minute before its dependency @tinycloud/sdk-core
// 3.12.0-beta.30 and installs 404'd in that window (Release run 43475327139).
//
// This runs `changeset publish` once per layer of the dependency graph
// (dependencies, peerDependencies and optionalDependencies between public
// workspace packages) and, after each layer, waits until npm serves every
// tarball that layer published. A package is never published until everything
// it requires answers 200 at its tarball URL. A layer that fails to publish or
// to appear stops the run, so a dependent of a missing package never goes out.
//
// `changeset publish` has no package filter, so every package outside the
// current layer is marked `private` while it runs (changesets skips private
// packages) and restored afterwards. Tags, the "packages published successfully:" and
// "New tag:" output and the registry auth are still changesets' own.
//
// usage: publish-in-dependency-order.mjs <publish-log> [<announce-log>]
//   <publish-log>   everything changesets printed, for `record-accepted` and the
//                   next run's pre-publish check
//   <announce-log>  the same log without any version whose tarball never
//                   answered 200: what the GitHub Releases step may announce

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { acceptedFromPublishLog, gitRepo, publicPackages } from "./check-npm-release-provenance.mjs";

const REGISTRY = "https://registry.npmjs.org";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

// Layers of public workspace packages: every package comes after all the
// packages it requires. `requires` is [[name, range], ...] as in
// workspacePackages(); names outside the given set are not ours to order.
export function dependencyLayers(packages) {
  const names = new Set(packages.map((pkg) => pkg.name));
  const pending = new Map(
    packages.map((pkg) => [pkg.name, new Set(pkg.requires.map(([name]) => name).filter((name) => names.has(name) && name !== pkg.name))]),
  );
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const layers = [];
  while (pending.size > 0) {
    const ready = [...pending].filter(([, waiting]) => waiting.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      throw new Error(`Workspace packages require each other in a cycle: ${[...pending.keys()].sort().join(", ")}`);
    }
    for (const name of ready) pending.delete(name);
    for (const waiting of pending.values()) for (const name of ready) waiting.delete(name);
    layers.push(ready.map((name) => byName.get(name)));
  }
  return layers;
}

// The tarball npm serves for name@version.
export function tarballUrl(name, version, registry = REGISTRY) {
  const base = name.split("/").pop();
  return `${registry}/${name}/-/${base}-${version}.tgz`;
}

// The ids ("name@version") whose tarball answers 200 within the timeout, and
// those that do not.
export async function waitForTarballs(ids, {
  fetchFn = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  registry = REGISTRY,
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  const waiting = new Set(ids);
  const served = new Set();
  const status = new Map();
  for (;;) {
    for (const id of [...waiting]) {
      const at = id.lastIndexOf("@");
      const url = tarballUrl(id.slice(0, at), id.slice(at + 1), registry);
      let code;
      try {
        code = (await fetchFn(url, { method: "HEAD", redirect: "follow" })).status;
      } catch (error) {
        code = `error: ${error.message}`;
      }
      status.set(id, code);
      if (code === 200) {
        waiting.delete(id);
        served.add(id);
        log(`npm serves ${url}`);
      }
    }
    if (waiting.size === 0 || now() >= deadline) break;
    await sleep(intervalMs);
  }
  return {
    served: [...served].sort(),
    missing: [...waiting].sort().map((id) => ({ id, status: status.get(id) })),
  };
}

// The log without the lines that list one of `ids` (the "packages published
// successfully:" entries and the "New tag:" lines).
export function withoutVersions(log, ids) {
  const drop = new Set(ids);
  if (drop.size === 0) return log;
  return log
    .split("\n")
    .filter((raw) => {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\S+Z\s+/, "").replace(/^\u{1F98B}\s+/u, "").trim();
      const id = /^(?:New tag:\s+)?(@?[^\s@]+@\d\S*)$/.exec(line)?.[1];
      return id === undefined || !drop.has(id);
    })
    .join("\n");
}

// Publish layer by layer. `publishLayer(layer, index)` runs changesets for that
// layer and resolves to { status, output }; `waitFor(ids)` resolves to
// { served, missing }. Returns { status, output, unverified }.
export async function publishInOrder({ layers, publishLayer, waitFor, log = console.log }) {
  let output = "";
  const unverified = [];
  for (const [index, layer] of layers.entries()) {
    log(`Publishing layer ${index + 1}/${layers.length}: ${layer.map((pkg) => pkg.name).join(", ")}`);
    const result = await publishLayer(layer, index);
    output += result.output;
    const accepted = [...acceptedFromPublishLog(result.output)];
    // Whatever npm accepted must be served before it is announced, even when a sibling failed.
    const { missing } = accepted.length === 0 ? { missing: [] } : await waitFor(accepted);
    for (const { id, status } of missing) {
      log(`::error title=npm does not serve ${id}::${tarballUrl(id.slice(0, id.lastIndexOf("@")), id.slice(id.lastIndexOf("@") + 1))} did not answer 200 (${status}). Packages that require it were not published.`);
      unverified.push(id);
    }
    if (result.status !== 0) {
      log(`changeset publish failed (exit ${result.status}) on layer ${index + 1}; later layers are not published.`);
      return { status: result.status, output, unverified };
    }
    if (missing.length > 0) return { status: 1, output, unverified };
  }
  return { status: 0, output, unverified };
}

// Mark every package outside layer `only` private while `run` executes, then
// restore each package.json exactly as it was. Earlier layers are hidden too:
// npm's package listing can trail its tarballs (TC-1457), and changesets would
// take a package it cannot see yet for unpublished and publish it again.
export async function withLayersHidden(layers, only, run, { read = readFileSync, write = writeFileSync, cwd = process.cwd() } = {}) {
  const originals = [];
  try {
    for (const [index, layer] of layers.entries()) {
      if (index === only) continue;
      for (const pkg of layer) {
        const file = join(cwd, pkg.dir, "package.json");
        const raw = read(file, "utf8");
        originals.push([file, raw]);
        write(file, `${JSON.stringify({ ...JSON.parse(raw), private: true }, null, 2)}\n`);
      }
    }
    return await run();
  } finally {
    for (const [file, raw] of originals.reverse()) write(file, raw);
  }
}

function changesetPublish() {
  return new Promise((resolve, reject) => {
    const child = spawn("bunx", ["changeset", "publish"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    const forward = (stream, sink) => stream.on("data", (chunk) => {
      output += chunk;
      sink.write(chunk);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stdout);
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

async function main([logPath, announcePath]) {
  if (!logPath) {
    console.error("usage: publish-in-dependency-order.mjs <publish-log> [<announce-log>]");
    process.exitCode = 2;
    return;
  }
  const layers = dependencyLayers(publicPackages(gitRepo(), "HEAD"));
  // Appended as each layer finishes: record-accepted must see what npm took even if this process dies later.
  writeFileSync(logPath, "");
  let result;
  try {
    result = await publishInOrder({
      layers,
      publishLayer: async (layer, index) => {
        const published = await withLayersHidden(layers, index, changesetPublish);
        appendFileSync(logPath, published.output);
        return published;
      },
      waitFor: (ids) => waitForTarballs(ids),
    });
  } finally {
    // If this process died, nothing is known to be served: announce nothing.
    if (announcePath) {
      mkdirSync(dirname(announcePath), { recursive: true });
      writeFileSync(announcePath, result ? withoutVersions(result.output, result.unverified) : "");
    }
  }
  process.exitCode = result.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
