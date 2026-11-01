/*
 * TC-2242. Every addressed share is encrypted under its own named key `share/<shareId>` and registers that key's raw-byte
 * wrapped-key digest; the node refuses a new registration without both, and the recipient opens exactly that one key.
 * These tests drive the REAL `NamedKeyClient` (sdk-services) against a stub node, then the real helpers and the real
 * `publishAddressedShare`, so the shape contract between them is pinned.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { NamedKeyClient, type NamedKeyClientConfig } from "@tinycloud/sdk-services/encryption/named-keys";
import * as shareSdk from "../src/index.js";
import type { AddressedPolicyRegistrationInput, AddressedSharePublishOptions, PathBoundContentSource } from "../src/index.js";
// Read through the namespace so that, against a source without these exports, each test fails on its own instead of the file failing to load.
const {
  AddressedContentSourceError,
  addressedCredentialRequirement,
  addressedShareBodyUpperBound,
  bindPathBoundContentSource,
  defaultEncryptionNetworkForOwner,
  encryptAddressedShareContent,
  pathBoundKeyPath,
  pathBoundStoredBytes,
  planPathBoundShare,
  publishAddressedShare,
  wrappedKeyDigestHex,
} = shareSdk;

const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(ownerSeed)]))}`;
const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;
const OWNER_PKH = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:${OWNER_PKH}:default`;
const SPACE = "tinycloud:test-space";
const HOST = "https://node.test";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  return data.map((byte, index) => byte ^ key[index % key.length]!);
}
let counter = 7;
const crypto: NamedKeyClientConfig["crypto"] = {
  sha256,
  randomBytes: (length) => Uint8Array.from({ length }, () => (counter = (Math.imul(counter, 1664525) + 1013904223) >>> 0) & 0xff),
  x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
  x25519Dh: (a, b) => xor(a, b),
  authEncrypt: (key, plaintext) => xor(key, plaintext),
  authDecrypt: (key, ciphertext) => xor(key, ciphertext),
  sealToNetworkKey: (pub, symmetric) => Uint8Array.from([...xor(pub, symmetric), 1, 2, 3]),
  openWithReceiverKey: (priv, wrapped) => xor(priv, wrapped),
  verifyNodeSignature: () => true,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A real `NamedKeyClient` against a stub node that answers /info, the key's public key and key creation. */
function realKeys(options: { createStatus?: number; createBody?: string } = {}) {
  const requests: { method: string; url: string; body?: string }[] = [];
  const descriptor = (keyPath: string) => ({
    networkId: NETWORK, keyPath, alg: "x25519-aes256gcm/v1", keyVersion: 3, publicEncryptionKey: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
    state: "active", kind: "deterministic", createdAt: "t0", updatedAt: "t0",
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url === `${HOST}/info`) return json({ nodeId: nodeDid, features: ["encryption-named-keys-v1"] });
    const keyPath = decodeURIComponent(url.split("/keys/")[1] ?? (typeof init?.body === "string" ? (JSON.parse(init.body).keyPath as string) : ""));
    if ((init?.method ?? "GET") === "POST") {
      if (options.createStatus !== undefined && options.createStatus >= 400) return new Response(options.createBody ?? "unauthorized_action: key.create", { status: options.createStatus });
      return json(descriptor(keyPath));
    }
    return json(descriptor(keyPath));
  }) as typeof fetch;
  const config: NamedKeyClientConfig = {
    host: HOST, crypto, fetch: fetchImpl, defaultNetworkId: () => NETWORK,
    signInvocation: async (input) => ({ authorization: `Bearer test:${input.action}`, invocationCid: "cid" }),
    decryptRoot: async () => { throw new Error("unused"); },
  };
  return { keys: new NamedKeyClient(config), requests };
}

const TARGETS = [
  { kind: "recipientDid", target: { kind: "recipientDid" as const, did: "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav" } },
  { kind: "email", target: { kind: "email" as const, address: "alice@example.com" } },
  { kind: "emailDomain", target: { kind: "emailDomain" as const, domain: "example.com" } },
] as const;

