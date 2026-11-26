#!/usr/bin/env node
// Writes the npm-shrinkwrap.json that @tinycloud/cli is published with (TC-4276, Gate 1 ruling (a)): every package of
// the CLI's runtime tree at an exact version, with the registry tarball and the integrity it must match. npm installs
// a registry package's shrinkwrap as written, for `npm i -g @tinycloud/cli`, for a project that depends on the CLI
// and for the self-updater's `npm install @tinycloud/cli@<version>`.
//
// The versions are the ones bun.lock gave the tested workspace, not whatever npm would resolve today: bun.lock's
// resolution of every dependency the CLI reaches is handed to npm as a yarn.lock (npm uses yarn.lock entries as the
// version, tarball and integrity for each `name@range` it resolves), npm lays the tree out, and the result is refused
// unless every third-party entry is a bun.lock package with bun.lock's integrity and every @tinycloud package is the
// version this commit carries. The @tinycloud packages are resolved on npm, so they must already be published: this
// runs as the CLI's prepack inside `npm publish`, which the layered release publishes after every package it
// requires is served (.github/scripts/publish-in-dependency-order.mjs).
//
// Every @tinycloud package the shrinkwrap pins must then carry provenance from the Release workflow (changesets.yml
// on master, no other workflow), checked with the updater's own Release-identity check (dist/release-attestation.js),
// or be listed, by name@version and exact sha512 integrity, in unattested-tinycloud-versions.json: the versions
// published before Release provenance (TC-4276 F1 (b), Naomi 21:34Z). Otherwise the publish fails. npm may serve a
// version's attestation after its tarball, so a missing one is retried for up to 2 minutes; nothing else is.
//
// usage: release-shrinkwrap.mjs prepack     in `npm publish` (npm_command=publish): write ./npm-shrinkwrap.json and
//                                           check its @tinycloud provenance; any other pack (tests, `npm pack`)
//                                           does nothing
//        release-shrinkwrap.mjs postpack    in `npm publish`: remove ./npm-shrinkwrap.json again
//        release-shrinkwrap.mjs generate <out>   write the shrinkwrap for this checkout to <out>
//        release-shrinkwrap.mjs published <publish-log>   after the Release publish: fail unless every CLI version
//                                           the log records as accepted is marked `_hasShrinkwrap` by npm

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REGISTRY = "https://registry.npmjs.org/";
const WORKSPACE_PREFIX = "@tinycloud/";

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i];
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(text[next] ?? "")) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

