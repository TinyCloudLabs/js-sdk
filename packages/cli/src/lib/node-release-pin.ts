// Builds `node-release.json` from an upstream node release. Used by
// `scripts/generate-node-release.ts` at CLI release time, never at runtime.
//
// Two upstream sources must agree before a pin is produced: the release's
// `sha256.sum` and the digest GitHub computed for each uploaded asset. A
// release whose two sources disagree, or that lacks a target, is refused.
import { NODE_TARGETS, nodeArchiveUrl, parseNodeRelease, type NodeRelease } from "./node-release.js";

/** The parts of the GitHub "get release by tag" response the generator reads. */
export interface UpstreamRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; size: number; digest?: string | null }>;
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

/** Combine upstream data into a validated pin. Throws on any inconsistency. */
export function buildNodeRelease(version: string, release: UpstreamRelease, sumText: string): NodeRelease {
  if (release.tag_name !== `v${version}`) throw new Error(`release tag ${release.tag_name} is not v${version}`);
  if (release.draft) throw new Error(`release v${version} is a draft`);
  if (release.prerelease) throw new Error(`release v${version} is a prerelease`);
  if (!Array.isArray(release.assets)) throw new Error(`release v${version} has no assets list`);

  const sums = parseSha256Sum(sumText);
  const targets = {} as Record<string, { url: string; sha256: string; size: number }>;
  for (const target of NODE_TARGETS) {
    const name = `tinycloud-node-${target}.tar.xz`;
    const sha256 = sums.get(name);
    if (!sha256) throw new Error(`sha256.sum has no entry for ${name}`);
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`release v${version} has no asset ${name}`);
    // GitHub's own digest is the second source. Releases uploaded before it
    // existed carry none; for those only sha256.sum vouches, so refuse rather
    // than pin on a single source.
    if (asset.digest !== `sha256:${sha256}`) {
      throw new Error(`${name}: sha256.sum (${sha256}) disagrees with the GitHub asset digest (${asset.digest ?? "absent"})`);
    }
    targets[target] = { url: nodeArchiveUrl(version, target), sha256, size: asset.size };
  }
  return parseNodeRelease({ schemaVersion: 1, recommended: version, targets });
}

/** Canonical file contents. The checker compares bytes, so this is the only writer. */
export function serializeNodeRelease(release: NodeRelease): string {
  const targets: Record<string, { url: string; sha256: string; size: number }> = {};
  for (const target of NODE_TARGETS) {
    const { url, sha256, size } = release.targets[target];
    targets[target] = { url, sha256, size };
  }
  return `${JSON.stringify({ schemaVersion: 1, recommended: release.recommended, targets }, null, 2)}\n`;
}
