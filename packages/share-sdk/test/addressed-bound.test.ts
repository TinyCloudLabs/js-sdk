import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { fromBase64Url } from "@tinycloud/share-envelope";
import { MAX_LINK_BODY_BYTES } from "@tinycloud/share-envelope/links";
import {
  ADDRESSED_SHARE_TOO_LARGE_MESSAGE,
  AddressedShareOverLimitError,
  SharePublishError,
  addressedCredentialRequirement,
  addressedShareBodyUpperBound,
  assertAddressedShareFits,
  publishAddressedShare,
  type AddressedPublishAuthority,
  type AddressedShareBoundInput,
  type AddressedSharePublishOptions,
  type PublishedShare,
} from "../src/index.js";
import { buildArtifactPin, publishArtifactVersion, sha256Hex, type ArtifactStore } from "../src/artifact.js";
import { didFor, enc, foreignSeed, nodeDid, ownerDid, ownerSeed, signedBinding, signedRoot } from "./support/signed-share.js";

const SHARE_ID = "boundshare00000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const NETWORK = `urn:tinycloud:encryption:${ownerDid}:default`;
const EXPIRES_AT = new Date(Math.floor(Date.now() / 1000) * 1000 + 7 * 24 * 3600_000);

type Target = AddressedSharePublishOptions["target"];

interface Calls {
  createOwnerRoot: number;
  sign: number;
  registerPolicy: number;
}

/** An owner authority with real compact-UCAN roots and a signed enforcer binding; counts every call. */
function authority(calls: Calls, rootAuthorization?: string): AddressedPublishAuthority {
  return {
    ownerDid,
    async createOwnerRoot(input) {
      calls.createOwnerRoot += 1;
      const root = signedRoot(input);
      return rootAuthorization === undefined ? root : { cid: root.cid, delegationHeader: { Authorization: rootAuthorization } };
    },
    async sign(bytes) {
      calls.sign += 1;
      return ed25519.sign(bytes, ownerSeed);
    },
    async registerPolicy(input) {
      calls.registerPolicy += 1;
      return { policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid, attestedEnforcerBinding: signedBinding(EXPIRES_AT) };
    },
  };
}

const newCalls = (): Calls => ({ createOwnerRoot: 0, sign: 0, registerPolicy: 0 });

function commitment(target: Target) {
  return target.kind === "email" || target.kind === "emailDomain" ? { credentialRequirement: addressedCredentialRequirement(target) } : {};
}

interface Share {
  readonly options: AddressedSharePublishOptions;
  readonly bound: AddressedShareBoundInput;
}

/** A publish and the bound input a sender would hold before any write, for the same share. */
function share(target: Target, path: string, extra: { readonly artifactPin?: AddressedSharePublishOptions["artifactPin"]; readonly calls?: Calls; readonly rootAuthorization?: string; readonly storageName?: string; readonly artifactId?: string } = {}): Share {
  const calls = extra.calls ?? newCalls();
  const options: AddressedSharePublishOptions = {
    shareId: SHARE_ID, shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example", nodeAudience: nodeDid, enforcerDid: nodeDid,
    spaceId: SPACE, target, resource: { kind: "exact", path }, actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: SHARE_ID, kvResource: `${SPACE}/kv/${path}`, selector: "exact", encryptionNetwork: NETWORK,
      encryptedSymmetricKeyDigestHex: "1".repeat(64), keyVersion: 3, mode: "immutable", initialCiphertextDigestHex: "2".repeat(64),
    },
    ...(extra.artifactPin === undefined ? {} : { artifactPin: extra.artifactPin }),
    ...commitment(target),
    ...(target.kind === "email" ? { deliveryEmail: target.address } : {}),
    filename: "note.md", mediaType: "text/markdown", byteLength: 4096, expiresAt: EXPIRES_AT,
    authority: authority(calls, extra.rootAuthorization),
  };
  const bound: AddressedShareBoundInput = {
    shareId: SHARE_ID, ownerDid, nodeOrigin: options.nodeOrigin, nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: SPACE, target,
    resource: { kind: "exact" },
    storage: extra.artifactId === undefined ? { path } : { artifactId: extra.artifactId, storageName: extra.storageName ?? "note.md" },
    encryptionNetwork: NETWORK, actions: options.actions, policyActions: options.policyActions,
    ...commitment(target),
    ...(target.kind === "email" ? { deliveryEmail: target.address } : {}),
    filename: options.filename, mediaType: options.mediaType, byteLength: options.byteLength, expiresAt: EXPIRES_AT,
  };
  return { options, bound };
}

async function realSize(published: PublishedShare): Promise<number> {
  return fromBase64Url(published.deliveryMaterial!.sealedEnvelope).length;
}

