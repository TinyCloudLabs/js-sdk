import { describe, expect, test } from "bun:test";
import { CLIError } from "../output/errors.js";
import {
  NODE_TARGETS,
  loadNodeRelease,
  nodeArchiveUrl,
  parseNodeRelease,
  resolveNodeTarget,
} from "./node-release.js";
import { buildNodeRelease, parseSha256Sum, serializeNodeRelease, type UpstreamRelease } from "./node-release-pin.js";
import type { NodeArchivePin } from "./node-release.js";

const hash = (char: string) => char.repeat(64);

function pinDocument() {
  const targets: Record<string, { url: string; sha256: string; size: number; binary: { sha256: string; size: number } }> = {};
  for (const target of NODE_TARGETS) {
    targets[target] = { url: nodeArchiveUrl("1.21.0", target), sha256: hash("a"), size: 1000, binary: { sha256: hash("e"), size: 5000 } };
  }
  return { schemaVersion: 1, recommended: "1.21.0", targets };
}

describe("committed pin", () => {
  test("loads, and every target points at the pinned version's GitHub release asset", () => {
    const release = loadNodeRelease();
    expect(Object.keys(release.targets).sort()).toEqual([...NODE_TARGETS].sort());
    for (const target of NODE_TARGETS) {
      expect(release.targets[target].url).toBe(nodeArchiveUrl(release.recommended, target));
    }
  });
});

describe("parseNodeRelease", () => {
  const rejects = (mutate: (doc: ReturnType<typeof pinDocument>) => void, messageHas: string) => {
    const doc = pinDocument();
    mutate(doc);
    expect(() => parseNodeRelease(doc)).toThrow(CLIError);
    expect(() => parseNodeRelease(doc)).toThrow(messageHas);
  };

  test("accepts a complete document", () => {
    expect(parseNodeRelease(pinDocument()).recommended).toBe("1.21.0");
  });

  test("rejects a url that is not the release asset for that version and target", () => {
    rejects((doc) => {
      doc.targets["x86_64-apple-darwin"].url = "https://evil.example/tinycloud-node-x86_64-apple-darwin.tar.xz";
    }, "x86_64-apple-darwin url");
    rejects((doc) => {
      doc.targets["x86_64-apple-darwin"].url = nodeArchiveUrl("1.20.7", "x86_64-apple-darwin");
    }, "x86_64-apple-darwin url");
  });

  test("rejects malformed hashes", () => {
    for (const bad of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      rejects((doc) => {
        doc.targets["x86_64-unknown-linux-gnu"].sha256 = bad;
      }, "sha256");
    }
  });

  test("rejects sizes outside 1..cap", () => {
    for (const bad of [0, -1, 1.5, 65 * 1024 * 1024]) {
      rejects((doc) => {
        doc.targets["x86_64-unknown-linux-gnu"].size = bad;
      }, "size");
    }
  });

  test("rejects a missing or malformed executable pin", () => {
    rejects((doc) => {
      delete (doc.targets["x86_64-unknown-linux-gnu"] as { binary?: unknown }).binary;
    }, "no binary pin");
    for (const bad of ["", "E".repeat(64), "e".repeat(63)]) {
      rejects((doc) => {
        doc.targets["x86_64-unknown-linux-gnu"].binary.sha256 = bad;
      }, "binary sha256");
    }
    for (const bad of [0, -1, 1.5, 257 * 1024 * 1024]) {
      rejects((doc) => {
        doc.targets["x86_64-unknown-linux-gnu"].binary.size = bad;
      }, "binary size");
    }
  });

  test("rejects a missing or extra target and a bad version", () => {
    rejects((doc) => {
      delete (doc.targets as Record<string, unknown>)["aarch64-apple-darwin"];
    }, "missing target aarch64-apple-darwin");
    rejects((doc) => {
      (doc.targets as Record<string, unknown>)["x86_64-pc-windows-msvc"] = doc.targets["aarch64-apple-darwin"];
    }, "unsupported targets");
    rejects((doc) => {
      doc.recommended = "latest";
    }, "recommended");
  });

  test("rejects non-object input", () => {
    for (const bad of [null, "x", [], 3]) expect(() => parseNodeRelease(bad)).toThrow(CLIError);
  });
});