/** The registry tarball npm records for name@version. */
export function registryTarball(name, version) {
  return `${REGISTRY}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}

// A bun.lock package key is the install path below node_modules: "a", "a/b", "@s/a/@s/b".
function keySegments(key) {
  const parts = key.split("/");
  const segments = [];
  for (let i = 0; i < parts.length; i++) segments.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return segments;
}

function splitId(id) {
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

// [[name, spec, optional]] for what installing a package (or a workspace's published manifest) brings in. npm does
// not install an optional peer (bun.lock links one whenever the workspace happens to have it), so those are left out.
function runtimeEdges({ dependencies = {}, optionalDependencies = {}, peerDependencies = {}, peerDependenciesMeta = {}, optionalPeers = [] }) {
  const optionalPeer = new Set([...optionalPeers, ...Object.keys(peerDependenciesMeta).filter((name) => peerDependenciesMeta[name]?.optional)]);
  return [
    ...Object.entries(dependencies).filter(([name]) => !(name in optionalDependencies)).map(([name, spec]) => [name, spec, false]),
    ...Object.entries(optionalDependencies).map(([name, spec]) => [name, spec, true]),
    ...Object.entries(peerDependencies).filter(([name]) => !optionalPeer.has(name)).map(([name, spec]) => [name, spec, false]),
  ];
}

/**
 * What bun.lock installed for the runtime tree of the workspace package `name`: `hints` maps each "dep@spec" the tree
 * requests to the registry package bun.lock resolved it to ({ name, version, integrity }); `packages` holds every such
 * registry package by "name@version" (its bun.lock integrity); `workspaces` maps each workspace package the tree
 * reaches to its version. Throws on anything the shrinkwrap cannot pin to the npm registry.
 */
export function bunRuntimeTree(lock, name) {
  const workspaceByName = new Map(Object.values(lock.workspaces ?? {}).filter((ws) => ws.name).map((ws) => [ws.name, ws]));
  const root = workspaceByName.get(name);
  if (!root) throw new Error(`bun.lock has no workspace package ${name}`);
  const hints = new Map();
  const packages = new Map();
  const workspaces = new Map([[name, root.version]]);
  const visited = new Set();
  const queue = [{ key: name, edges: runtimeEdges(root) }];
  while (queue.length > 0) {
    const { key, edges } = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    const segments = keySegments(key);
    for (const [dep, spec, optional] of edges) {
      let found = null;
      for (let depth = segments.length; depth >= 0 && !found; depth--) {
        const candidate = [...segments.slice(0, depth), dep].join("/");
        if (lock.packages[candidate]) found = candidate;
      }
      if (!found) {
        if (optional) continue;
        throw new Error(`bun.lock does not resolve ${dep}@${spec} (required from ${key})`);
      }
      const [id, registry, meta = {}, integrity] = lock.packages[found];
      const resolved = splitId(id);
      if (resolved.version.startsWith("workspace:")) {
        const ws = workspaceByName.get(resolved.name);
        if (!ws) throw new Error(`bun.lock links ${dep} to an unknown workspace ${id}`);
        if (!resolved.name.startsWith(WORKSPACE_PREFIX)) throw new Error(`${resolved.name} is a workspace package outside ${WORKSPACE_PREFIX}`);
        if (spec !== ws.version) throw new Error(`${key} requires ${dep}@${spec}, but the workspace package is ${ws.version}`);
        workspaces.set(resolved.name, ws.version);
        queue.push({ key: found, edges: runtimeEdges(ws) });
        continue;
      }
      if (resolved.name !== dep) throw new Error(`${dep}@${spec} is an alias of ${id}; the shrinkwrap does not pin aliases`);
      if (registry !== "") throw new Error(`${id} does not come from the npm registry (${registry})`);
      if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) throw new Error(`${id} has no sha512 integrity in bun.lock`);
      const hint = `${dep}@${spec}`;
      const previous = hints.get(hint);
      if (previous && previous.version !== resolved.version) {
        throw new Error(`bun.lock resolves ${hint} to both ${previous.version} and ${resolved.version}; npm can follow only one`);
      }
      hints.set(hint, { name: dep, version: resolved.version, integrity });
      packages.set(id, integrity);
      queue.push({ key: found, edges: runtimeEdges(meta) });
    }
  }
  return { hints, packages, workspaces };
}

/** A yarn v1 lockfile npm reads as the resolution of each "name@spec" (Arborist's checkYarnLock). */
export function yarnLockFor(hints) {
  const quote = (value) => JSON.stringify(value);
  let text = "# yarn lockfile v1\n\n";
  for (const [hint, { name, version, integrity }] of [...hints].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    text += `${quote(hint)}:\n  version ${quote(version)}\n  resolved ${quote(registryTarball(name, version))}\n  integrity ${integrity}\n\n`;
  }
  return text;
}

/**
 * Check `lock` (an npm lockfile v3) as the CLI's shrinkwrap. `problems`: an entry that is not a registry tarball with
 * a sha512 integrity, a @tinycloud entry that is not the workspace version `tree` reached, or another entry that is
 * not a bun.lock package with bun.lock's integrity. `unused`: bun.lock packages of the tree npm did not need (npm
 * reuses a version it already placed when it satisfies a range where bun linked another bun.lock version).
 */
export function checkShrinkwrap(lock, manifest, tree) {
  const problems = [];
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, not 3`);
  const root = lock.packages?.[""];
  if (root?.name !== manifest.name || root?.version !== manifest.version) {
    problems.push(`the root entry is ${root?.name}@${root?.version}, not ${manifest.name}@${manifest.version}`);
  }
  const seen = new Set([`${manifest.name}@${manifest.version}`]);
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (location === "") continue;
    const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
    const id = `${name}@${entry.version}`;
    if (entry.link || entry.name || !location.startsWith("node_modules/")) {
      problems.push(`${location} is not a plain registry package`);
      continue;
    }
    if (entry.dev || entry.devOptional || entry.extraneous) problems.push(`${location} is not a runtime dependency`);
    if (entry.inBundle) {
      let parent = location.slice(0, location.lastIndexOf("/node_modules/"));
      while (lock.packages[parent]?.inBundle) parent = parent.slice(0, parent.lastIndexOf("/node_modules/"));
      const bundler = parent.slice(parent.lastIndexOf("node_modules/") + "node_modules/".length);
      problems.push(`${id} (${location}) is in ${bundler}'s bundleDependencies: npm installs it from ${bundler}'s tarball, so the shrinkwrap can't pin it and the updater can't check its npm signature. Replace ${bundler}, or use a version of it that doesn't bundle dependencies`);
      continue;
    }
    if (entry.resolved !== registryTarball(name, entry.version)) problems.push(`${location} resolves to ${entry.resolved}, not ${registryTarball(name, entry.version)}`);
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) problems.push(`${location} has no sha512 integrity`);
    if (tree.workspaces.has(name)) {
      if (entry.version !== tree.workspaces.get(name)) problems.push(`${location} is ${entry.version}, but this commit releases ${name}@${tree.workspaces.get(name)}`);
      seen.add(id);
      continue;
    }
    if (name.startsWith(WORKSPACE_PREFIX)) {
      problems.push(`${location} is a TinyCloud package bun.lock does not link into the CLI's tree`);
      continue;
    }
    const integrity = tree.packages.get(id);
    if (!integrity) problems.push(`${id} (${location}) is not the version bun.lock installs`);
    else if (integrity !== entry.integrity) problems.push(`${id} (${location}) has integrity ${entry.integrity}, bun.lock has ${integrity}`);
    seen.add(id);
  }
  const unused = [...tree.packages.keys(), ...[...tree.workspaces].map(([name, version]) => `${name}@${version}`)].filter((id) => !seen.has(id));
  return { problems, unused };
}