function authority() {
  const seen = { roots: [] as Parameters<AddressedSharePublishOptions["authority"]["createOwnerRoot"]>[0][], signs: 0, registrations: [] as AddressedPolicyRegistrationInput[] };
  const value: AddressedSharePublishOptions["authority"] = {
    ownerDid,
    async createOwnerRoot(input) {
      seen.roots.push(input);
      return { cid: input.role === "policy-authority" ? "bafy-policy-root" : "bafy-enforcement-root", delegationHeader: { Authorization: input.role === "policy-authority" ? "a.b.c" : "d.e.f" } };
    },
    async sign(bytes) { seen.signs++; return ed25519.sign(bytes, ownerSeed); },
    async registerPolicy(input) {
      seen.registrations.push(input);
      return {
        policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid,
        attestedEnforcerBinding: {
          schema: "xyz.tinycloud.policy/attested-enforcer/v2", enforcerDid: nodeDid, nodeAudience: nodeDid,
          attestationBindingDigestHex: "3".repeat(64), issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
          signature: { suite: "Ed25519", signerDid: nodeDid, value: "AQ" },
        },
      };
    },
  };
  return { value, seen };
}

const SHARE_ID = "pathboundshare00000001";
const PATH = `shares/${SHARE_ID}/note.txt`;

function publishOptions(target: AddressedSharePublishOptions["target"], contentSource: AddressedSharePublishOptions["contentSource"], auth: AddressedSharePublishOptions["authority"], shareId = SHARE_ID): AddressedSharePublishOptions {
  return {
    shareId, shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example", nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: SPACE,
    target, resource: { kind: "exact", path: PATH }, actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource,
    ...(target.kind === "recipientDid" ? {} : { credentialRequirement: addressedCredentialRequirement(target) }),
    filename: "note.txt", mediaType: "text/plain", byteLength: 5, expiresAt: new Date("2030-01-01T00:00:00.000Z"), authority: auth,
  };
}

/** plan -> encrypt (real named-key client) -> upload -> bind: what a consumer runs. */
async function encryptAndBind(shareId = SHARE_ID) {
  const { keys, requests } = realKeys();
  const plan = planPathBoundShare({ shareId, encryptionNetwork: NETWORK });
  const encrypted = await encryptAddressedShareContent({ plan, keys, plaintext: new TextEncoder().encode("hello"), metadata: { contentType: "text/plain" } });
  const contentSource = bindPathBoundContentSource({ plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes, kvResource: `${SPACE}/kv/shares/${shareId}/note.txt`, selector: "exact" });
  return { plan, encrypted, contentSource, requests };
}

const bad = (overrides: Record<string, unknown>, drop: string[] = []) => async () => {
  const { contentSource } = await encryptAndBind();
  const mutated: Record<string, unknown> = { ...contentSource, ...overrides };
  for (const key of drop) delete mutated[key];
  return mutated as unknown as PathBoundContentSource;
};

