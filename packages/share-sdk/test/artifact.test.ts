import { describe, expect, it } from "bun:test";
import {
  ArtifactError,
  artifactVersionResource,
  listArtifactVersions,
  manifestBytes,
  parseArtifactManifest,
  parseArtifactVersionPath,
  publishArtifactVersion,
  sha256Hex,
  type ArtifactStore,
} from "../src/index.js";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

/** In-memory store with the node's `If-None-Match: *` semantics and real interleaving between awaits. */
function memoryStore(options: { staleList?: boolean } = {}) {
  const data = new Map<string, Uint8Array>();
  const log: string[] = [];
  const store: ArtifactStore = {
    async put(key, bytes) {
      await Promise.resolve();
      if (data.has(key)) { log.push(`412 ${key}`); return "exists"; }
      data.set(key, bytes.slice());
      log.push(`put ${key}`);
      return "created";
    },
    async get(key) { await Promise.resolve(); return data.get(key)?.slice(); },
    async list(prefix) {
      await Promise.resolve();
      return options.staleList ? [] : [...data.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return { store, data, log };
}

describe("artifact versions", () => {
  it("writes files first and manifest.json last, under the slashless version resource", async () => {
    const { store, data, log } = memoryStore();
    const result = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "report.md", bytes: enc("v1") }], note: "first", now: () => Date.parse("2026-10-18T00:00:00Z") });
    expect(result).toMatchObject({ version: 1, created: true });
    expect(result.manifest).toEqual({ v: 1, files: [{ path: "report.md", sha256: sha256Hex(enc("v1")), bytes: 2 }], createdAt: "2026-10-18T00:00:00.000Z", parent: null, note: "first" });
    expect(log).toEqual(["put artifacts/art_one/versions/1/report.md", "put artifacts/art_one/versions/1/manifest.json"]);
    expect(artifactVersionResource("art_one", 1)).toBe("artifacts/art_one/versions/1");
    expect(result.manifestSha256).toBe(sha256Hex(data.get("artifacts/art_one/versions/1/manifest.json")!));
  });

  it("re-running identical content returns the existing version and writes nothing", async () => {
    const { store, log } = memoryStore();
    const first = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("same") }] });
    const writes = log.length;
    const again = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("same") }] });
    expect(again).toMatchObject({ version: 1, created: false, manifestSha256: first.manifestSha256 });
    expect(log.length).toBe(writes);
  });

  it("new content is a new version with a parent; earlier bytes are untouched", async () => {
    const { store, data } = memoryStore();
    await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("one") }] });
    const two = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("two") }] });
    expect(two).toMatchObject({ version: 2, created: true });
    expect(two.manifest.parent).toBe(1);
    expect(dec(data.get("artifacts/art_one/versions/1/a.md")!)).toBe("one");
    expect((await listArtifactVersions(store, "art_one")).map((v) => [v.version, v.complete])).toEqual([[1, true], [2, true]]);
  });

  it("never records a plaintext digest, and compares stored bytes only", async () => {
    const { store, data } = memoryStore();
    const plaintext = "guessable plaintext";
    // Stand-in ciphertext: two encryptions of one plaintext differ, so two publishes are two versions.
    const first = await publishArtifactVersion(store, { artifactId: "art_enc", files: [{ filename: "a.md", bytes: enc("cipher-1") }] });
    const second = await publishArtifactVersion(store, { artifactId: "art_enc", files: [{ filename: "a.md", bytes: enc("cipher-2") }] });
    expect([first.version, second.version]).toEqual([1, 2]);
    const stored = [...data.entries()].filter(([key]) => key.endsWith("manifest.json")).map(([, bytes]) => dec(bytes)).join("");
    expect(stored).not.toContain(sha256Hex(enc(plaintext)));
    expect(stored).not.toContain("contentSha256");
    expect(Object.keys(first.manifest.files[0]!).sort()).toEqual(["bytes", "path", "sha256"]);
  });

  it("one corrupt manifest is reported and skipped; listing and publishing carry on", async () => {
    const { store, data } = memoryStore();
    await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("one") }] });
    await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("two") }] });
    data.set("artifacts/art_one/versions/1/manifest.json", enc("{not json"));
    const listed = await listArtifactVersions(store, "art_one");
    expect(listed.map((entry) => [entry.version, entry.complete, entry.corrupt === true])).toEqual([[1, false, true], [2, true, false]]);
    const next = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("three") }] });
    expect(next.version).toBe(3);
    expect(next.manifest.parent).toBe(2);
  });

  it("a 412 on a file is success only when the stored sha256 equals ours", async () => {
    // Stale list: the publisher believes n=1 is free while another publisher already wrote there.
    const equal = memoryStore({ staleList: true });
    equal.data.set("artifacts/art_one/versions/1/a.md", enc("mine"));
    const ok = await publishArtifactVersion(equal.store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("mine") }] });
    expect(ok).toMatchObject({ version: 1, created: true });

    const differ = memoryStore({ staleList: true });
    differ.data.set("artifacts/art_one/versions/1/a.md", enc("theirs"));
    await expect(publishArtifactVersion(differ.store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("mine") }] })).rejects.toMatchObject({ code: "conflict" });
    expect(dec(differ.data.get("artifacts/art_one/versions/1/a.md")!)).toBe("theirs");

    // With a fresh listing the lost number is skipped and the next one is used.
    const fresh = memoryStore();
    fresh.data.set("artifacts/art_one/versions/1/a.md", enc("theirs"));
    const next = await publishArtifactVersion(fresh.store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("mine") }] });
    expect(next.version).toBe(2);
  });

  it("concurrent publishers of different content get distinct versions", async () => {
    const { store } = memoryStore();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => publishArtifactVersion(store, { artifactId: "art_race", files: [{ filename: "a.md", bytes: enc(`draft ${index}`) }] })));
    expect(new Set(results.map((result) => result.version)).size).toBe(6);
    const versions = await listArtifactVersions(store, "art_race");
    expect(versions.filter((version) => version.complete).length).toBe(6);
  });

  it("concurrent publishers of identical content converge on one version", async () => {
    const { store } = memoryStore();
    const results = await Promise.all(Array.from({ length: 5 }, () => publishArtifactVersion(store, { artifactId: "art_same", files: [{ filename: "a.md", bytes: enc("identical") }] })));
    expect(new Set(results.map((result) => result.version))).toEqual(new Set([1]));
    expect(results.filter((result) => result.created).length).toBe(1);
  });

  it("an incomplete version (no manifest) is never reused or reported complete", async () => {
    const { store, data } = memoryStore();
    data.set("artifacts/art_one/versions/1/a.md", enc("crashed mid-publish"));
    expect(await listArtifactVersions(store, "art_one")).toEqual([{ version: 1, complete: false }]);
    const result = await publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("retry") }] });
    expect(result.version).toBe(2);
    expect(result.manifest.parent).toBeNull();
  });

  it("refuses unsafe ids, reserved and duplicate names, and empty versions", async () => {
    const { store } = memoryStore();
    const base = { files: [{ filename: "a.md", bytes: enc("x") }] };
    for (const artifactId of ["", "ab", "Art_One", "a/b", "../x", "art one"]) {
      await expect(publishArtifactVersion(store, { ...base, artifactId })).rejects.toBeInstanceOf(ArtifactError);
    }
    await expect(publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "manifest.json", bytes: enc("x") }] })).rejects.toThrow("reserved");
    await expect(publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a.md", bytes: enc("x") }, { filename: "a.md", bytes: enc("y") }] })).rejects.toThrow("unique");
    await expect(publishArtifactVersion(store, { artifactId: "art_one", files: [] })).rejects.toThrow("at least one");
    await expect(publishArtifactVersion(store, { artifactId: "art_one", files: [{ filename: "a/b.md", bytes: enc("x") }] })).rejects.toThrow("safe path segment");
  });
});