/** Write the shrinkwrap for the CLI package in `packageDir` (bun.lock from `repoDir`) to `out`. */
export function generateShrinkwrap({ packageDir, repoDir, out, npm = "npm", env = process.env, log = (line) => process.stderr.write(`${line}\n`) }) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const tree = bunRuntimeTree(parseBunLock(readFileSync(join(repoDir, "bun.lock"), "utf8")), manifest.name);
  const work = mkdtempSync(join(tmpdir(), "cli-shrinkwrap-"));
  try {
    const { name, version, license, bin, engines, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } = manifest;
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name, version, license, bin, engines, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta }, null, 2)}\n`);
    writeFileSync(join(work, "yarn.lock"), yarnLockFor(tree.hints));
    const args = ["install", "--package-lock-only", "--lockfile-version=3", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", `--registry=${REGISTRY}`];
    log(`release-shrinkwrap: npm ${args.join(" ")} (${tree.hints.size} bun.lock resolutions, ${tree.workspaces.size} TinyCloud packages)`);
    // npm's lifecycle exports npm_config_* (dry_run, json, ...) that must not reach the nested install.
    const npmEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_/i.test(key)));
    const result = spawnSync(npm, args, { cwd: work, env: npmEnv, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`npm install --package-lock-only failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stdout}${result.stderr}`);
    const text = readFileSync(join(work, "package-lock.json"), "utf8");
    const { problems, unused } = checkShrinkwrap(JSON.parse(text), manifest, tree);
    if (problems.length > 0) throw new Error(`the CLI's runtime tree cannot be shrinkwrapped:\n  ${problems.join("\n  ")}`);
    if (unused.length > 0) log(`release-shrinkwrap: npm reuses another bun.lock version instead of ${unused.join(", ")}`);
    writeFileSync(`${out}.tmp`, text);
    renameSync(`${out}.tmp`, out);
    log(`release-shrinkwrap: wrote ${out} (${Object.keys(JSON.parse(text).packages).length - 1} packages)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The CLI versions among `accepted` ("name@version" ids a publish log records) whose registry version document is
 * not marked `_hasShrinkwrap`. The registry marks a version whose tarball carries npm-shrinkwrap.json, and npm
 * installs a dependency's shrinkwrap only then; the self-updater refuses a release without one.
 */
export async function versionsWithoutShrinkwrap(accepted, name, fetchFn = fetch) {
  const missing = [];
  for (const id of accepted) {
    if (!id.startsWith(`${name}@`)) continue;
    const response = await fetchFn(`${REGISTRY}${name}/${id.slice(name.length + 1)}`, { headers: { accept: "application/json", "cache-control": "no-cache" } });
    const doc = response.status === 200 ? await response.json() : null;
    if (doc?._hasShrinkwrap !== true) missing.push(`${id} (${doc ? `_hasShrinkwrap is ${doc._hasShrinkwrap}` : `registry answered ${response.status}`})`);
  }
  return missing;
}

/** The committed unattested @tinycloud versions: "name@version" → the sha512 integrity npm serves for it. */
export function readUnattested(path = new URL("./unattested-tinycloud-versions.json", import.meta.url)) {
  const versions = JSON.parse(readFileSync(path, "utf8")).versions;
  return new Map(Object.entries(versions).map(([id, entry]) => [id, entry.integrity]));
}

/** How long a missing attestation is retried in total: npm may serve it after the tarball (Naomi 21:34Z). */
export const MISSING_PROVENANCE_RETRY_MS = 2 * 60 * 1000;

/**
 * `verify`, retried with backoff (5 s, doubling) while it fails with PROVENANCE_MISSING, until `budgetMs` has passed.
 * Any other failure is final.
 */
export function retryingMissingProvenance(verify, { budgetMs = MISSING_PROVENANCE_RETRY_MS, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  return async (...args) => {
    const deadline = now() + budgetMs;
    for (let delay = 5000; ; delay *= 2) {
      try {
        return await verify(...args);
      } catch (error) {
        const wait = Math.min(delay, deadline - now());
        if (error?.code !== "PROVENANCE_MISSING" || wait <= 0) throw error;
        await sleep(wait);
      }
    }
  };
}

/**
 * Problems with the @tinycloud packages in `lock` (an npm lockfile): each must be in `unattested` with exactly its
 * integrity, or `verify(name, version, integrity)` must resolve, which it does only for npm's tarball with
 * provenance from the Release workflow. Third-party packages are not checked here.
 */
export async function tinycloudProvenanceProblems(lock, unattested, verify) {
  const problems = [];
  const attested = [];
  const listed = [];
  const seen = new Set();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    const name = typeof entry.name === "string" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const id = `${name}@${entry.version}`;
    if (!name.startsWith(WORKSPACE_PREFIX) || seen.has(`${id} ${entry.integrity}`)) continue;
    seen.add(`${id} ${entry.integrity}`);
    if (unattested.has(id)) {
      if (unattested.get(id) === entry.integrity) listed.push(id);
      else problems.push(`${id} is listed as unattested with ${unattested.get(id)}, but the shrinkwrap pins ${entry.integrity}`);
      continue;
    }
    try {
      await verify(name, entry.version, entry.integrity);
      attested.push(id);
    } catch (error) {
      problems.push(`${id} has no provenance from the Release workflow and is not listed as unattested: ${error.code ? `${error.code}: ` : ""}${error.message}`);
    }
  }
  return { problems, attested, listed };
}

/** Fail unless every @tinycloud package the shrinkwrap at `shrinkwrapPath` pins is Release-attested or listed. */
async function checkTinycloudProvenance({ packageDir, shrinkwrapPath, log = (line) => process.stderr.write(`${line}\n`) }) {
  const { releaseAttestationVerifier } = await import(pathToFileURL(join(packageDir, "dist", "release-attestation.js")).href);
  const tuf = mkdtempSync(join(tmpdir(), "cli-shrinkwrap-tuf-"));
  try {
    const lock = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
    const verify = retryingMissingProvenance(releaseAttestationVerifier(tuf));
    const { problems, attested, listed } = await tinycloudProvenanceProblems(lock, readUnattested(), verify);
    if (problems.length > 0) throw new Error(`the CLI pins @tinycloud versions without the Release workflow's provenance:\n  ${problems.join("\n  ")}`);
    log(`release-shrinkwrap: Release provenance verified for ${attested.join(", ") || "no @tinycloud package"}; listed as unattested: ${listed.join(", ") || "none"}`);
  } finally {
    rmSync(tuf, { recursive: true, force: true });
  }
}

