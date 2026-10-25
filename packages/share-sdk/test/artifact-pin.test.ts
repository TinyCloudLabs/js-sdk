import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { artifactPinSchema, signEnvelopeV3, type ArtifactPin, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { foreignSeed, didFor, enc, linkFor, nodeDid, ownerDid, ownerSeed, signedBinding, signedRoot } from "./support/signed-share.js";
import {
  ArtifactPinError,
  ShareRecipientClient,
  addressedCredentialRequirement,
  artifactBindingView,
  assertArtifactBinding,
  inspectShare,
  publishAddressedShare,
  verifyArtifactShare,
} from "../src/index.js";
import {
  assertArtifactId,
  buildArtifactPin,
  manifestBytes,
  publishArtifactVersion,
  sha256Hex,
  verifyArtifactFileBytes,
  verifyArtifactManifestBytes,
  type ArtifactStore,
  type ArtifactVersionResult,
} from "../src/artifact.js";

function memoryStore(): ArtifactStore {
  const data = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) { if (data.has(key)) return "exists"; data.set(key, bytes.slice()); return "created"; },
    async get(key) { return data.get(key)?.slice(); },
    async list(prefix) { return [...data.keys()].filter((key) => key.startsWith(prefix)); },
  };
}

interface Pinned {
  readonly envelope: ShareEnvelopeV3;
  readonly version: ArtifactVersionResult;
  readonly stored: Uint8Array;
  readonly link: string;
}

/** A real owner-signed Policy/v3 envelope for one stored (stand-in ciphertext) file of one artifact version. */
async function publishPinned(options: { readonly store?: ArtifactStore; readonly artifactId?: string; readonly ciphertext?: string; readonly sourcePrefix?: string; readonly omitPin?: boolean } = {}): Promise<Pinned> {
  const store = options.store ?? memoryStore();
  const artifactId = options.artifactId ?? "art_pin";
  const stored = enc(options.ciphertext ?? JSON.stringify({ v: 1, ciphertext: "AQ" }));
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000);
  const version = await publishArtifactVersion(store, { artifactId, files: [{ filename: "note.md", bytes: stored }] });
  const path = `artifacts/${artifactId}/versions/${version.version}/note.md`;
  let delivered: { readonly envelope: Readonly<Record<string, unknown>> } | undefined;
  const published = await publishAddressedShare({
    shareId: "pinnedshare0000001",
    shareOrigin: "https://share.tinycloud.xyz",
    nodeOrigin: "https://node.example",
    nodeAudience: nodeDid,
    enforcerDid: nodeDid,
    spaceId: "tinycloud:test-space",
    target: { kind: "email", address: "alice@example.com" },
    resource: { kind: "exact", path },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: "pinnedshare0000001",
      kvResource: `tinycloud:test-space/kv/${path}`,
      selector: "exact",
      encryptionNetwork: `urn:tinycloud:encryption:${ownerDid}:default`,
      encryptedSymmetricKeyDigestHex: "1".repeat(64),
      keyVersion: 1,
      mode: "immutable",
      initialCiphertextDigestHex: sha256Hex(stored),
    },
    ...(options.omitPin === true ? {} : { artifactPin: buildArtifactPin(version, "note.md") }),
    credentialRequirement: addressedCredentialRequirement({ kind: "email", address: "alice@example.com" }),
    filename: "note.md",
    mediaType: "text/markdown",
    byteLength: stored.byteLength,
    expiresAt,
    onDeliveryMaterial: (material) => { delivered = material; },
    authority: {
      ownerDid,
      createOwnerRoot: async (input) => signedRoot(input),
      async sign(bytes) { return ed25519.sign(bytes, ownerSeed); },
      async registerPolicy(input) {
        return {
          policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid,
          attestedEnforcerBinding: signedBinding(expiresAt),
        };
      },
    },
  });
  return { envelope: delivered!.envelope as unknown as ShareEnvelopeV3, version, stored, link: published.url };
}