describe("every addressed target kind publishes a path-bound source (real named-key envelope, real publisher)", () => {
  for (const { kind, target } of TARGETS) {
    it(`${kind}: the key is created and encrypted under share/<shareId>, the source carries the path and the raw-byte digest, and the only decrypt grant is that one key`, async () => {
      const { plan, encrypted, contentSource, requests } = await encryptAndBind();
      const auth = authority();
      const published = await publishAddressedShare(publishOptions(target, contentSource, auth.value));

      // The key is created, then the content is encrypted to it, both at the share's own path.
      expect(requests.find((request) => request.method === "POST")?.body).toContain(`"keyPath":"share/${SHARE_ID}"`);
      expect(encrypted.envelope).toMatchObject({ v: 2, networkId: NETWORK, keyPath: `share/${SHARE_ID}`, keyVersion: 3 });
      // The digest is the SHA-256 of the DECODED wrapped-key bytes, not the canonical hash of the base64 string.
      const rawDigest = createHash("sha256").update(Buffer.from(encrypted.envelope.encryptedSymmetricKey, "base64")).digest("hex");
      expect(contentSource.encryptedSymmetricKeyDigestHex).toBe(rawDigest);
      expect(contentSource.encryptedSymmetricKeyDigestHex).not.toBe(encrypted.envelope.encryptedSymmetricKeyHash);
      expect(wrappedKeyDigestHex(encrypted.envelope.encryptedSymmetricKey)).toBe(rawDigest);
      expect(contentSource.initialCiphertextDigestHex).toBe(createHash("sha256").update(encrypted.storedBytes).digest("hex"));
      expect(JSON.parse(new TextDecoder().decode(encrypted.storedBytes))).toEqual(JSON.parse(JSON.stringify(encrypted.envelope)));

      // What is registered and signed names the path, and the only encryption capability is the one key, never the network.
      const registered = auth.seen.registrations[0]!.policy as unknown as { contentSource: PathBoundContentSource; capabilityCeiling: { kind: string; resource: string }[] };
      expect(registered.contentSource).toMatchObject({ encryptionKeyPath: `share/${SHARE_ID}`, encryptedSymmetricKeyDigestHex: rawDigest });
      const encryptionResources = (list: readonly { kind: string; resource: string }[]) => list.filter((capability) => capability.kind === "encryption").map((capability) => capability.resource);
      expect(encryptionResources(registered.capabilityCeiling)).toEqual([`${NETWORK}/share/${SHARE_ID}`]);
      for (const root of auth.seen.roots) expect(encryptionResources(root.capabilities)).toEqual([`${NETWORK}/share/${SHARE_ID}`]);
      expect(plan.keyResource).toBe(`${NETWORK}/share/${SHARE_ID}`);
      expect(published.deliveryMaterial?.envelope.contentSource).toMatchObject({ encryptionKeyPath: `share/${SHARE_ID}`, encryptedSymmetricKeyDigestHex: rawDigest });
      expect((published.deliveryMaterial?.envelope.policy as unknown as { capabilityCeiling: { kind: string; resource: string }[] }).capabilityCeiling.filter((capability) => capability.kind === "encryption").map((capability) => capability.resource)).toEqual([`${NETWORK}/share/${SHARE_ID}`]);
    });
  }
});

describe("the publisher refuses anything not path-bound before it signs, registers or writes", () => {
  const cases: [string, () => Promise<PathBoundContentSource>, string][] = [
    ["no key path (a network-wide source)", bad({}, ["encryptionKeyPath"]), "key-path-required"],
    ["another share's key path", bad({ encryptionKeyPath: "share/someothershare0000001" }), "key-path-mismatch"],
    ["the path without its share prefix", bad({ encryptionKeyPath: SHARE_ID }), "key-path-mismatch"],
    ["a nested path", bad({ encryptionKeyPath: `share/${SHARE_ID}/extra` }), "key-path-mismatch"],
    ["no wrapped-key digest", bad({}, ["encryptedSymmetricKeyDigestHex"]), "digest-invalid"],
    ["a short digest", bad({ encryptedSymmetricKeyDigestHex: "ab".repeat(16) }), "digest-invalid"],
    ["an upper-case digest", bad({ encryptedSymmetricKeyDigestHex: "AB".repeat(32) }), "digest-invalid"],
    ["a network that is not a default network", bad({ encryptionNetwork: NETWORK.replace(":default", ":other") }), "network-invalid"],
    ["a bare key resource as the network", bad({ encryptionNetwork: `${NETWORK}/share/${SHARE_ID}` }), "network-invalid"],
  ];
  for (const [name, make, code] of cases) {
    for (const { kind, target } of TARGETS) {
      it(`${kind}: ${name} is refused as ${code} with no signature, owner root or registration`, async () => {
        const auth = authority();
        const source = await make();
        const failure = await publishAddressedShare(publishOptions(target, source, auth.value)).then(() => undefined, (error: unknown) => error);
        expect(failure).toMatchObject({ name: "AddressedContentSourceError", code });
        expect(auth.seen.signs).toBe(0);
        expect(auth.seen.roots).toEqual([]);
        expect(auth.seen.registrations).toEqual([]);
      });
    }
  }

  it("a path that names another share is refused even when it is the source's own consistent value", async () => {
    const { contentSource } = await encryptAndBind("someothershare0000001");
    const auth = authority();
    await expect(publishAddressedShare(publishOptions(TARGETS[1].target, { ...contentSource, shareId: SHARE_ID }, auth.value))).rejects.toMatchObject({ code: "key-path-mismatch" });
    expect(auth.seen.signs).toBe(0);
  });
});