describe("artifact manifest parsing", () => {
  const valid = { v: 1, files: [{ path: "a.md", sha256: "a".repeat(64), bytes: 1 }], createdAt: "2026-10-18T00:00:00.000Z", parent: null };

  it("round-trips the canonical (key-sorted) bytes it writes", () => {
    const parsed = parseArtifactManifest(enc(JSON.stringify(valid)));
    const canonical = `{"createdAt":"2026-10-18T00:00:00.000Z","files":[{"bytes":1,"path":"a.md","sha256":"${"a".repeat(64)}"}],"parent":null,"v":1}`;
    expect(dec(manifestBytes(parsed))).toBe(canonical);
    expect(dec(manifestBytes(parseArtifactManifest(enc(canonical))))).toBe(canonical);
  });

  it("rejects unknown fields, duplicate paths, bad digests and truncation", () => {
    const bad: unknown[] = [
      { ...valid, extra: 1 },
      // No plaintext digest may ride in the manifest (it sits next to ciphertext in the owner's space).
      { ...valid, files: [{ ...valid.files[0], contentSha256: "b".repeat(64) }] },
      { ...valid, v: 2 },
      { ...valid, files: [] },
      { ...valid, files: [valid.files[0], valid.files[0]] },
      { ...valid, files: [{ ...valid.files[0], sha256: "A".repeat(64) }] },
      { ...valid, files: [{ ...valid.files[0], path: "manifest.json" }] },
      { ...valid, files: [{ ...valid.files[0], path: "../a.md" }] },
      { ...valid, parent: 0 },
    ];
    for (const value of bad) expect(() => parseArtifactManifest(enc(JSON.stringify(value)))).toThrow(ArtifactError);
    const whole = JSON.stringify(valid);
    expect(() => parseArtifactManifest(enc(whole.slice(0, whole.length - 5)))).toThrow(ArtifactError);
  });

  it("maps a stored KV path back to its artifact version", () => {
    expect(parseArtifactVersionPath("artifacts/art_one/versions/12/a.md")).toEqual({ artifactId: "art_one", version: 12, file: "a.md" });
    for (const path of ["artifacts/art_one/current/a.md", "artifacts/art_one/versions/0/a.md", "artifacts/art_one/versions/1", "shares/x/a.md", "artifacts/art_one/versions/1/a/b"]) {
      expect(parseArtifactVersionPath(path)).toBeUndefined();
    }
  });
});