/** Re-sign `envelope` after `change`, as the holder of `seed`. The signature is valid; only the content differs. */
function resign(envelope: ShareEnvelopeV3, change: (unsigned: Record<string, unknown>) => void, seed: Uint8Array = ownerSeed): ShareEnvelopeV3 {
  const { signature: _signature, ...rest } = structuredClone(envelope) as unknown as Record<string, unknown> & { signature: unknown };
  change(rest);
  return signEnvelopeV3(rest as never, seed);
}

async function code(run: () => unknown): Promise<string> {
  try { await run(); } catch (error) { return error instanceof ArtifactPinError ? error.code : `unexpected: ${String(error)}`; }
  return "no error";
}

describe("artifact pin: a pinned envelope", () => {
  it("carries the owner-signed pin and verifies against the owner and the fetched bytes", async () => {
    const { envelope, version, stored } = await publishPinned();
    const pin = await verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_pin", version: 1 } });
    expect(pin).toEqual({ v: 1, artifactId: "art_pin", version: 1, manifestSha256: version.manifestSha256, files: [{ path: "note.md", sha256: sha256Hex(stored), bytes: stored.byteLength }] });
    // The pin names the digest of the stored ciphertext and the version's manifest, and no plaintext digest.
    expect(JSON.stringify(pin)).not.toContain(sha256Hex(enc("plaintext")));
    expect(() => verifyArtifactFileBytes(pin!, stored)).not.toThrow();
  });

  it("is accepted by the schema only in its exact shape", () => {
    const good: ArtifactPin = { v: 1, artifactId: "art_pin", version: 1, manifestSha256: "a".repeat(64), files: [{ path: "note.md", sha256: "b".repeat(64), bytes: 3 }] };
    expect(artifactPinSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, version: 0 },
      { ...good, artifactId: "Art Pin" },
      { ...good, manifestSha256: "A".repeat(64) },
      { ...good, files: [] },
      { ...good, files: [good.files[0], good.files[0]] },
      { ...good, files: [{ ...good.files[0], sha256: "zz" }] },
    ]) expect(artifactPinSchema.safeParse(bad).success).toBe(false);
  });
});