describe("the size bound sees the path", () => {
  const request = { ...TARGETS[1], shareId: SHARE_ID, ownerDid, nodeOrigin: "https://node.example", nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: SPACE };
  const input = (extra: Record<string, unknown> = {}) => ({
    target: request.target, actions: ["read"] as const, policyActions: ["tinycloud.kv/get"] as const, filename: "note.txt",
    shareId: SHARE_ID, ownerDid, nodeOrigin: "https://node.example", nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: SPACE,
    resource: { kind: "exact" as const }, storage: { path: PATH }, encryptionNetwork: NETWORK, mediaType: "text/plain", byteLength: 5,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"), ...extra,
  });

  it("covers a real path-bound envelope without being given the key path", async () => {
    const { contentSource } = await encryptAndBind();
    const published = await publishAddressedShare(publishOptions(request.target, contentSource, authority().value));
    const bound = await addressedShareBodyUpperBound(input() as never);
    expect(bound).toBeGreaterThanOrEqual(Math.floor(published.deliveryMaterial!.sealedEnvelope.length * 3 / 4));
  });

  it("measures the same bytes whether or not the caller passes the (redundant) key path", async () => {
    expect(await addressedShareBodyUpperBound(input() as never)).toBe(await addressedShareBodyUpperBound(input({ encryptionKeyPath: `share/${SHARE_ID}` }) as never));
  });

  it("refuses a key path that is not this share's", async () => {
    await expect(addressedShareBodyUpperBound(input({ encryptionKeyPath: "share/someothershare0000001" }) as never)).rejects.toMatchObject({ code: "key-path-mismatch" });
    await expect(addressedShareBodyUpperBound(input({ encryptionKeyPath: `share/${SHARE_ID}` }) as never)).resolves.toBeGreaterThan(0);
  });
});

describe("plan: path, permissions and the checksummed network", () => {
  it("derives share/<shareId> and the exact permission entries", () => {
    const plan = planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: NETWORK });
    expect(plan.keyPath).toBe(`share/${SHARE_ID}`);
    expect(pathBoundKeyPath(SHARE_ID)).toBe(plan.keyPath);
    expect(plan.requiredPermissions).toEqual([{ service: "tinycloud.encryption", path: `${NETWORK}/share/${SHARE_ID}`, actions: ["tinycloud.encryption/key.create"] }]);
    expect(plan.registrationPermissions).toEqual([{ service: "tinycloud.encryption", path: `${NETWORK}/share/`, actions: ["tinycloud.encryption/decrypt"] }]);
    expect(plan.encryptOptions({ metadata: { contentType: "text/plain" } })).toEqual({ networkId: NETWORK, metadata: { contentType: "text/plain" } });
  });

  it("refuses a lower-cased owner network and offers the checksummed one", () => {
    const lower = `urn:tinycloud:encryption:${OWNER_PKH.toLowerCase()}:default`;
    expect(() => planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: lower })).toThrow(AddressedContentSourceError);
    expect(() => planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: lower })).toThrow(/checksummed/);
    expect(defaultEncryptionNetworkForOwner(OWNER_PKH.toLowerCase())).toBe(NETWORK);
    expect(defaultEncryptionNetworkForOwner(OWNER_PKH)).toBe(NETWORK);
    expect(planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: defaultEncryptionNetworkForOwner(OWNER_PKH.toLowerCase()) }).encryptionNetwork).toBe(NETWORK);
  });

  it("refuses a bad share id and a network that is not the owner's default", () => {
    expect(() => planPathBoundShare({ shareId: "short", encryptionNetwork: NETWORK })).toThrow(expect.objectContaining({ code: "share-id-invalid" }));
    expect(() => planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: NETWORK.replace(":default", ":other") })).toThrow(expect.objectContaining({ code: "network-invalid" }));
    expect(() => planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: NETWORK.replace("urn:tinycloud:encryption:", "") })).toThrow(expect.objectContaining({ code: "network-invalid" }));
  });
});

