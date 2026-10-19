import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertPackagePath, assertPortableDependencies, json } from "./preview-files.mjs";

// Shared by packed-runtime acceptance and the artifact-only preview builder.
export const packedPackages = [
  { directory: "packages/bootstrap", name: "@tinycloud/bootstrap", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/node-sdk", name: "@tinycloud/node-sdk", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/sdk-rs/packages/node", name: "@tinycloud/node-sdk-wasm", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/wasm/index.cjs", "package/dist/wasm/tinycloud_web_sdk_rs_bg.wasm"] },
  { directory: "packages/sdk-core", name: "@tinycloud/sdk-core", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/sdk-services", name: "@tinycloud/sdk-services", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/share-envelope", name: "@tinycloud/share-envelope", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/share-sdk", name: "@tinycloud/share-sdk", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/operations", name: "@tinycloud/operations", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/secret-capabilities.js", "package/dist/secret-request.js", "package/dist/recovery.js", "package/dist/diagnostics.js", "package/dist/diagnostics.cjs", "package/dist/diagnostics-worker.js", "package/dist/diagnostics-worker.cjs", "package/dist/diagnostics-reproduction.js", "package/dist/diagnostics-reproduction.cjs", "package/generated/operations.json", "package/coverage.json"] },
  { directory: "packages/cli", name: "@tinycloud/cli", required: ["package/dist/bootstrap.js", "package/dist/diagnostics-entry.js", "package/dist/index.js", "package/bin/tc", "package/bin/tinycloud"] },
  { directory: "packages/mcp", name: "@tinycloud/mcp", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/cli.js", "package/dist/http.js", "package/dist/http-cli.js", "package/dist/http-cli.cjs", "package/dist/http-server.js", "package/dist/http-server.cjs", "package/bin/tinycloud-mcp", "package/bin/tinycloud-mcp-http", "package/generated/mcp-facts.json", "package/skills/tinycloud-delegated-secrets/SKILL.md"] },
  { directory: "packages/replica", name: "@tinycloud/replica", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/sqlite.js", "package/dist/sqlite.cjs"] },
];

export const alphaPackage = { name: "@tinycloud/telemetry-preview", version: "0.1.0-alpha.0" };
export const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

// run(command, args, cwd) returns stdout. No registry service and no SDK builds.
export async function packInternalPackages(root, destination, run) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const internal = new Map();
  for (const spec of packedPackages) {
    const result = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], join(root, spec.directory)));
    if (result.length !== 1 || basename(result[0].filename) !== result[0].filename) throw new Error(`Invalid pack result: ${spec.name}`);
    const filename = result[0].filename;
    const path = join(destination, filename);
    const manifest = JSON.parse(await run("tar", ["-xOf", path, "package/package.json"], root));
    if (manifest.name !== spec.name) throw new Error(`Wrong packed identity: ${spec.name}`);
    assertPortableDependencies(manifest);
    const listing = (await run("tar", ["-tzf", path], root)).trim().split("\n");
    for (const item of listing) {
      assertPackagePath(item);
      if (item.includes("/node_modules/")) throw new Error(`Unexpected prebundled dependency: ${item}`);
    }
    for (const required of spec.required) {
      if (!listing.includes(required)) throw new Error(`${spec.name} missing ${required}; build the checkout first`);
    }
    const integrity = `sha512-${createHash("sha512").update(await readFile(path)).digest("base64")}`;
    internal.set(spec.name, { manifest, filename, integrity });
  }
  for (const { manifest } of internal.values()) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith("@tinycloud/") && !internal.has(name)) throw new Error(`Incomplete packed graph: ${manifest.name} needs ${name}`);
      }
    }
  }
  return internal;
}

export function bundledManifest(internal, fields = {}) {
  return {
    ...fields,
    dependencies: {
      ...Object.fromEntries([...internal].map(([name, pack]) => [name, `file:packs/${pack.filename}`])),
      // SIWE requires this peer at runtime; npm does not bundle peer-only installs.
      // Match the existing Bun lock rather than resolve a new peer major.
      ethers: "5.8.0",
    },
    // npm substitutes each root local dependency spec for every transitive edge.
    overrides: Object.fromEntries([...internal.keys()].map((name) => [name, `$${name}`])),
    bundledDependencies: [...internal.keys(), "ethers"],
  };
}

export async function installLockedGraph(directory, internal, run) {
  const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--@tinycloud:registry=http://127.0.0.1:1", "--fetch-retries=0"];
  await run("npm", ["install", "--package-lock-only", ...flags], directory);
  const lock = await json(join(directory, "package-lock.json"));
  if (lock.lockfileVersion !== 3) throw new Error("Expected npm lockfile version 3");
  const found = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (entry.link) throw new Error(`Unresolved package link: ${path}`);
    if (internal.has(name)) {
      const pack = internal.get(name);
      if (entry.version !== pack.manifest.version || entry.integrity !== pack.integrity
        || entry.resolved !== `file:packs/${pack.filename}`) throw new Error(`Internal package escaped local tarball: ${path}`);
      found.add(name);
    } else {
      if (name.startsWith("@tinycloud/")) throw new Error(`Unexpected internal dependency: ${name}`);
      const url = new URL(entry.resolved);
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password
        || !/^sha(?:256|384|512)-/.test(entry.integrity ?? "")) throw new Error(`Unpinned external package: ${path}`);
    }
  }
  if (found.size !== internal.size) throw new Error("Locked internal graph is incomplete");
  await run("npm", ["ci", ...flags], directory);
  return lock;
}