function memoryStore(): ArtifactStore {
  const data = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) { if (data.has(key)) return "exists"; data.set(key, bytes.slice()); return "created"; },
    async get(key) { return data.get(key)?.slice(); },
    async list(prefix) { return [...data.keys()].filter((key) => key.startsWith(prefix)); },
  };
}

describe("addressed share size bound", () => {
  const targets: readonly { readonly name: string; readonly target: Target }[] = [
    { name: "a DID", target: { kind: "recipientDid", did: didFor(foreignSeed) } },
    { name: "an email address", target: { kind: "email", address: "alice@example.com" } },
    { name: "an email domain", target: { kind: "emailDomain", domain: "example.com" } },
  ];

  for (const { name, target } of targets) {
    it(`covers the sealed envelope of a share to ${name}`, async () => {
      const { options, bound } = share(target, `shares/${SHARE_ID}/note.md`);
      const upper = await addressedShareBodyUpperBound(bound);
      const real = await realSize(await publishAddressedShare(options));
      expect(real).toBeLessThanOrEqual(upper);
      // The bound is close, not just large: every maximum it assumes costs well under a kilobyte here.
      expect(upper - real).toBeLessThan(1500);
    });
  }

  it("covers the sealed envelope of a share with a long prefix path", async () => {
    const path = `shares/${SHARE_ID}/${"folder-name/".repeat(60)}note.md`;
    const { options, bound } = share({ kind: "email", address: "alice@example.com" }, path);
    const real = await realSize(await publishAddressedShare(options));
    expect(real).toBeLessThanOrEqual(await addressedShareBodyUpperBound(bound));
    expect(real).toBeGreaterThan(8_000);
  });

  it("covers the sealed envelope of a pinned artifact share, whatever version number the publish claims", async () => {
    const store = memoryStore();
    const stored = enc(JSON.stringify({ v: 1, ciphertext: "AQ" }));
    const version = await publishArtifactVersion(store, { artifactId: "art_bound", files: [{ filename: "note.md", bytes: stored }] });
    const path = `artifacts/art_bound/versions/${version.version}/note.md`;
    const { options, bound } = share({ kind: "email", address: "alice@example.com" }, path, { artifactPin: buildArtifactPin(version, "note.md"), artifactId: "art_bound" });
    const real = await realSize(await publishAddressedShare({ ...options, contentSource: { ...options.contentSource, initialCiphertextDigestHex: sha256Hex(stored) } }));
    expect(real).toBeLessThanOrEqual(await addressedShareBodyUpperBound(bound));
  });

  it("refuses an over-limit share before any authority call", async () => {
    const calls = newCalls();
    const path = `shares/${SHARE_ID}/${"a".repeat(5_000)}`;
    const { options, bound } = share({ kind: "email", address: "alice@example.com" }, path, { calls });
    expect(await addressedShareBodyUpperBound(bound)).toBeGreaterThan(MAX_LINK_BODY_BYTES);
    await expect(assertAddressedShareFits(bound)).rejects.toMatchObject({ code: "max-bytes-exceeded", message: ADDRESSED_SHARE_TOO_LARGE_MESSAGE });
    await expect(publishAddressedShare(options)).rejects.toBeInstanceOf(SharePublishError);
    expect(calls).toEqual({ createOwnerRoot: 0, sign: 0, registerPolicy: 0 });
  });

  it("removes nothing it did not write: a share within the bound that seals over the limit reports what was registered, and no link", async () => {
    const calls = newCalls();
    // An authority that returns a root far larger than any a real one is: the bound passes, the sealed body does not.
    const oversized = `a.${"b".repeat(70_000)}.c`;
    const { options, bound } = share({ kind: "email", address: "alice@example.com" }, `shares/${SHARE_ID}/note.md`, { calls, rootAuthorization: oversized });
    await expect(assertAddressedShareFits(bound)).resolves.toBeUndefined();
    let materialCalls = 0;
    const failure = await publishAddressedShare({ ...options, onDeliveryMaterial: () => { materialCalls += 1; } }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AddressedShareOverLimitError);
    if (!(failure instanceof AddressedShareOverLimitError)) throw failure;
    expect(failure.code).toBe("max-bytes-exceeded");
    expect(failure.message).toBe(ADDRESSED_SHARE_TOO_LARGE_MESSAGE);
    expect(failure.written.policyRootCid).toMatch(/^bafkr4/);
    expect(failure.written.enforcementRootCid).toMatch(/^bafkr4/);
    expect(failure.written.policyCid).toMatch(/^bafkrei/);
    // The policy was registered once; the policy and the envelope were signed; the link header never was.
    expect(calls).toEqual({ createOwnerRoot: 2, sign: 2, registerPolicy: 1 });
    expect(materialCalls).toBe(0);
  });
});