describe("bind and encrypt refuse what the recipient or node would", () => {
  it("a 403 on key creation also names the first-party-origin rule for OpenKey owners", async () => {
    const { keys } = realKeys({ createStatus: 403, createBody: "app_key_grant_refused" });
    const plan = planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: NETWORK });
    const failure = await encryptAddressedShareContent({ plan, keys, plaintext: new Uint8Array(1) }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure).toMatchObject({ code: "key-not-authorized" });
    expect(failure?.message).toContain("first-party TinyCloud origin");
  });

  it("a v1 envelope (what encryptToNetwork with a keyPath returns) is refused: it is wrapped to the network, not the key", async () => {
    const { plan, encrypted } = await encryptAndBind();
    const v1 = { ...encrypted.envelope, v: 1 };
    expect(() => bindPathBoundContentSource({ plan, envelope: v1, storedBytes: pathBoundStoredBytes(v1), kvResource: `${SPACE}/kv/${PATH}`, selector: "exact" })).toThrow(expect.objectContaining({ code: "envelope-invalid" }));
  });

  it("an envelope for another key path or network, a wrong key hash and a non-base64 key are refused", async () => {
    const { plan, encrypted } = await encryptAndBind();
    const attempt = (envelope: typeof encrypted.envelope) => () => bindPathBoundContentSource({ plan, envelope, storedBytes: pathBoundStoredBytes(envelope), kvResource: `${SPACE}/kv/${PATH}`, selector: "exact" });
    expect(attempt({ ...encrypted.envelope, keyPath: "share/someothershare0000001" })).toThrow(expect.objectContaining({ code: "key-path-mismatch" }));
    expect(attempt({ ...encrypted.envelope, networkId: NETWORK.replace(":default", ":other") })).toThrow(expect.objectContaining({ code: "key-path-mismatch" }));
    expect(attempt({ ...encrypted.envelope, encryptedSymmetricKeyHash: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "envelope-invalid" }));
    expect(attempt({ ...encrypted.envelope, encryptedSymmetricKey: "not*base64" })).toThrow(expect.objectContaining({ code: "envelope-invalid" }));
  });

  it("bytes that are not the canonical envelope are refused: upload pathBoundStoredBytes(envelope), nothing else", async () => {
    const { plan, encrypted } = await encryptAndBind();
    const tampered = Uint8Array.from(encrypted.storedBytes);
    tampered[tampered.length - 2] ^= 1;
    expect(() => bindPathBoundContentSource({ plan, envelope: encrypted.envelope, storedBytes: tampered, kvResource: `${SPACE}/kv/${PATH}`, selector: "exact" })).toThrow(expect.objectContaining({ code: "stored-bytes-mismatch" }));
  });

  it("an owner session without key.create is reported as key-not-authorized, naming the capability and the key, and nothing is encrypted", async () => {
    // The exact message a node answers when the owner session holds no key.create on the share's key (observed in production).
    const nodeMessage = `Unauthorized Action: ${NETWORK}/share/${SHARE_ID} / tinycloud.encryption/key.create`;
    const { keys, requests } = realKeys({ createStatus: 401, createBody: nodeMessage });
    const plan = planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: NETWORK });
    const failure = await encryptAddressedShareContent({ plan, keys, plaintext: new TextEncoder().encode("x") }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure).toMatchObject({ name: "AddressedContentSourceError", code: "key-not-authorized" });
    expect(failure?.message).toContain("tinycloud.encryption/key.create");
    expect(failure?.message).toContain(`${NETWORK}/share/${SHARE_ID}`);
    expect(failure?.message).toContain("Unauthorized Action:");
    expect(failure?.message).toContain("requestPermissions");
    expect(failure?.message).not.toContain("OpenKey");
    expect(requests.filter((request) => request.method === "GET" && request.url.includes("/keys/"))).toEqual([]);
  });
});
