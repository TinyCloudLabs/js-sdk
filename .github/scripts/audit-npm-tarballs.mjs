#!/usr/bin/env node
// Audit what each public workspace package would put in its npm tarball,
// before anything is published (pre-release security check).
//
// For every package the Release workflow publishes (publicPackages(), the
// same selection publish-in-dependency-order.mjs uses), this runs
// `npm pack --dry-run --json --ignore-scripts` (no package has a pack or
// publish lifecycle script) and checks the file list:
//   - no .env files, keys, certificates, keystores or .npmrc;
//   - no test files, fixtures, test vectors or mocks;
//   - every file has an allowed extension; extensionless files only as
//     executables directly in bin/;
//   - sourcemaps only in packages that build them on purpose (SOURCEMAP_PACKAGES).
// It then copies the listed files to <staging-dir>, searches their contents
// for key and token shapes, and runs `gitleaks dir` over the copy. Any finding,
// a failed `npm pack`, an empty package or a missing gitleaks fails the run.
//
// usage: audit-npm-tarballs.mjs <staging-dir> [<package-dir>...]
//   <staging-dir>   new or empty directory for the copied tarball contents
//   <package-dir>   audit these package directories instead of the workspace's
//                   public packages (e.g. unpacked tarballs from npm)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicPackages } from "./check-npm-release-provenance.mjs";

// Packages whose build emits sourcemaps on purpose (tsup `sourcemap: true`,
// or tsc/rollup source maps). Their sources are this public repository.
// @tinycloud/web-sdk and @tinycloud/web-sdk-wasm deliberately ship none.
export const SOURCEMAP_PACKAGES = new Set([
  "@tinycloud/bootstrap",
  "@tinycloud/cli",
  "@tinycloud/courier",
  "@tinycloud/mcp",
  "@tinycloud/node-sdk",
  "@tinycloud/node-sdk-wasm",
  "@tinycloud/operations",
  "@tinycloud/replica",
  "@tinycloud/sdk-core",
  "@tinycloud/sdk-services",
  "@tinycloud/server",
  "@tinycloud/share-envelope",
  "@tinycloud/share-sdk",
  "@tinycloud/vfs",
]);

const ALLOWED_SUFFIXES = [".js", ".cjs", ".mjs", ".d.ts", ".d.cts", ".d.mts", ".json", ".md", ".wasm", ".LICENSE.txt"];
const DOC_FILE = /^(LICENSE|LICENCE|NOTICE|README|CHANGELOG)(\.(md|txt))?$/i;

const FORBIDDEN_NAMES = [
  [/^\.env(\..*)?$/i, "environment file"],
  [/^\.npmrc$/i, "npm config (may hold a token)"],
  [/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i, "key or certificate file"],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, "SSH key"],
  [/\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/i, "test file"],
];
const FORBIDDEN_DIRS = new Set([
  "test", "tests", "__tests__", "e2e", "fixtures", "__fixtures__", "test-fixtures",
  "test-vectors", "test-support", "__mocks__", "mocks",
]);

