import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { artifactPinSchema, signEnvelopeV3, type ArtifactPin, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import {
  ArtifactPinError,
  ShareRecipientClient,
  addressedCredentialRequirement,
  artifactBindingView,
  assertArtifactBinding,
  publishAddressedShare,
  verifyArtifactShare,
} from "../src/index.js";
import {
  buildArtifactPin,
  manifestBytes,
  publishArtifactVersion,
  sha256Hex,
  verifyArtifactFileBytes,
  verifyArtifactManifestBytes,
  type ArtifactStore,
  type ArtifactVersionResult,
} from "../src/artifact.js";

const didFor = (seed: Uint8Array) => `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerDid = didFor(ownerSeed);
const attackerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const nodeDid = didFor(nodeSeed);
const enc = (value: string) => new TextEncoder().encode(value);

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
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    onDeliveryMaterial: (material) => { delivered = material; },
    authority: {
      ownerDid,
      async createOwnerRoot(input) { return { cid: input.role === "policy-authority" ? "bafy-policy-root" : "bafy-enforcement-root", delegationHeader: { Authorization: input.role === "policy-authority" ? "a.b.c" : "d.e.f" } }; },
      async sign(bytes) { return ed25519.sign(bytes, ownerSeed); },
      async registerPolicy(input) {
        return {
          policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid,
          attestedEnforcerBinding: {
            schema: "xyz.tinycloud.policy/attested-enforcer/v2", enforcerDid: nodeDid, nodeAudience: nodeDid,
            attestationBindingDigestHex: "3".repeat(64), issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
            signature: { suite: "Ed25519", signerDid: nodeDid, value: "AQ" },
          },
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

function code(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof ArtifactPinError ? error.code : `unexpected: ${String(error)}`; }
  return "no error";
}

describe("artifact pin: a pinned envelope", () => {
  it("carries the owner-signed pin and verifies against the owner and the fetched bytes", async () => {
    const { envelope, version, stored } = await publishPinned();
    const pin = verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_pin", version: 1 } });
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
    const pin = (verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid }))!;
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
    const byAttacker = resign(envelope, () => {}, attackerSeed);
    expect(code(() => verifyArtifactShare(byAttacker, { expectedOwnerDid: ownerDid }))).toBe("wrong-signer");
    // Claims the owner as signer but carries the attacker's signature bytes.
    const forged = { ...byAttacker, signature: { ...byAttacker.signature, signerDid: ownerDid } } as ShareEnvelopeV3;
    expect(code(() => verifyArtifactShare(forged, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
    // The pin is edited after signing: the owner's signature no longer covers the bytes.
    const edited = structuredClone(envelope) as ShareEnvelopeV3;
    (edited.artifactPin as { version: number }).version = 2;
    expect(code(() => verifyArtifactShare(edited, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
    const stripped = structuredClone(envelope) as unknown as Record<string, unknown>;
    delete stripped.artifactPin;
    expect(code(() => verifyArtifactShare(stripped as unknown as ShareEnvelopeV3, { expectedOwnerDid: ownerDid }))).toBe("bad-signature");
  });

  it("replayed older manifest: version 1's manifest does not satisfy version 2's pin", async () => {
    const store = memoryStore();
    const first = await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "one" }) });
    const second = await publishPinned({ store, ciphertext: JSON.stringify({ v: 1, ciphertext: "two" }) });
    expect([first.version.version, second.version.version]).toEqual([1, 2]);
    const pin2 = (verifyArtifactShare(second.envelope, { expectedOwnerDid: ownerDid }))!;
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
    expect(code(() => verifyArtifactShare(first.envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_pin", version: 2 } }))).toBe("expectation-mismatch");
    expect(code(() => verifyArtifactShare(first.envelope, { expectedOwnerDid: ownerDid, expected: { artifactId: "art_other" } }))).toBe("expectation-mismatch");
  });

  it("truncated manifest: every prefix of the manifest bytes is refused", async () => {
    const { envelope, version } = await publishPinned();
    const pin = (verifyArtifactShare(envelope, { expectedOwnerDid: ownerDid }))!;
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
    expect(code(() => verifyArtifactShare(otherVersion, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherArtifact = resign(envelope, (unsigned) => { (unsigned.artifactPin as { artifactId: string }).artifactId = "art_elsewhere"; });
    expect(code(() => verifyArtifactShare(otherArtifact, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherFile = resign(envelope, (unsigned) => { (unsigned.artifactPin as { files: { path: string }[] }).files[0]!.path = "other.md"; });
    expect(code(() => verifyArtifactShare(otherFile, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
    const otherDigest = resign(envelope, (unsigned) => { (unsigned.artifactPin as { files: { sha256: string }[] }).files[0]!.sha256 = "c".repeat(64); });
    expect(code(() => verifyArtifactShare(otherDigest, { expectedOwnerDid: ownerDid }))).toBe("pin-source-mismatch");
  });

  it("missing pin on a share that reads an artifact fails closed, signed or not", async () => {
    const { envelope } = await publishPinned();
    const unpinned = resign(envelope, (unsigned) => { delete unsigned.artifactPin; });
    expect(code(() => verifyArtifactShare(unpinned, { expectedOwnerDid: ownerDid }))).toBe("missing-pin");
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