async function main([mode, arg]) {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoDir = resolve(packageDir, "../..");
  const target = join(packageDir, "npm-shrinkwrap.json");
  if (mode === "prepack") {
    if (process.env.npm_command === "publish") {
      generateShrinkwrap({ packageDir, repoDir, out: target });
      try {
        await checkTinycloudProvenance({ packageDir, shrinkwrapPath: target });
      } catch (error) {
        rmSync(target, { force: true });
        throw error;
      }
    }
  } else if (mode === "postpack") {
    if (process.env.npm_command === "publish") rmSync(target, { force: true });
  } else if (mode === "generate" && arg) {
    generateShrinkwrap({ packageDir, repoDir, out: resolve(arg) });
  } else if (mode === "published" && arg) {
    const { acceptedFromPublishLog } = await import(pathToFileURL(join(repoDir, ".github/scripts/check-npm-release-provenance.mjs")).href);
    const { name } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const missing = await versionsWithoutShrinkwrap(acceptedFromPublishLog(readFileSync(arg, "utf8")), name);
    for (const line of missing) console.log(`::error title=Published without npm-shrinkwrap.json::${line}: npm does not pin its dependency tree and the self-updater refuses it. Publish a patch release of ${name}.`);
    if (missing.length > 0) process.exitCode = 1;
  } else {
    process.stderr.write("usage: release-shrinkwrap.mjs prepack | postpack | generate <out> | published <publish-log>\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release-shrinkwrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}
