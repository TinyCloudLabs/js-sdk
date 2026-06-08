/**
 * Encryption-module focused tests.
 *
 * Covers (per task scope):
 * - networkId parsing
 * - capability/manifest expansion handled separately in sdk-core tests
 * - receiver-key derivation (random + signed)
 * - canonical decrypt-request signing & body hashing
 * - encrypted-key hash binding inside envelopes
 * - networkId-as-resource invocation construction (NOT space-shaped)
 * - target-node audience binding
 * - bodyHash binding (mismatch → rejected)
 * - one-of-one unwrap round-trip through a mock node
 * - response signature verification
 */

import { describe, expect, it } from "bun:test";

import {
  base64Decode,
  base64Encode,
  buildCanonicalDecryptRequest,
  buildDecryptAttenuation,
  buildDecryptFacts,
  buildDecryptInvocation,
  buildNetworkId,
  canonicalHashHex,
  canonicalize,
  canonicalSignedResponse,
  checkDecryptInvocationInput,
  decryptEnvelopeWithKey,
  DEFAULT_ENCRYPTION_ALG,
  DEFAULT_KEY_VERSION,
  DECRYPT_ACTION,
  DECRYPT_FACT_TYPE,
  DECRYPT_RESULT_TYPE,
  deriveSignedReceiverKey,
  discoverNetwork,
  encryptToNetwork,
  ENCRYPTION_NETWORK_URN_PREFIX,
  ENCRYPTION_SERVICE,
  ensureNetworkUsableForDecrypt,
  EncryptionService,
  ENVELOPE_VERSION,
  generateRandomReceiverKey,
  hexEncode,
  isNetworkId,
  networkDiscoveryKey,
  openWrappedKey,
  parseNetworkId,
  utf8Encode,
  validateEnvelope,
  verifyDecryptResponse,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type DecryptTransport,
  type EncryptionCrypto,
  type InlineEncryptedEnvelope,
  type NetworkDescriptor,
  type NodeDescriptorFetcher,
  type ReceiverKeyPair,
  type WellKnownDescriptorFetcher,
} from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER_DID = "did:key:z6MkfPN4DefaultPrincipalAaaaaaaaaaaaaaaaaaaaaaaaa";
const NETWORK_NAME = "default";
const NETWORK_ID = `${ENCRYPTION_NETWORK_URN_PREFIX}${OWNER_DID}:${NETWORK_NAME}`;
const TARGET_NODE = "did:key:z6MkrfTargetNodeBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// In-memory crypto used across all tests.
//
// The "ciphers" here are XOR streams; they are NOT secure but satisfy the
// algebraic identity `decrypt(key, encrypt(key, m)) === m` so the binding
// checks under test exercise the right paths without needing a real WASM
// build.
// ---------------------------------------------------------------------------

function deterministicSha256(bytes: Uint8Array): Uint8Array {
  // Deterministic, non-cryptographic 32-byte digest sufficient for binding
  // checks. We mix in a constant so distinct messages produce distinct hashes
  // with overwhelming probability across the test inputs.
  const out = new Uint8Array(32);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  for (let i = 0; i < bytes.length; i++) {
    h0 = ((h0 + bytes[i] * 31) ^ ((h0 << 5) | (h0 >>> 27))) >>> 0;
    h1 = ((h1 ^ (bytes[i] + 17)) + ((h1 << 7) | (h1 >>> 25))) >>> 0;
  }
  for (let i = 0; i < 16; i++) {
    out[i] = (h0 >>> ((i % 4) * 8)) & 0xff;
    out[i + 16] = (h1 >>> ((i % 4) * 8)) & 0xff;
    h0 = (h0 * 1103515245 + 12345) >>> 0;
    h1 = (h1 * 1664525 + 1013904223) >>> 0;
  }
  return out;
}

let _rngSeed = 0xdeadbeef;
function deterministicRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    _rngSeed = (_rngSeed * 1664525 + 1013904223) >>> 0;
    out[i] = _rngSeed & 0xff;
  }
  return out;
}

