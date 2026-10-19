#!/usr/bin/env node
// Artifact-only: prebuilt, pinned checkout in; one ordinary npm alpha tarball out.
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { alphaPackage, packedPackages, packInternalPackages, bundledManifest, installLockedGraph, writeJson } from "./packed-packages.mjs";
import { assertPackagePath, assertPlatform, assertPortableDependencies, inventory, json, sha256, within } from "./preview-files.mjs";

const usage = `Usage: node scripts/build-team-preview.mjs --source-sha SHA --output NEW_DIR --guidance CURATED_DIR --guidance-identity JSON
Requires a prebuilt, committed checkout, Node 22.23.2, Linux x64 glibc, npm and tar.
Guidance identity: {sourceCommit:40hex,rulesVersion,files:{relativePath:sha256},rules:{"SKILL.md":relativePath,"SQL.md":relativePath}}.
Every guidance file must be explicitly hashed; vendored rules must match those bytes.
Runs npm pack, locked staging npm ci, and a final npm pack. No build, publication or owner-state access.
The only distributable is NEW_DIR/tinycloud-telemetry-preview-0.1.0-alpha.0.tgz.
Publish that same verified tgz with --tag alpha; this command does not publish.`;
if (process.argv.includes("--help")) { console.log(usage); process.exit(0); }
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--source-sha", "--output", "--guidance", "--guidance-identity"].includes(key)
    || !process.argv[i + 1] || options[key]) throw new Error(usage);
  options[key] = process.argv[i + 1];
}
if (Object.keys(options).length !== 4 || !/^[a-f0-9]{40}$/.test(options["--source-sha"])) throw new Error(usage);
assertPlatform();
const root = resolve(process.cwd());
const output = resolve(options["--output"]);
const guidanceRoot = resolve(options["--guidance"]);
if (within(root, output) || within(guidanceRoot, output) || within(output, root) || within(output, guidanceRoot)) {
  throw new Error("Output must be separate from source and guidance inputs");
}
const exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "tinycloud-alpha-pack-"));
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: scratch,
  npm_config_cache: join(scratch, "cache"),
  npm_config_userconfig: join(scratch, "user.npmrc"),
  npm_config_globalconfig: join(scratch, "global.npmrc"),
  npm_config_update_notifier: "false",
};
const run = async (command, args, cwd = root) => (await exec(command, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
let candidate;
try {
  await Promise.all([env.npm_config_userconfig, env.npm_config_globalconfig].map((path) => writeFile(path, "")));
  const head = await run("git", ["rev-parse", "HEAD"]);
  if (head !== options["--source-sha"]) throw new Error("Checkout does not match --source-sha");
  await run("git", ["diff", "--exit-code", "HEAD", "--", ".", ":(exclude)**/dist/**"]);
  const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"]);
  if (untracked) throw new Error("Commit source inputs before packaging; checkout contains untracked files");
  const guidanceIdentityBytes = await readFile(resolve(options["--guidance-identity"]));
  const guidanceIdentity = JSON.parse(guidanceIdentityBytes);
  if (!/^[a-f0-9]{40}$/.test(guidanceIdentity.sourceCommit ?? "")) throw new Error("Guidance needs a pinned sourceCommit");
  const guidanceFiles = await inventory(guidanceRoot);
  if (!Object.keys(guidanceFiles).length || Object.keys(guidanceFiles).length !== Object.keys(guidanceIdentity.files ?? {}).length) {
    throw new Error("Guidance inventory does not match its finalized identity");
  }
  for (const [path, entry] of Object.entries(guidanceFiles)) {
    assertPackagePath(`package/guidance/${path}`);
    if (entry.target || !/\.(md|json|sh|mjs)$/.test(path) || path.split("/").some((part) => part.startsWith("."))
      || entry.sha256 !== guidanceIdentity.files[path]) throw new Error(`Unapproved guidance bytes: ${path}`);
  }
  const vendor = join(root, "packages/operations/src/tc-apps/vendor");
  const rules = await json(join(vendor, "version.json"));
  if (rules.version !== guidanceIdentity.rulesVersion) throw new Error("Vendored rule version differs from finalized guidance");
  const ruleHashes = {};
  for (const name of ["SKILL.md", "SQL.md"]) {
    const bytes = await readFile(join(vendor, name));
    const hash = sha256(bytes);
    const guidancePath = guidanceIdentity.rules?.[name];
    if (!guidancePath || hash !== guidanceFiles[guidancePath]?.sha256
      || hash !== rules.files?.[name]?.sha256 || bytes.length !== rules.files?.[name]?.size) {
      throw new Error(`Vendored ${name} does not match finalized guidance and version metadata`);
    }
    ruleHashes[name] = hash;
  }
  await mkdir(output, { mode: 0o700 });
  const staging = join(scratch, "package");
  await mkdir(staging, { mode: 0o700 });
  const internal = await packInternalPackages(root, join(staging, "packs"), run);
  const manifest = bundledManifest(internal, {
    ...alphaPackage,
    description: "Synthetic-only tc-apps diagnostics alpha CLI and MCP",
    license: "EGPL",
    type: "module",
    engines: { node: "22.23.2" }, os: ["linux"], cpu: ["x64"], libc: ["glibc"],
    publishConfig: { access: "public", tag: "alpha" },
    bin: { "tc-apps-alpha": "bin/tc-apps-alpha", "tc-apps-alpha-mcp": "bin/tc-apps-alpha-mcp" },
    files: ["bin", "lib", "guidance", "packs", "identity.json", "dependency-lock.json", "LICENSE.md"],
  });
  await writeJson(join(staging, "package.json"), manifest);
  const lock = await installLockedGraph(staging, internal, run);
  // Root-only override references cannot resolve when npm installs this package
  // beneath a consumer. The locked dependencies are already bundled in full.
  delete manifest.overrides;
  await writeJson(join(staging, "package.json"), manifest);
  // npm omits package-lock.json from published tarballs. Preserve exact lock bytes.
  await copyFile(join(staging, "package-lock.json"), join(staging, "dependency-lock.json"));
  await rm(join(staging, "node_modules/.package-lock.json"), { force: true });
  await cp(guidanceRoot, join(staging, "guidance"), { recursive: true, dereference: false });
  await copyFile(join(root, "LICENSE.md"), join(staging, "LICENSE.md"));
  await mkdir(join(staging, "lib"));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  for (const name of ["preview-launcher.mjs", "preview-files.mjs"]) await copyFile(join(scriptDirectory, name), join(staging, "lib", name));
  await mkdir(join(staging, "bin"));
  for (const [name, mode] of [["tc-apps-alpha", "cli"], ["tc-apps-alpha-mcp", "mcp"]]) {
    const path = join(staging, "bin", name);
    await writeFile(path, `#!/usr/bin/env node\nimport { launch } from '../lib/preview-launcher.mjs';\nawait launch('${mode}');\n`);
    await chmod(path, 0o755);
  }
  // Remove development-only local references and install hooks from the already
  // built bundled payload; runtime dependencies retain their original contracts.
  for (const path of Object.keys(await inventory(join(staging, "node_modules")))) {
    if (!path.endsWith("/package.json")) continue;
    const absolute = join(staging, "node_modules", path);
    const value = await json(absolute);
    delete value.devDependencies;
    delete value.scripts;
    for (const key of Object.keys(value)) if (key.startsWith("_")) delete value[key];
    assertPortableDependencies(value);
    await writeJson(absolute, value);
  }
  const files = await inventory(staging);
  for (const [path, entry] of Object.entries(files)) {
    assertPackagePath(`package/${path}`);
    if (entry.target || !/\.(?:json|js|cjs|mjs|map|md|sh)$/.test(path)) continue;
    const text = await readFile(join(staging, path), "utf8");
    if ([root, scratch, guidanceRoot].some((local) => text.includes(local))) throw new Error(`Machine-local path leaked into ${path}`);
    // PEM parsers contain armor delimiters; reject key payloads, not a delimiter alone.
    if (/\b(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{36,})\b|-----BEGIN (?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----(?:\s|\\+[rn])*[A-Za-z0-9+/]{32,}={0,2}/.test(text)) {
      throw new Error(`Credential material in ${path}`);
    }
  }
  const nativeAddons = Object.keys(files).filter((path) => path.endsWith(".node"));
  if (nativeAddons.length) throw new Error(`Unexpected native addons require explicit acceptance: ${nativeAddons.join(", ")}`);
  const identity = {
    schemaVersion: 1,
    ...alphaPackage,
    source: { repository: "https://github.com/TinyCloudLabs/js-sdk", commit: head, bunLockSha256: sha256(await readFile(join(root, "bun.lock"))) },
    target: { node: "22.23.2", platform: "linux", arch: "x64", libc: "glibc", buildGlibc: process.report.getReport().header.glibcVersionRuntime, npm: await run("npm", ["--version"]) },
    dependencyLock: { path: "dependency-lock.json", sha256: sha256(await readFile(join(staging, "dependency-lock.json"))), packageCount: Object.keys(lock.packages).length - 1 },
    packages: [...internal].map(([name, pack]) => ({ name, version: pack.manifest.version, tarball: `packs/${pack.filename}`, integrity: pack.integrity })),
    rules: { version: rules.version, files: ruleHashes, metadataSha256: sha256(await readFile(join(vendor, "version.json"))) },
    guidance: { sourceCommit: guidanceIdentity.sourceCommit, identitySha256: sha256(guidanceIdentityBytes), files: guidanceIdentity.files },
    scope: "Synthetic tc-apps only; installing does not enable diagnostics. Identity is not runtime or hosted acceptance.",
  };
  await writeJson(join(staging, "identity.json"), identity);
  const result = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], staging));
  if (result.length !== 1 || result[0].name !== alphaPackage.name || result[0].version !== alphaPackage.version
    || basename(result[0].filename) !== result[0].filename) throw new Error("Unexpected alpha npm artifact");
  candidate = join(output, result[0].filename);
  const listing = (await run("tar", ["-tzf", candidate])).split("\n");
  for (const path of listing) assertPackagePath(path);
  for (const spec of packedPackages) {
    for (const required of spec.required) {
      const path = `package/node_modules/${spec.name}/${required.slice("package/".length)}`;
      if (!listing.includes(path)) throw new Error(`Final npm package missing ${path}`);
    }
  }
  for (const required of ["identity.json", "dependency-lock.json", ...Object.values(manifest.bin)]) {
    if (!listing.includes(`package/${required}`)) throw new Error(`Final npm package missing ${required}`);
  }
  // Audit the actual npm artifact, including portable symlink targets.
  const extracted = join(scratch, "audit");
  await mkdir(extracted);
  await run("tar", ["-xzf", candidate, "-C", extracted]);
  await inventory(join(extracted, "package"));
  const artifact = { ...alphaPackage, tarball: candidate, sha256: sha256(await readFile(candidate)), integrity: result[0].integrity, identity };
  await writeJson(join(output, "artifact.json"), artifact);
  console.log(JSON.stringify(artifact, null, 2));
  candidate = undefined;
} finally {
  if (candidate) await rm(candidate, { force: true });
  await rm(scratch, { recursive: true, force: true });
}
