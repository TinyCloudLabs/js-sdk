// Builds `node-release.json` from an upstream node release. Used by
// `scripts/generate-node-release.ts` at CLI release time, never at runtime.
//
// Archive pins: the release's `sha256.sum` and the digest GitHub computed for
// each uploaded asset must agree. Both describe whatever is uploaded right now,
// so this is a consistency check that catches corruption and partial uploads,
// not an independent attestation. Anyone who can replace a release asset can
// replace both; immutable releases or signed artifacts are what close that.
//
// Binary pins: the caller downloads and unpacks each archive (checked against
// the archive pin) and supplies the hash of the `tinycloud` executable inside.
import {
  NODE_TARGETS,
  nodeArchiveUrl,
  parseNodeRelease,
  type NodeArchivePin,
  type NodeRelease,
  type NodeTarget,
} from "./node-release.js";

/** The parts of the GitHub "get release by tag" response the generator reads. */
export interface UpstreamRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; size: number; digest?: string | null }>;
}

/** Hash and size of an extracted executable. */
export interface BinaryPin {
  sha256: string;
  size: number;
}

/** Parse cargo-dist's `sha256.sum` (`<hex> *<file>` per line) into file → hash. */
export function parseSha256Sum(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (!match) throw new Error(`unparseable sha256.sum line: ${line}`);
    if (sums.has(match[2])) throw new Error(`sha256.sum lists ${match[2]} twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/** Archive pins for every target, from upstream data. Throws on any inconsistency. */
export function buildArchivePins(version: string, release: UpstreamRelease, sumText: string): NodeArchivePin[] {
  if (release.tag_name !== `v${version}`) throw new Error(`release tag ${release.tag_name} is not v${version}`);
  if (release.draft) throw new Error(`release v${version} is a draft`);
  if (release.prerelease) throw new Error(`release v${version} is a prerelease`);
  if (!Array.isArray(release.assets)) throw new Error(`release v${version} has no assets list`);

  const sums = parseSha256Sum(sumText);
  return NODE_TARGETS.map((target) => {
    const name = `tinycloud-node-${target}.tar.xz`;
    const sha256 = sums.get(name);
    if (!sha256) throw new Error(`sha256.sum has no entry for ${name}`);
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`release v${version} has no asset ${name}`);
    // Releases uploaded before GitHub computed digests carry none; for those
    // only sha256.sum vouches, so refuse rather than pin on a single source.
    if (asset.digest !== `sha256:${sha256}`) {
      throw new Error(`${name}: sha256.sum (${sha256}) disagrees with the GitHub asset digest (${asset.digest ?? "absent"})`);
    }
    return { target, url: nodeArchiveUrl(version, target), sha256, size: asset.size };
  });
}

/**
 * Combine upstream data into a validated pin. `measureBinary` downloads the
 * archive (verified against its pin), unpacks it, and returns the executable's
 * hash and size.
 */
export async function buildNodeRelease(
  version: string,
  release: UpstreamRelease,
  sumText: string,
  measureBinary: (archive: NodeArchivePin) => Promise<BinaryPin>,
): Promise<NodeRelease> {
  const archives = buildArchivePins(version, release, sumText);
  const binaries = await Promise.all(archives.map((archive) => measureBinary(archive)));
  const targets: Record<string, { url: string; sha256: string; size: number; binary: BinaryPin }> = {};
  archives.forEach(({ target, url, sha256, size }, index) => {
    targets[target] = { url, sha256, size, binary: binaries[index] };
  });
  return parseNodeRelease({ schemaVersion: 1, recommended: version, targets });
}

/** Canonical file contents. The checker compares bytes, so this is the only writer. */
export function serializeNodeRelease(release: NodeRelease): string {
  const targets: Partial<Record<NodeTarget, unknown>> = {};
  for (const target of NODE_TARGETS) {
    const { url, sha256, size, binary } = release.targets[target];
    targets[target] = { url, sha256, size, binary: { sha256: binary.sha256, size: binary.size } };
  }
  return `${JSON.stringify({ schemaVersion: 1, recommended: release.recommended, targets }, null, 2)}\n`;
}