describe("artifact pin: negative cases", () => {
  it("tampered file: a flipped byte, a truncated file and an empty body are all refused", async () => {
    const { envelope, stored } = await publishPinned();
    const pin = (await verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid }))!;
    const flipped = stored.slice();
    flipped[3] = flipped[3]! ^ 0x01;
    for (const bytes of [flipped, stored.slice(0, stored.byteLength - 1), new Uint8Array(), new Uint8Array([...stored, 0])]) {
      expect(() => verifyArtifactFileBytes(pin, bytes)).toThrow(ArtifactPinError);
      try { verifyArtifactFileBytes(pin, bytes); } catch (error) { expect((error as ArtifactPinError).code).toBe("file-digest-mismatch"); }
    }
  });

  it("wrong key: another signer, a forged signer claim, and a tampered pin all fail", async () => {
    const { envelope } = await publishPinned();
    // Signed in full by an attacker: the signer is not the owner we trust.
    const byForeignKey = resign(envelope, () => {}, foreignSeed);
    expect(await code(() => verifyArtifactShare(byForeignKey, { expectedOwnerDid: ownerDid }))).toBe("wrong-signer");
    // Claims the owner as signer but carries the attacker's signature bytes.
    const forged = { ...byForeignKey, signature: { ...byForeignKey.signature, signerDid: ownerDid } } as ShareEnvelopeV3;
    expect(await code(() => verifyArtifactShare(forged, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
    // The pin is edited after signing: the owner's signature no longer covers the bytes.
    const edited = structuredClone(envelope) as ShareEnvelopeV3;
    (edited.artifactPin as { version: number }).version = 2;
    expect(await code(() => verifyArtifactShare(edited, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
    const stripped = structuredClone(envelope) as unknown as Record<string, unknown>;
    delete stripped.artifactPin;
    expect(await code(() => verifyArtifactShare(stripped as unknown as ShareEnvelopeV3, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
  });

  it("replayed older manifest: version 1's manifest does not satisfy version 2's pin", async () => {
    const store = memoryStore();
    const first = await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "one" }) });
    const second = await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "two" }) });
    expect([first.version.version, second.version.version]).toEqual([1, 2]);
    const pin2 = (await verifyArtifactShare(second.envelope, { expectedOwnerDid: ownerDid }))!;
    const manifestV1 = manifestBytes(first.version.manifest);
    const manifestV2 = manifestBytes(second.version.manifest);
    expect(() => verifyArtifactManifestBytes(pin2, manifestV2)).not.toThrow();
    expect(() => verifyArtifactManifestBytes(pin2, manifestV1)).toThrow(ArtifactPinError);
    // The older version's bytes are not the newer pin's bytes either.
    expect(() => verifyArtifactFileBytes(pin2, first.stored)).toThrow(ArtifactPinError);
  });

  it("replayed older pin: an envelope for version 1 is refused where version 2 is expected", async () => {
    const store = memoryStore();
    const first = await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "one" }) });
    await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "two" }) });
    expect(await code(() => verifyArtifactShare(first.envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_pin", version: 2 } }))).toBe("expectation-mismatch");
    expect(await code(() => verifyArtifactShare(first.envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_other" } }))).toBe("expectation-mismatch");
  });

  it("truncated manifest: every prefix of the manifest bytes is refused", async () => {
    const { envelope, version } = await publishPinned();
    const pin = (await verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid }))!;
    const bytes = manifestBytes(version.manifest);
    expect(bytes.byteLength).toBeGreaterThan(40);
    for (const length of [0, 1, 10, Math.floor(bytes.byteLength / 2), bytes.byteLength - 1]) {
      expect(() => verifyArtifactManifestBytes(pin, bytes.slice(0, length))).toThrow(ArtifactPinError);
    }
    // A manifest that hashes right but is malformed is still refused: forge a pin over junk bytes.
    const junk = enc("{\"v\":1}");
    const junkPin: ArtifactPin = { ...pin, manifestSha256: sha256Hex(junk) };
    expect(() => verifyArtifactManifestBytes(junkPin, junk)).toThrow(ArtifactPinError);
    // A well-formed manifest that does not list the pinned file is refused.
    const other = await publishArtifactVersion(memoryStore(), { artifactId: "art_pin", files: [{ filename: "note.md", bytes: enc("different") }] });
    const otherBytes = manifestBytes(other.manifest);
    expect(() => verifyArtifactManifestBytes({ ...pin, manifestSha256: sha256Hex(otherBytes) }, otherBytes)).toThrow(ArtifactPinError);
  });

  it("pin for a different version or artifact than the source it sits on is refused", async () => {
    const { envelope } = await publishPinned();
    const otherVersion = resign(envelope, (unsigned) => { (unsigned.artifactPin as { version: number }).version = 2; });
    expect(await code(() => verifyArtifactShare(otherVersion, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherArtifact = resign(envelope, (unsigned) => { (unsigned.artifactPin as { artifactId: string }).artifactId = "art_elsewhere"; });
    expect(await code(() => verifyArtifactShare(otherArtifact, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherFile = resign(envelope, (unsigned) => { (unsigned.artifactPin as { files: { path: string }[] }).files[0]!.path = "other.md"; });
    expect(await code(() => verifyArtifactShare(otherFile, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherDigest = resign(envelope, (unsigned) => { (unsigned.artifactPin as { files: { sha256: string }[] }).files[0]!.sha256 = "c".repeat(64); });
    expect(await code(() => verifyArtifactShare(otherDigest, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
  });

  it("missing pin on a share that reads an artifact fails closed, signed or not", async () => {
    const { envelope } = await publishPinned();
    const unpinned = resign(envelope, (unsigned) => { delete unsigned.artifactPin; });
    expect(await code(() => verifyArtifactShare(unpinned, { expectedOwnerDid: ownerDid }))).toBe("missing-pin");
    // The publisher refuses to mint one in the first place, before it registers anything.
    await expect(publishPinned({ omitPin: true })).rejects.toMatchObject({ code: "missing-pin" });
  });

  it("a pin on a share that does not read an artifact is refused", async () => {
    const { envelope, version } = await publishPinned();
    const view = artifactBindingView(envelope);
    const elsewhere = { ...view, contentSource: { ...view.contentSource, kvResource: "tinycloud:test-space/kv/shares/abc/note.md" }, resource: { kind: "exact" as const, path: "shares/abc/note.md" }, artifactPin: buildArtifactPin(version, "note.md") };
    expect(() => assertArtifactBinding(elsewhere)).toThrow(ArtifactPinError);
    const noPin = { ...elsewhere }; delete (noPin as { artifactPin?: unknown }).artifactPin;
    expect(assertArtifactBinding(noPin)).toBeUndefined();
  });

  it("an artifact path that cannot be pinned (current/, a folder, another space) is refused", async () => {
    const { envelope } = await publishPinned();
    const view = artifactBindingView(envelope);
    for (const path of ["artifacts/art_pin/current/note.md", "artifacts/art_pin/versions/1", "artifacts/art_pin/versions/01/note.md", "artifacts/art_pin/versions/1/sub/note.md", "artifacts"]) {
      const bad = { ...view, contentSource: { ...view.contentSource, kvResource: `tinycloud:test-space/kv/${path}` }, resource: { kind: "exact" as const, path } };
      expect(() => assertArtifactBinding(bad)).toThrow(ArtifactPinError);
    }
    const otherSpace = { ...view, contentSource: { ...view.contentSource, kvResource: "tinycloud:other-space/kv/artifacts/art_pin/versions/1/note.md" } };
    expect(() => assertArtifactBinding(otherSpace)).toThrow(ArtifactPinError);
  });

  it("a pinned share can never grant edit, in the envelope or in the signed policy", async () => {
    const { envelope } = await publishPinned();
    const view = artifactBindingView(envelope);
    expect(() => assertArtifactBinding({ ...view, actions: ["read", "edit"] })).toThrow(ArtifactPinError);
    expect(() => assertArtifactBinding({ ...view, policyKvActions: [...view.policyKvActions, "tinycloud.kv/put"] })).toThrow(ArtifactPinError);
  });

  it("a mutable or prefix source cannot carry a pin", async () => {
    const { envelope } = await publishPinned();
    const view = artifactBindingView(envelope);
    expect(() => assertArtifactBinding({ ...view, contentSource: { ...view.contentSource, mode: "mutable" } })).toThrow(ArtifactPinError);
    expect(() => assertArtifactBinding({ ...view, contentSource: { ...view.contentSource, selector: "prefix" }, resource: { ...view.resource, kind: "prefix" } })).toThrow(ArtifactPinError);
    expect(() => assertArtifactBinding({ ...view, contentSource: { ...view.contentSource, initialCiphertextDigestHex: "d".repeat(64) } })).toThrow(ArtifactPinError);
  });

  it("the recipient refuses unpinned shares and altered bytes before it contacts the node", async () => {
    const { envelope, stored } = await publishPinned();
    let contacted = 0;
    const fetchFn: typeof fetch = async () => { contacted += 1; throw new Error("must not reach the node"); };
    const clientFor = (candidate: ShareEnvelopeV3) => {
      const client = new ShareRecipientClient({ nodeOrigin: "https://node.example.com", envelope: candidate, holderDid: ownerDid, trustedNode: {} as never, fetchFn, buildPresentation: async () => ({ holderDid: ownerDid, credential: "fixture", holderBinding: "fixture" }) as never });
      Object.assign(client, { session: { sessionId: "session" }, v3Authorization: "a.b.c", v3NodeAudience: nodeDid, nativeSigner: async (bytes: Uint8Array) => ed25519.sign(bytes, ownerSeed) });
      return client;
    };
    const altered = stored.slice();
    altered[0] = altered[0]! ^ 0x01;
    await expect(clientFor(envelope).decryptV3Content(altered)).rejects.toThrow("ciphertext digest mismatch");
    const unpinned = resign(envelope, (unsigned) => { delete unsigned.artifactPin; });
    await expect(clientFor(unpinned).decryptV3Content(stored)).rejects.toThrow("missing-pin");
    expect(contacted).toBe(0);
  });
});

describe("artifact pin: through the receive path (inspectShare, full verifyEnvelopeV3)", () => {
  it("opens a fully signed pinned share and reports its artifact and version", async () => {
    const { link, version } = await publishPinned();
    const inspected = await inspectShare(link);
    expect(inspected.metadata.artifact).toEqual({ id: "art_pin", version: version.version });
  });

  it("refuses a validly signed envelope that reads an artifact without a pin, or with a pin that lies, as a pin error", async () => {
    const { envelope } = await publishPinned();
    const unpinned = resign(envelope, (unsigned) => { delete unsigned.artifactPin; });
    await expect(inspectShare(await linkFor(unpinned))).rejects.toMatchObject({ code: "envelope-invalid", message: expect.stringContaining("missing-pin") });
    const lying = resign(envelope, (unsigned) => { (unsigned.artifactPin as { version: number }).version = 9; });
    await expect(inspectShare(await linkFor(lying))).rejects.toMatchObject({ code: "envelope-invalid", message: expect.stringContaining("pin-source-mismatch") });
    // An envelope that grants edit while its signed policy does not is inconsistent: verifyEnvelopeV3 refuses it first.
    const writable = resign(envelope, (unsigned) => { unsigned.actions = ["read", "edit"]; });
    await expect(inspectShare(await linkFor(writable))).rejects.toMatchObject({ code: "signature-invalid" });
  });

  it("refuses an envelope signed by another key, or edited after signing, as a signature failure", async () => {
    const { envelope } = await publishPinned();
    const byForeignKey = resign(envelope, () => {}, foreignSeed);
    await expect(inspectShare(await linkFor(byForeignKey))).rejects.toMatchObject({ code: "signature-invalid" });
    const edited = structuredClone(envelope) as ShareEnvelopeV3;
    (edited.artifactPin as { version: number }).version = 2;
    await expect(inspectShare(await linkFor(edited))).rejects.toMatchObject({ code: "signature-invalid" });
  });
});

describe("artifact pin: each binding check fails alone", () => {
  const withView = async (change: (view: ReturnType<typeof artifactBindingView>) => unknown) => {
    const { envelope } = await publishPinned();
    const view = artifactBindingView(envelope);
    return () => assertArtifactBinding(change(view) as typeof view);
  };

  it("resource.kind, source selector and resource.path are each checked on their own", async () => {
    expect(await withView((view) => ({ ...view, resource: { ...view.resource, kind: "prefix" } }))).toThrow(ArtifactPinError);
    expect(await withView((view) => ({ ...view, contentSource: { ...view.contentSource, selector: "prefix" } }))).toThrow(ArtifactPinError);
    expect(await withView((view) => ({ ...view, resource: { ...view.resource, path: `${view.resource.path}x` } }))).toThrow(ArtifactPinError);
    expect((await withView((view) => view))()).toBeDefined();
  });

  it("an envelope signed by one key whose policy names another owner is refused", async () => {
    const { envelope } = await publishPinned();
    const byForeignKey = resign(envelope, () => {}, foreignSeed);
    expect(await code(() => verifyArtifactShare(byForeignKey, { expectedOwnerDid: didFor(foreignSeed) }))).toBe("bad-signature");
  });
});

describe("artifact pin: shape bounds", () => {
  it("accepts exactly the artifact ids share-sdk mints and parses", () => {
    const accepts = (id: string) => { try { assertArtifactId(id); return true; } catch { return false; } };
    for (const id of ["art_0123456789abcdef", "a1b", "abc", "a-b_c", "", "ab", "Abc", "a/b", "../x", "a b", "-ab", "_ab", "a".repeat(63), "a".repeat(64)]) {
      expect(artifactPinSchema.shape.artifactId.safeParse(id).success).toBe(accepts(id));
    }
  });

  it("bounds the pinned size", async () => {
    const { envelope } = await publishPinned();
    const view = artifactBindingView(envelope);
    const sized = (bytes: number) => ({ ...view, artifactPin: { ...view.artifactPin!, files: [{ ...view.artifactPin!.files[0]!, bytes }] } });
    expect(() => assertArtifactBinding(sized(128 * 1024 * 1024))).not.toThrow();
    expect(() => assertArtifactBinding(sized(128 * 1024 * 1024 + 1))).toThrow(ArtifactPinError);
    expect(() => assertArtifactBinding(sized(Number.MAX_SAFE_INTEGER))).toThrow(ArtifactPinError);
  });

});