function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}

function makeCrypto(overrides: Partial<EncryptionCrypto> = {}): EncryptionCrypto {
  return {
    sha256: deterministicSha256,
    randomBytes: deterministicRandom,
    x25519FromSeed: (seed) => ({
      publicKey: deterministicSha256(seed),
      privateKey: seed,
    }),
    x25519Dh: (priv, pub) => deterministicSha256(xor(priv, pub)),
    authEncrypt: (key, plaintext, aad) => {
      const mixedKey = aad === undefined ? key : deterministicSha256(xor(key, aad));
      return xor(mixedKey, plaintext);
    },
    authDecrypt: (key, ciphertext, aad) => {
      const mixedKey = aad === undefined ? key : deterministicSha256(xor(key, aad));
      return xor(mixedKey, ciphertext);
    },
    sealToNetworkKey: (pub, sym) => xor(pub, sym),
    openWithReceiverKey: (priv, wrapped) => xor(priv, wrapped),
    verifyNodeSignature: () => true,
    ...overrides,
  };
}

// Reset the deterministic RNG between scenarios that depend on receiver-key
// equality across calls (e.g. encrypt-then-decrypt round trips).
function resetRng() {
  _rngSeed = 0xdeadbeef;
}

// ---------------------------------------------------------------------------
// networkId parsing
// ---------------------------------------------------------------------------

describe("networkId", () => {
  it("parses a valid urn into ownerDid + name", () => {
    const parsed = parseNetworkId(NETWORK_ID);
    expect(parsed.networkId).toBe(NETWORK_ID);
    expect(parsed.ownerDid).toBe(OWNER_DID);
    expect(parsed.name).toBe(NETWORK_NAME);
  });

  it("rejects non-URN inputs", () => {
    expect(() => parseNetworkId("did:key:z6Mk...")).toThrow();
    expect(() => parseNetworkId(`${OWNER_DID}:${NETWORK_NAME}`)).toThrow();
  });

  it("rejects malformed ownerDid segments", () => {
    expect(() =>
      parseNetworkId(`${ENCRYPTION_NETWORK_URN_PREFIX}notadid:default`),
    ).toThrow();
  });

  it("rejects names that violate the label regex", () => {
    expect(() =>
      parseNetworkId(`${ENCRYPTION_NETWORK_URN_PREFIX}${OWNER_DID}:Default`),
    ).toThrow();
    expect(() =>
      parseNetworkId(`${ENCRYPTION_NETWORK_URN_PREFIX}${OWNER_DID}:-bad`),
    ).toThrow();
  });

  it("round-trips through buildNetworkId", () => {
    const built = buildNetworkId(OWNER_DID, NETWORK_NAME);
    expect(built).toBe(NETWORK_ID);
    expect(isNetworkId(built)).toBe(true);
    expect(isNetworkId("not-a-network")).toBe(false);
  });

  it("exposes a stable well-known discovery key", () => {
    expect(networkDiscoveryKey(NETWORK_NAME)).toBe(
      ".well-known/encryption/network/default",
    );
  });
});

// ---------------------------------------------------------------------------
// Receiver-key derivation
// ---------------------------------------------------------------------------

describe("receiver keys", () => {
  it("generates random receiver key pairs without a signer", () => {
    const crypto = makeCrypto();
    resetRng();
    const a = generateRandomReceiverKey({ crypto });
    const b = generateRandomReceiverKey({ crypto });
    expect(a.publicKey.length).toBe(32);
    expect(b.publicKey.length).toBe(32);
    // Different draws ⇒ different keys.
    expect(hexEncode(a.publicKey)).not.toBe(hexEncode(b.publicKey));
  });

  it("derives deterministic receiver keys from a signer signature", async () => {
    const crypto = makeCrypto();
    const signer = {
      signMessage: async (msg: string) => `sig:${msg}`,
    };
    const a = await deriveSignedReceiverKey({
      crypto,
      signer,
      networkId: NETWORK_ID,
      context: "nonce-1",
    });
    const b = await deriveSignedReceiverKey({
      crypto,
      signer,
      networkId: NETWORK_ID,
      context: "nonce-1",
    });
    const c = await deriveSignedReceiverKey({
      crypto,
      signer,
      networkId: NETWORK_ID,
      context: "nonce-2",
    });
    expect(hexEncode(a.publicKey)).toBe(hexEncode(b.publicKey));
    expect(hexEncode(a.publicKey)).not.toBe(hexEncode(c.publicKey));
  });
});

