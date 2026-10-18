// The TinyCloud node release this CLI installs, and where it goes.
//
// Trust root. The pins in `node-release.json` are embedded in the published
// CLI, so the npm package is what vouches for a node binary. Downloads are
// checked against these pins, never against a `.sha256` file fetched from the
// same release as the archive. `scripts/generate-node-release.ts` regenerates
// the file from the upstream release; `check:node-release` fails when the two
// disagree.
//
// The pinned release is v1.21.0. That binary has no `node` subcommand (the
// wiring ships with a later node release), so nothing in the CLI executes it
// yet. The pin has to move to a release that has `node` before any command
// runs the installed binary.
import { join } from "node:path";
import { tinycloudHomePath } from "@tinycloud/operations/state";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import pinned from "./node-release.json";

/** GitHub repository that publishes the cargo-dist node tarballs. */
export const NODE_RELEASE_REPO = "TinyCloudLabs/tinycloud-node";

/** cargo-dist targets published for the node. No Windows and no musl build exists. */
export const NODE_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
] as const;
export type NodeTarget = (typeof NODE_TARGETS)[number];

/** Largest archive the CLI will download. Real archives are 9-11 MB. */
export const NODE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Port the node's local service binds by default (`node service install`
 * writes `127.0.0.1:8081`). `tc node` commands use this one default.
 *
 * The SDK's `DEFAULT_LOCAL_NODE_URL` (sdk-core `location.ts`) is
 * `http://127.0.0.1:8000`, the Docker and `tinycloud.toml` port. That probe is
 * off unless a profile sets `localNodeUrl`, so a node on 8081 is discovered by
 * recording `NODE_SERVICE_LOCAL_URL` as the profile's `localNodeUrl`, not by
 * moving either default. 8000 stays with Docker/compose deployments (the
 * production compose publishes it publicly, TC-1387), so a personal node
 * installed on a host does not share a default port with them.
 */
export const NODE_SERVICE_DEFAULT_HOST = "127.0.0.1";
export const NODE_SERVICE_DEFAULT_PORT = 8081;
export const NODE_SERVICE_LOCAL_URL = `http://${NODE_SERVICE_DEFAULT_HOST}:${NODE_SERVICE_DEFAULT_PORT}`;

export interface NodeArtifact {
  target: NodeTarget;
  url: string;
  /** Lowercase hex SHA-256 of the archive. */
  sha256: string;
  /** Exact archive size in bytes. */
  size: number;
}

export interface NodeRelease {
  /** Node version the CLI installs by default. */
  recommended: string;
  targets: Record<NodeTarget, NodeArtifact>;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function nodeReleaseError(message: string): CLIError {
  return new CLIError("NODE_RELEASE_INVALID", message, ExitCode.ERROR);
}

/** Archive download URL for a release asset. The only URL shape the pin may use. */
export function nodeArchiveUrl(version: string, target: NodeTarget): string {
  return `https://github.com/${NODE_RELEASE_REPO}/releases/download/v${version}/tinycloud-node-${target}.tar.xz`;
}

/** Directory cargo-dist puts every archive member under. */
export function nodeArchiveRoot(target: NodeTarget): string {
  return `tinycloud-node-${target}`;
}

/** Archive member holding the `tinycloud` executable. */
export function nodeArchiveMember(target: NodeTarget): string {
  return `${nodeArchiveRoot(target)}/tinycloud`;
}

/** Loose shape of the untrusted pin document; every field is checked below before use. */
interface RawNodeRelease {
  schemaVersion?: unknown;
  recommended?: unknown;
  targets?: Record<string, { url?: unknown; sha256?: unknown; size?: unknown } | null | undefined> | null;
}

/** Validate an untrusted pin document. Throws on any deviation; never repairs. */
export function parseNodeRelease(raw: unknown): NodeRelease {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw nodeReleaseError("node-release.json must be an object");
  }
  const doc = raw as RawNodeRelease;
  if (doc.schemaVersion !== 1) throw nodeReleaseError("node-release.json schemaVersion must be 1");
  const { recommended, targets: rawTargets } = doc;
  if (typeof recommended !== "string" || !VERSION_RE.test(recommended)) {
    throw nodeReleaseError("node-release.json recommended must be a plain x.y.z version");
  }
  if (typeof rawTargets !== "object" || rawTargets === null || Array.isArray(rawTargets)) {
    throw nodeReleaseError("node-release.json targets must be an object");
  }
  const unknown = Object.keys(rawTargets).filter((key) => !(NODE_TARGETS as readonly string[]).includes(key));
  if (unknown.length > 0) throw nodeReleaseError(`node-release.json has unsupported targets: ${unknown.join(", ")}`);

  const targets = {} as Record<NodeTarget, NodeArtifact>;
  for (const target of NODE_TARGETS) {
    const entry = rawTargets[target];
    if (typeof entry !== "object" || entry === null) throw nodeReleaseError(`node-release.json is missing target ${target}`);
    const { url, sha256, size } = entry;
    if (url !== nodeArchiveUrl(recommended, target)) {
      throw nodeReleaseError(`node-release.json ${target} url must be ${nodeArchiveUrl(recommended, target)}`);
    }
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      throw nodeReleaseError(`node-release.json ${target} sha256 must be 64 lowercase hex characters`);
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > NODE_ARTIFACT_MAX_BYTES) {
      throw nodeReleaseError(`node-release.json ${target} size must be an integer between 1 and ${NODE_ARTIFACT_MAX_BYTES}`);
    }
    targets[target] = { target, url, sha256, size };
  }
  return { recommended, targets };
}

let cached: NodeRelease | undefined;

/** The pin embedded in this CLI build. */
export function loadNodeRelease(): NodeRelease {
  cached ??= parseNodeRelease(pinned);
  return cached;
}

/** cargo-dist target for a platform, or `null` where no node build exists (Windows, other architectures). */
export function resolveNodeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NodeTarget | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  return null;
}

export interface NodeInstallPaths {
  /** `~/.tinycloud/node` (honours `TC_HOME`). */
  root: string;
  binDir: string;
  /** Stable executable path. The node's service unit records its own executable path, so this must not move. */
  binary: string;
}

export function nodeInstallPaths(): NodeInstallPaths {
  const root = join(tinycloudHomePath(), "node");
  const binDir = join(root, "bin");
  return { root, binDir, binary: join(binDir, "tinycloud") };
}
