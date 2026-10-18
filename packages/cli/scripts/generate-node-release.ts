// Regenerates src/lib/node-release.json, the SHA-256 pins for the node tarballs
// (and for the executable inside each) the CLI installs, from an upstream
// tinycloud-node release. It downloads and unpacks every archive, so it needs
// `xz` at a fixed location (see XZ_LOCATIONS) and about 45 MB of bandwidth.
//
//   bun scripts/generate-node-release.ts                    # re-pin the current version
//   bun scripts/generate-node-release.ts --version 1.22.0   # pin a new version
//   bun scripts/generate-node-release.ts --check            # CI: fail if the file disagrees with upstream
//
// Optional GITHUB_TOKEN raises the API rate limit; it is sent only to api.github.com.
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { NODE_RELEASE_REPO, parseNodeRelease } from "../src/lib/node-release.js";
import { measureNodeBinary } from "../src/lib/node-fetch.js";
import { buildNodeRelease, serializeNodeRelease, type UpstreamRelease } from "../src/lib/node-release-pin.js";

const PIN_PATH = fileURLToPath(new URL("../src/lib/node-release.json", import.meta.url));
const ATTEMPTS = 3;

async function getText(url: string, accept: string): Promise<string> {
  const headers: Record<string, string> = { accept, "user-agent": "tinycloud-cli-node-release" };
  const token = process.env.GITHUB_TOKEN;
  if (token && new URL(url).hostname === "api.github.com") headers.authorization = `Bearer ${token}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep((attempt - 1) * 2_000);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.ok) return await response.text();
    lastError = new Error(`GET ${url} -> ${response.status}`);
    // Only server errors and rate limiting can change on retry.
    if (response.status < 500 && response.status !== 403 && response.status !== 429) break;
  }
  throw lastError;
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const versionFlag = args.indexOf("--version");
const requested = versionFlag === -1 ? undefined : args[versionFlag + 1];
if (args.some((arg, i) => arg !== "--check" && arg !== "--version" && i !== versionFlag + 1)) {
  console.error("usage: generate-node-release.ts [--version X.Y.Z] [--check]");
  process.exit(2);
}
if (versionFlag !== -1 && !requested) {
  console.error("--version needs a value");
  process.exit(2);
}
const current = await readFile(PIN_PATH, "utf8").catch(() => undefined);
const version = requested ?? (current ? parseNodeRelease(JSON.parse(current)).recommended : undefined);
if (!version) {
  console.error("no existing pin to read a version from; pass --version X.Y.Z");
  process.exit(2);
}

const base = `https://github.com/${NODE_RELEASE_REPO}/releases/download/v${version}`;
const release = JSON.parse(
  await getText(`https://api.github.com/repos/${NODE_RELEASE_REPO}/releases/tags/v${version}`, "application/vnd.github+json"),
) as UpstreamRelease;
const sumText = await getText(`${base}/sha256.sum`, "text/plain");
const expected = serializeNodeRelease(
  await buildNodeRelease(version, release, sumText, (archive) => measureNodeBinary({ artifact: archive })),
);

if (check) {
  if (current !== expected) {
    console.error(`src/lib/node-release.json does not match upstream tinycloud-node v${version}.`);
    console.error("Run `bun run --cwd packages/cli generate:node-release` and commit the result.");
    process.exit(1);
  }
  console.log(`node-release.json matches upstream tinycloud-node v${version}`);
} else {
  await writeFile(PIN_PATH, expected);
  console.log(`wrote src/lib/node-release.json for tinycloud-node v${version}`);
}