describe("resolveNodeTarget", () => {
  test("maps the four supported platforms and nothing else", () => {
    expect(resolveNodeTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolveNodeTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(resolveNodeTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(resolveNodeTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(resolveNodeTarget("win32", "x64")).toBeNull();
    expect(resolveNodeTarget("linux", "ia32")).toBeNull();
    expect(resolveNodeTarget("freebsd", "x64")).toBeNull();
  });
});

describe("pin generation", () => {
  const sums = (overrides: Record<string, string> = {}) =>
    NODE_TARGETS.map((target) => `${overrides[target] ?? hash("b")} *tinycloud-node-${target}.tar.xz`).join("\n") +
    `\n${hash("c")} *source.tar.gz\n`;
  const upstream = (digests: Record<string, string> = {}): UpstreamRelease => ({
    tag_name: "v1.21.0",
    draft: false,
    prerelease: false,
    assets: NODE_TARGETS.map((target) => ({
      name: `tinycloud-node-${target}.tar.xz`,
      size: 4242,
      digest: `sha256:${digests[target] ?? hash("b")}`,
    })),
  });

  const measured = async (archive: NodeArchivePin) => ({ sha256: hash("e"), size: archive.size * 3 });

  test("builds a pin from agreeing sources and round-trips through the canonical serialization", async () => {
    const pin = await buildNodeRelease("1.21.0", upstream(), sums(), measured);
    expect(pin.targets["aarch64-apple-darwin"]).toEqual({
      target: "aarch64-apple-darwin",
      url: nodeArchiveUrl("1.21.0", "aarch64-apple-darwin"),
      sha256: hash("b"),
      size: 4242,
      binary: { sha256: hash("e"), size: 4242 * 3 },
    });
    expect(parseNodeRelease(JSON.parse(serializeNodeRelease(pin)))).toEqual(pin);
  });

  test("measures each archive only after its pin is built from agreeing sources", async () => {
    const seen: string[] = [];
    await buildNodeRelease("1.21.0", upstream(), sums(), async (archive) => {
      seen.push(`${archive.target}:${archive.sha256}`);
      return measured(archive);
    });
    expect(seen.sort()).toEqual(NODE_TARGETS.map((target) => `${target}:${hash("b")}`).sort());

    let called = false;
    await expect(
      buildNodeRelease("1.21.0", upstream({ "x86_64-apple-darwin": hash("d") }), sums(), async (archive) => {
        called = true;
        return measured(archive);
      }),
    ).rejects.toThrow("disagrees");
    expect(called).toBe(false);
  });

  test("refuses an asset with no GitHub digest rather than pinning on one source", async () => {
    const release = upstream();
    release.assets[0].digest = null;
    await expect(buildNodeRelease("1.21.0", release, sums(), measured)).rejects.toThrow("absent");
  });

  test("refuses a missing target, drafts, prereleases and a tag mismatch", async () => {
    const lines = sums().split("\n").filter((line) => !line.includes("aarch64-apple-darwin")).join("\n");
    await expect(buildNodeRelease("1.21.0", upstream(), lines, measured)).rejects.toThrow("no entry");
    await expect(buildNodeRelease("1.21.0", { ...upstream(), draft: true }, sums(), measured)).rejects.toThrow("draft");
    await expect(buildNodeRelease("1.21.0", { ...upstream(), prerelease: true }, sums(), measured)).rejects.toThrow("prerelease");
    await expect(buildNodeRelease("1.21.1", upstream(), sums(), measured)).rejects.toThrow("not v1.21.1");
  });

  test("parseSha256Sum rejects garbage and duplicates", () => {
    expect(() => parseSha256Sum("not a checksum line")).toThrow("unparseable");
    expect(() => parseSha256Sum(`${hash("a")} *x\n${hash("b")} *x\n`)).toThrow("twice");
  });
});