// ---------------------------------------------------------------------------
// Envelope hash binding
// ---------------------------------------------------------------------------

describe("envelope binding", () => {
  it("computes encryptedSymmetricKeyHash deterministically", () => {
    const crypto = makeCrypto();
    resetRng();
    const networkPublicKey = new Uint8Array(32).fill(7);
    const { envelope } = encryptToNetwork(crypto, {
      networkId: NETWORK_ID,
      networkPublicKey,
      plaintext: utf8Encode("payload"),
    });
    expect(envelope.encryptedSymmetricKeyHash).toBe(
      canonicalHashHex(crypto.sha256, envelope.encryptedSymmetricKey),
    );
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(envelope.alg).toBe(DEFAULT_ENCRYPTION_ALG);
    expect(envelope.keyVersion).toBe(DEFAULT_KEY_VERSION);
    expect(envelope.networkId).toBe(NETWORK_ID);
  });

  it("validateEnvelope rejects a tampered hash", () => {
    const crypto = makeCrypto();
    resetRng();
    const { envelope } = encryptToNetwork(crypto, {
      networkId: NETWORK_ID,
      networkPublicKey: new Uint8Array(32).fill(3),
      plaintext: utf8Encode("hi"),
    });
    const tampered = {
      ...envelope,
      encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash.replace(
        /.$/,
        (c) => (c === "0" ? "1" : "0"),
      ),
    };
    const result = validateEnvelope(crypto, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ENVELOPE");
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical decrypt-request body + hashes
// ---------------------------------------------------------------------------

describe("canonical decrypt request", () => {
  function makeBody(): DecryptRequestBody {
    return {
      type: DECRYPT_FACT_TYPE,
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      encryptedSymmetricKey: "AQID",
      encryptedSymmetricKeyHash: "deadbeef",
      receiverPublicKey: "BAUG",
      receiverPublicKeyHash: "cafebabe",
    };
  }

  it("canonicalizes by sorting keys", () => {
    const body = makeBody();
    const a = canonicalize(body as any);
    const b = canonicalize({
      receiverPublicKeyHash: body.receiverPublicKeyHash,
      receiverPublicKey: body.receiverPublicKey,
      networkId: body.networkId,
      alg: body.alg,
      keyVersion: body.keyVersion,
      type: body.type,
      targetNode: body.targetNode,
      encryptedSymmetricKey: body.encryptedSymmetricKey,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
    } as any);
    expect(a).toBe(b);
  });

  it("bodyHash changes when ANY input field changes", () => {
    const crypto = makeCrypto();
    const base = makeBody();
    const baseHash = buildCanonicalDecryptRequest({
      crypto,
      body: base,
      receiverPublicKey: new Uint8Array([4, 5, 6]),
    }).bodyHash;
    const fields: Array<keyof DecryptRequestBody> = [
      "targetNode",
      "networkId",
      "alg",
      "keyVersion",
      "encryptedSymmetricKey",
      "encryptedSymmetricKeyHash",
      "receiverPublicKey",
      "receiverPublicKeyHash",
    ];
    for (const f of fields) {
      const mutated: DecryptRequestBody = { ...base };
      if (typeof mutated[f] === "number") {
        (mutated as any)[f] = ((mutated[f] as number) + 1);
      } else {
        (mutated as any)[f] = `${mutated[f] as string}-changed`;
      }
      const h = buildCanonicalDecryptRequest({
        crypto,
        body: mutated,
        receiverPublicKey: new Uint8Array([4, 5, 6]),
      }).bodyHash;
      expect(h).not.toBe(baseHash);
    }
  });
});

// ---------------------------------------------------------------------------
// Decrypt invocation builder — networkId as resource, target node binding
// ---------------------------------------------------------------------------

describe("decrypt invocation builder", () => {
  function buildBaseBody(crypto: EncryptionCrypto): DecryptRequestBody {
    const encryptedSymmetricKey = "AQID";
    const receiverPublicKey = "BAUG";
    return {
      type: DECRYPT_FACT_TYPE,
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      encryptedSymmetricKey,
      encryptedSymmetricKeyHash: canonicalHashHex(
        crypto.sha256,
        encryptedSymmetricKey,
      ),
      receiverPublicKey,
      receiverPublicKeyHash: canonicalHashHex(
        crypto.sha256,
        receiverPublicKey,
      ),
    };
  }

  it("uses the networkId URN as the attenuation resource key (NOT a space)", () => {
    const att = buildDecryptAttenuation(NETWORK_ID);
    expect(Object.keys(att)).toEqual([NETWORK_ID]);
    expect(att[NETWORK_ID]).toEqual({
      [DECRYPT_ACTION]: {},
    });
    expect(NETWORK_ID.startsWith("urn:tinycloud:encryption:")).toBe(true);
  });

  it("rejects attenuation for a non-network resource", () => {
    expect(() => buildDecryptAttenuation("tinycloud:pkh:eip155:1:0xabc:default"))
      .toThrow();
  });

  it("buildDecryptFacts binds bodyHash and key hashes", () => {
    const crypto = makeCrypto();
    const body = buildBaseBody(crypto);
    const receiverPublicKey = new Uint8Array([4, 5, 6]);
    const canonical = buildCanonicalDecryptRequest({
      crypto,
      body,
      receiverPublicKey,
    });
    const facts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
      receiverPublicKey,
      canonicalBody: canonical.canonicalBody,
    });
    expect(facts.type).toBe(DECRYPT_FACT_TYPE);
    expect(facts.targetNode).toBe(TARGET_NODE);
    expect(facts.networkId).toBe(NETWORK_ID);
    expect(facts.bodyHash).toBe(canonical.bodyHash);
    expect(facts.receiverPublicKeyHash).toBe(canonical.receiverPublicKeyHash);
    expect(facts.encryptedSymmetricKeyHash).toBe(body.encryptedSymmetricKeyHash);
    expect(facts.alg).toBe(body.alg);
    expect(facts.keyVersion).toBe(body.keyVersion);
  });

  it("checkDecryptInvocationInput rejects audience drift (facts.targetNode != audience)", () => {
    const crypto = makeCrypto();
    const body = buildBaseBody(crypto);
    const receiverPublicKey = new Uint8Array([4, 5, 6]);
    const canonical = buildCanonicalDecryptRequest({ crypto, body, receiverPublicKey });
    const facts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
      receiverPublicKey,
      canonicalBody: canonical.canonicalBody,
    });
    const result = checkDecryptInvocationInput(crypto, {
      targetNode: "did:key:z6MkOtherNode",
      networkId: NETWORK_ID,
      body,
      facts,
      proof: { proofs: ["bafy..."] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toMatch(/targetNode/);
    }
  });

  it("checkDecryptInvocationInput rejects mismatched bodyHash", () => {
    const crypto = makeCrypto();
    const body = buildBaseBody(crypto);
    const receiverPublicKey = new Uint8Array([4, 5, 6]);
    const facts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
      receiverPublicKey,
    });
    const tampered = { ...facts, bodyHash: "00".repeat(32) };
    const result = checkDecryptInvocationInput(crypto, {
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      body,
      facts: tampered,
      proof: { proofs: ["bafy..."] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/bodyHash/);
    }
  });

  it("buildDecryptInvocation delegates to the signer when input is well-formed", async () => {
    const crypto = makeCrypto();
    const body = buildBaseBody(crypto);
    const receiverPublicKey = new Uint8Array([4, 5, 6]);
    const canonical = buildCanonicalDecryptRequest({
      crypto,
      body,
      receiverPublicKey,
    });
    const facts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
      receiverPublicKey,
      canonicalBody: canonical.canonicalBody,
    });
    let signerInput: unknown;
    const signer = {
      signDecryptInvocation: async (input: any) => {
        signerInput = input;
        return {
          authorization: "Invocation eyJxxx",
          invocationCid: "bafyDecryptInvocationCid",
          canonicalBody: canonical.canonicalBody,
        };
      },
    };
    const built = await buildDecryptInvocation(crypto, signer, {
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      body,
      facts,
      proof: { proofs: ["bafyParent"] },
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.data.invocationCid).toBe("bafyDecryptInvocationCid");
      expect(built.data.authorization.startsWith("Invocation ")).toBe(true);
    }
    expect((signerInput as any).targetNode).toBe(TARGET_NODE);
  });

  it("buildDecryptInvocation rejects a signer that returns a divergent canonical body", async () => {
    const crypto = makeCrypto();
    const body = buildBaseBody(crypto);
    const receiverPublicKey = new Uint8Array([4, 5, 6]);
    const canonical = buildCanonicalDecryptRequest({ crypto, body, receiverPublicKey });
    const facts = buildDecryptFacts({
      crypto,
      body,
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
      receiverPublicKey,
      canonicalBody: canonical.canonicalBody,
    });
    const signer = {
      signDecryptInvocation: async () => ({
        authorization: "Invocation tampered",
        invocationCid: "bafy",
        canonicalBody: '{"tampered":true}',
      }),
    };
    const built = await buildDecryptInvocation(crypto, signer, {
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      body,
      facts,
      proof: { proofs: [] },
    });
    expect(built.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Response signature + binding verification
// ---------------------------------------------------------------------------

describe("decrypt response verification", () => {
  function fullRequest(crypto: EncryptionCrypto): DecryptRequestBody {
    const encryptedSymmetricKey = "AQID";
    const receiverPublicKey = "BAUG";
    return {
      type: DECRYPT_FACT_TYPE,
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      encryptedSymmetricKey,
      encryptedSymmetricKeyHash: canonicalHashHex(
        crypto.sha256,
        encryptedSymmetricKey,
      ),
      receiverPublicKey,
      receiverPublicKeyHash: canonicalHashHex(
        crypto.sha256,
        receiverPublicKey,
      ),
    };
  }

  function makeResponse(crypto: EncryptionCrypto, request: DecryptRequestBody, invocationCid: string): {
    response: DecryptResponseBody;
    requestBodyHash: string;
  } {
    const requestBodyHash = canonicalHashHex(crypto.sha256, request as any);
    const requestHash = hexEncode(
      crypto.sha256(utf8Encode(`${invocationCid}${requestBodyHash}`)),
    );
    const response: DecryptResponseBody = {
      type: DECRYPT_RESULT_TYPE,
      targetNode: request.targetNode,
      networkId: request.networkId,
      invocationCid,
      encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
      receiverPublicKeyHash: request.receiverPublicKeyHash,
      wrappedKey: "Zm9v",
      alg: request.alg,
      keyVersion: request.keyVersion,
      requestHash,
      nodeId: TARGET_NODE,
      nodeSignature: base64Encode(new Uint8Array(64).fill(9)),
    };
    return { response, requestBodyHash };
  }

  it("accepts a well-formed response", () => {
    const crypto = makeCrypto();
    const request = fullRequest(crypto);
    const { response, requestBodyHash } = makeResponse(crypto, request, "bafyINV");
    const facts = buildDecryptFacts({
      crypto,
      body: request,
      encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
      receiverPublicKey: new Uint8Array([4, 5, 6]),
    });
    const result = verifyDecryptResponse({
      crypto,
      request,
      facts,
      invocationCid: "bafyINV",
      requestBodyHash,
      response,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a response with a mismatched encryptedSymmetricKeyHash", () => {
    const crypto = makeCrypto();
    const request = fullRequest(crypto);
    const { response, requestBodyHash } = makeResponse(crypto, request, "bafyINV");
    const facts = buildDecryptFacts({
      crypto,
      body: request,
      encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
      receiverPublicKey: new Uint8Array([4, 5, 6]),
    });
    response.encryptedSymmetricKeyHash = "tampered";
    const result = verifyDecryptResponse({
      crypto,
      request,
      facts,
      invocationCid: "bafyINV",
      requestBodyHash,
      response,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RESPONSE_BINDING_MISMATCH");
    }
  });

  it("rejects a response with an invalid node signature", () => {
    const crypto = makeCrypto({
      verifyNodeSignature: () => false,
    });
    const request = fullRequest(crypto);
    const { response, requestBodyHash } = makeResponse(crypto, request, "bafyINV");
    const facts = buildDecryptFacts({
      crypto,
      body: request,
      encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
      receiverPublicKey: new Uint8Array([4, 5, 6]),
    });
    const result = verifyDecryptResponse({
      crypto,
      request,
      facts,
      invocationCid: "bafyINV",
      requestBodyHash,
      response,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RESPONSE_SIGNATURE_INVALID");
    }
  });

  it("rejects a response whose nodeId does not match the target node", () => {
    const crypto = makeCrypto();
    const request = fullRequest(crypto);
    const { response, requestBodyHash } = makeResponse(crypto, request, "bafyINV");
    const facts = buildDecryptFacts({
      crypto,
      body: request,
      encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
      receiverPublicKey: new Uint8Array([4, 5, 6]),
    });
    response.nodeId = "did:key:z6MkOtherNode";
    const result = verifyDecryptResponse({
      crypto,
      request,
      facts,
      invocationCid: "bafyINV",
      requestBodyHash,
      response,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RESPONSE_BINDING_MISMATCH");
      expect(result.error.field).toBe("nodeId");
    }
  });

  it("canonicalSignedResponse excludes the signature field", () => {
    const crypto = makeCrypto();
    const request = fullRequest(crypto);
    const { response } = makeResponse(crypto, request, "bafyINV");
    const canonical = canonicalSignedResponse(response);
    expect(canonical.includes("nodeSignature")).toBe(false);
  });

  it("openWrappedKey reverses the receiver-key sealing", () => {
    const crypto = makeCrypto();
    const priv = new Uint8Array(32).fill(2);
    const sym = new Uint8Array(32).fill(5);
    const wrapped = xor(priv, sym); // same construction as crypto.openWithReceiverKey
    const opened = openWrappedKey(crypto, priv, {
      type: DECRYPT_RESULT_TYPE,
      targetNode: TARGET_NODE,
      networkId: NETWORK_ID,
      invocationCid: "x",
      encryptedSymmetricKeyHash: "x",
      receiverPublicKeyHash: "x",
      wrappedKey: base64Encode(wrapped),
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: 1,
      requestHash: "x",
      nodeId: TARGET_NODE,
      nodeSignature: "x",
    });
    expect(hexEncode(opened)).toBe(hexEncode(sym));
  });
});

// ---------------------------------------------------------------------------
// Discovery — node-first, well-known fallback
// ---------------------------------------------------------------------------

describe("discoverNetwork", () => {
  function makeDescriptor(state: NetworkDescriptor["state"] = "active"): NetworkDescriptor {
    return {
      networkId: NETWORK_ID,
      ownerDid: OWNER_DID,
      name: NETWORK_NAME,
      members: [{ nodeId: TARGET_NODE, role: "primary" }],
      threshold: { n: 1, t: 1 },
      state,
      publicEncryptionKey: base64Encode(new Uint8Array(32).fill(11)),
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      keyBackend: "local-one-of-one",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("prefers the node-authoritative descriptor", async () => {
    const node: NodeDescriptorFetcher = {
      fetchByNetworkId: async () => makeDescriptor(),
    };
    const wk: WellKnownDescriptorFetcher = {
      fetchWellKnown: async () => null,
    };
    const result = await discoverNetwork({
      identifier: NETWORK_ID,
      node,
      wellKnown: wk,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe("node");
    }
  });

  it("falls back to .well-known on node failure", async () => {
    const node: NodeDescriptorFetcher = {
      fetchByNetworkId: async () => {
        throw new Error("network unreachable");
      },
    };
    const wk: WellKnownDescriptorFetcher = {
      fetchWellKnown: async () => makeDescriptor(),
    };
    const result = await discoverNetwork({
      identifier: NETWORK_ID,
      node,
      wellKnown: wk,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe("well-known");
    }
  });

  it("rejects descriptors whose embedded ids drift from the URN", async () => {
    const node: NodeDescriptorFetcher = {
      fetchByNetworkId: async () => ({
        ...makeDescriptor(),
        ownerDid: "did:key:z6MkOther",
      }),
    };
    const result = await discoverNetwork({ identifier: NETWORK_ID, node });
    expect(result.ok).toBe(false);
  });

  it("ensureNetworkUsableForDecrypt rejects revoked networks", () => {
    const revoked = makeDescriptor("revoked");
    const result = ensureNetworkUsableForDecrypt(revoked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_NOT_ACTIVE");
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end one-of-one unwrap through a mock node
// ---------------------------------------------------------------------------

describe("EncryptionService one-of-one round trip", () => {
  function makeDescriptor(): NetworkDescriptor {
    return {
      networkId: NETWORK_ID,
      ownerDid: OWNER_DID,
      name: NETWORK_NAME,
      members: [{ nodeId: TARGET_NODE, role: "primary" }],
      threshold: { n: 1, t: 1 },
      state: "active",
      publicEncryptionKey: base64Encode(new Uint8Array(32).fill(11)),
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      keyBackend: "local-one-of-one",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("encrypts locally, decrypts through the mock node, returns original plaintext", async () => {
    const crypto = makeCrypto();
    const descriptor = makeDescriptor();
    const networkPublicKey = base64Decode(descriptor.publicEncryptionKey);

    // The mock node has access to the network's private key (in real life
    // this would never leave the node). For the test we use the same XOR
    // construction as `sealToNetworkKey`, which means "unwrap" is just
    // re-XORing with the network public key (treating it as the secret).
    const networkPrivateKey = networkPublicKey;

    let capturedInvocationCid = "";
    let capturedBody: DecryptRequestBody | null = null;
    const transport: DecryptTransport = {
      postDecrypt: async ({ authorization, canonicalBody }) => {
        expect(authorization.startsWith("Invocation ")).toBe(true);
        const body = JSON.parse(canonicalBody) as DecryptRequestBody;
        capturedBody = body;
        // Unwrap the symmetric key locally (simulating the node).
        const wrappedSym = base64Decode(body.encryptedSymmetricKey);
        const symmetricKey = xor(networkPrivateKey, wrappedSym);
        // Rewrap to the per-request receiver public key.
        const receiverPub = base64Decode(body.receiverPublicKey);
        const rewrapped = xor(receiverPub, symmetricKey);
        const invocationCid = capturedInvocationCid;
        const requestBodyHash = canonicalHashHex(crypto.sha256, body as any);
        return {
          type: DECRYPT_RESULT_TYPE,
          targetNode: body.targetNode,
          networkId: body.networkId,
          invocationCid,
          encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash,
          receiverPublicKeyHash: body.receiverPublicKeyHash,
          wrappedKey: base64Encode(rewrapped),
          alg: body.alg,
          keyVersion: body.keyVersion,
          requestHash: hexEncode(
            crypto.sha256(utf8Encode(`${invocationCid}${requestBodyHash}`)),
          ),
          nodeId: TARGET_NODE,
          nodeSignature: base64Encode(new Uint8Array(64)),
        };
      },
    };

    // Receiver key in this XOR construction must be set such that
    // openWithReceiverKey reverses the rewrap. Our crypto stub does
    // `openWithReceiverKey(priv, wrapped) = xor(priv, wrapped)` and
    // x25519FromSeed sets `privateKey = seed`. We set sealToNetworkKey
    // identically. Choose receiver private key = receiver public key
    // for symmetric XOR semantics; that means x25519FromSeed must
    // return publicKey == privateKey for our test seed. Adjust the
    // stub so we can satisfy the round-trip identity.
    const e2eCrypto = makeCrypto({
      x25519FromSeed: (seed) => ({
        publicKey: seed,
        privateKey: seed,
      }),
    });

    const signer = {
      signDecryptInvocation: async (input: any) => {
        capturedInvocationCid = `bafy:${input.facts.bodyHash.slice(0, 8)}`;
        return {
          authorization: "Invocation stub",
          invocationCid: capturedInvocationCid,
          canonicalBody: canonicalize(input.body),
        };
      },
    };

    const service = new EncryptionService({
      crypto: e2eCrypto,
      signer,
      transport,
      node: { fetchByNetworkId: async () => descriptor },
    });

    const plaintext = utf8Encode("hello tinycloud encryption");
    const encryptResult = await service.encryptToNetwork(NETWORK_ID, plaintext);
    expect(encryptResult.ok).toBe(true);
    if (!encryptResult.ok) return;
    const envelope = encryptResult.data;

    const decryptResult = await service.decryptEnvelope(envelope, {
      proofs: ["bafyDelegationFromPrincipal"],
    });
    expect(decryptResult.ok).toBe(true);
    if (!decryptResult.ok) return;
    expect(new TextDecoder().decode(decryptResult.data)).toBe(
      "hello tinycloud encryption",
    );
    // Sanity: the body sent to the node carried the networkId resource,
    // not a space path.
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.networkId).toBe(NETWORK_ID);
    expect(capturedBody!.targetNode).toBe(TARGET_NODE);
  });

  it("decrypt fails fast on a revoked network", async () => {
    const crypto = makeCrypto();
    const descriptor: NetworkDescriptor = {
      ...{
        networkId: NETWORK_ID,
        ownerDid: OWNER_DID,
        name: NETWORK_NAME,
        members: [{ nodeId: TARGET_NODE, role: "primary" as const }],
        threshold: { n: 1, t: 1 },
        state: "revoked" as const,
        publicEncryptionKey: base64Encode(new Uint8Array(32).fill(11)),
        alg: DEFAULT_ENCRYPTION_ALG,
        keyVersion: DEFAULT_KEY_VERSION,
        keyBackend: "local-one-of-one" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    const service = new EncryptionService({
      crypto,
      signer: {
        signDecryptInvocation: async () => {
          throw new Error("should not reach signer for revoked network");
        },
      },
      transport: {
        postDecrypt: async () => {
          throw new Error("should not reach transport for revoked network");
        },
      },
      node: { fetchByNetworkId: async () => descriptor },
    });
    const envelope: InlineEncryptedEnvelope = {
      v: ENVELOPE_VERSION,
      networkId: NETWORK_ID,
      alg: DEFAULT_ENCRYPTION_ALG,
      keyVersion: DEFAULT_KEY_VERSION,
      encryptedSymmetricKey: "AAAA",
      encryptedSymmetricKeyHash: canonicalHashHex(crypto.sha256, "AAAA"),
      ciphertext: "BBBB",
    };
    const result = await service.decryptEnvelope(envelope, { proofs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_NOT_ACTIVE");
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity: ENCRYPTION_SERVICE constants line up with manifest expectations
// ---------------------------------------------------------------------------

describe("encryption service constants", () => {
  it("uses the canonical service identifiers", () => {
    expect(ENCRYPTION_SERVICE).toBe("tinycloud.encryption");
    expect(DECRYPT_ACTION).toBe("tinycloud.encryption/decrypt");
  });
});