// Key and token shapes. Token patterns must stand alone, so a run inside a
// base64 blob (inlined wasm) does not match.
const EDGE = "(?<![A-Za-z0-9+/_-])";
const END = "(?![A-Za-z0-9+/_-])";
export const CONTENT_PATTERNS = [
  ["Stripe live secret key", new RegExp(`${EDGE}sk_live_[0-9A-Za-z]{8,}`, "g")],
  ["Stripe live restricted key", new RegExp(`${EDGE}rk_live_[0-9A-Za-z]{8,}`, "g")],
  // asn1.js builds generic "-----BEGIN " + label headers; only a private-key header is a finding.
  ["PEM private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["32-byte hex value (private key shape)", new RegExp(`${EDGE}0x[0-9a-fA-F]{64}${END}`, "g")],
  ["Slack token", new RegExp(`${EDGE}xox[bp]-[0-9A-Za-z-]{10,}`, "g")],
  ["JWT", new RegExp(`${EDGE}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, "g")],
  ["AWS access key id", new RegExp(`${EDGE}AKIA[0-9A-Z]{16}${END}`, "g")],
  ["GitHub token", new RegExp(`${EDGE}ghp_[0-9A-Za-z]{36}${END}`, "g")],
  ["GitHub fine-grained token", new RegExp(`${EDGE}github_pat_[0-9A-Za-z_]{22,}`, "g")],
  ["npm token", new RegExp(`${EDGE}npm_[0-9A-Za-z]{36}${END}`, "g")],
];

// Public 32-byte constants that bundled libraries carry (curve parameters,
// ethers constants): sha256 of the lowercased hex, one per line, with a
// comment naming the constant. A new 32-byte hex value fails the audit until
// someone checks it is public and adds it here.
const PUBLIC_HEX_FILE = new URL("./npm-tarball-public-hex.txt", import.meta.url);

export function loadPublicHex(text = readFileSync(PUBLIC_HEX_FILE, "utf8")) {
  const hashes = new Set();
  for (const line of text.split("\n")) {
    const hash = line.replace(/#.*/, "").trim();
    if (!hash) continue;
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`npm-tarball-public-hex.txt: not a sha256: ${line}`);
    hashes.add(hash);
  }
  return hashes;
}

export const hexDigest = (value) => createHash("sha256").update(value.toLowerCase()).digest("hex");

// Problems with one package's file list, as strings.
export function checkFileList({ name, files }) {
  const problems = [];
  if (files.length === 0) problems.push(`${name}: npm pack lists no files`);
  for (const path of files) {
    const file = posix.normalize(path);
    const base = posix.basename(file);
    const dirs = file.split("/").slice(0, -1);
    const forbidden = FORBIDDEN_NAMES.find(([pattern]) => pattern.test(base))?.[1];
    const testDir = dirs.find((dir) => FORBIDDEN_DIRS.has(dir.toLowerCase()));
    let problem;
    if (forbidden) problem = forbidden;
    else if (testDir) problem = `inside a ${testDir}/ directory`;
    else if (base.endsWith(".map")) problem = SOURCEMAP_PACKAGES.has(name) ? undefined : "sourcemap in a package that ships none";
    else if (!ALLOWED_SUFFIXES.some((suffix) => base.endsWith(suffix)) && !DOC_FILE.test(base) && !/^bin\/[^./]+$/.test(file)) {
      problem = "file type not on the tarball allowlist";
    }
    if (problem) problems.push(`${name}: ${file}: ${problem}`);
  }
  return problems;
}

// Content findings in one file, as strings. Never prints the value itself.
export function checkContent(label, text, publicHex) {
  const problems = [];
  for (const [what, pattern] of CONTENT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (what.startsWith("32-byte") && publicHex.has(hexDigest(match[0]))) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${label}:${line}: ${what} (sha256 of lowercased value ${hexDigest(match[0])})`);
    }
  }
  return problems;
}

function workspacePublicPackages(root) {
  // The working tree, not a commit: the Release jobs audit before the version commit exists.
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const tree = {
    files: () => listed.stdout.split("\n").filter(Boolean),
    show: (_rev, path) => { try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; } },
  };
  return publicPackages(tree, "WORKTREE").map((pkg) => join(root, pkg.dir));
}

function packedFiles(dir) {
  const npm = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (npm.error || npm.status !== 0) {
    throw new Error(`npm pack --dry-run failed in ${dir}: ${npm.error?.message ?? npm.stderr}`);
  }
  const [result] = JSON.parse(npm.stdout);
  return result.files.map((file) => file.path);
}

function stagingDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (readdirSync(path).length > 0) throw new Error(`staging directory is not empty: ${path}`);
  return resolve(path);
}

function main([staging, ...packageDirs]) {
  if (!staging) throw new Error("usage: audit-npm-tarballs.mjs <staging-dir> [<package-dir>...]");
  const out = stagingDirectory(staging);
  const dirs = packageDirs.length > 0 ? packageDirs.map((dir) => resolve(dir)) : workspacePublicPackages(process.cwd());
  if (dirs.length === 0) throw new Error("no public packages found");
  const publicHex = loadPublicHex();
  const problems = [];
  let fileCount = 0;

  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const files = packedFiles(dir);
    problems.push(...checkFileList({ name: manifest.name, files }));
    const target = join(out, manifest.name.replace(/[@/]/g, "_"));
    for (const path of files) {
      const source = join(dir, path);
      const copy = join(target, path);
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(source, copy);
      problems.push(...checkContent(`${manifest.name}/${path}`, readFileSync(source, "latin1"), publicHex));
      fileCount++;
    }
    console.log(`${manifest.name}: ${files.length} files`);
  }

  console.log(`gitleaks dir over ${fileCount} packed files in ${basename(out)}/`);
  const config = fileURLToPath(new URL("./gitleaks-npm-tarball.toml", import.meta.url));
  const gitleaks = spawnSync("gitleaks", ["dir", out, "--config", config, "--redact", "--exit-code", "1", "--no-banner"], { stdio: "inherit" });
  if (gitleaks.error) problems.push(`gitleaks could not run: ${gitleaks.error.message}`);
  else if (gitleaks.status !== 0) problems.push(`gitleaks dir found leaks in the packed files (exit ${gitleaks.status})`);

  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error title=npm tarball audit::${problem}`);
    console.log(`${problems.length} problem(s); nothing may be published until they are fixed.`);
    process.exit(1);
  }
  console.log(`npm tarball audit passed: ${dirs.length} packages, ${fileCount} files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.log(`::error title=npm tarball audit::${error.message}`);
    process.exit(1);
  }
}
