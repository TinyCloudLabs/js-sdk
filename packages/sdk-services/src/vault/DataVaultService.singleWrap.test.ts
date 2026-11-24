import { describe, expect, test } from "bun:test";

import { ServiceContext } from "../context";
import { base64Decode, base64Encode, hexEncode, utf8Encode } from "../encryption/canonical";
import { NamedKeyClient } from "../encryption/namedKeys";
import { DECRYPT_RESULT_TYPE, type EncryptionCrypto } from "../encryption/types";
import { DataVaultService } from "./DataVaultService";

// TC-3801: a v2 secret is sealed to its own key only. One wrap, to the named
// key's public key; no second wrap to the network root key, which would let a
// whole-network decrypt open it. Real NamedKeyClient over a stub node and an
// XOR stand-in for X25519 (a wrap is xor(recipient public key, content key)).

const SPACE_ID = "tinycloud:pkh:eip155:1:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed:secrets";
const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default";
const HOST = "https://node.test";
const NODE = "did:key:z6MkNodeUnderTest";
const KEY_PATH = "secrets/api_key";
const KEY_PUB = new Uint8Array(32).fill(7);
const ROOT_PUB = new Uint8Array(32).fill(3);
const KEYS_URL = `${HOST}/encryption/networks/${NETWORK_ID}/keys`;

const xor = (key: Uint8Array, data: Uint8Array) => data.map((b, i) => b ^ key[i % key.length]!);
const sha256 = (bytes: Uint8Array) => {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  for (let i = 0; i < 32; i++) out[i] = (h = Math.imul(h ^ i, 0x01000193) >>> 0) & 0xff;
  return out;
};
let rng = 1;
const crypto: EncryptionCrypto = {
  sha256,
  randomBytes: (n) => new Uint8Array(n).map(() => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) & 0xff),
  x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
  x25519Dh: (a, b) => xor(a, b),
  authEncrypt: (key, plaintext) => xor(key, plaintext),
  authDecrypt: (key, ciphertext) => xor(key, ciphertext),
  sealToNetworkKey: (pub, sym) => xor(pub, sym),
  openWithReceiverKey: (priv, wrapped) => xor(priv, wrapped),
  verifyNodeSignature: () => true,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function harness() {
  const records = new Map<string, string>();
  const calls = { networkEncrypt: 0, networkDecrypt: 0 };
  // Stub node: opens a wrap only with the named key's secret (here its public bytes).
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${HOST}/info`) return json({ nodeId: NODE, features: ["encryption-named-keys-v1"] });
    if (url.startsWith(`${KEYS_URL}/`)) {
      return json({
        networkId: NETWORK_ID, keyPath: url.slice(KEYS_URL.length + 1), alg: "x25519-aes256gcm/v1", keyVersion: 1,
        publicEncryptionKey: base64Encode(KEY_PUB), state: "active", kind: "deletable", createdAt: "t0", updatedAt: "t0",
      });
    }
    if (url === `${HOST}/invoke`) {
      const body = JSON.parse(String(init!.body)) as Record<string, string>;
      const sym = xor(KEY_PUB, base64Decode(body.encryptedSymmetricKey!));
      const invocationCid = `cid${/Bearer (\d+)/.exec((init!.headers as Record<string, string>).Authorization!)![1]}`;
      return json({
        type: DECRYPT_RESULT_TYPE, targetNode: NODE, networkId: body.networkId, invocationCid,
        encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash,
        wrappedKey: base64Encode(xor(base64Decode(body.receiverPublicKey!), sym)), alg: body.alg, keyVersion: body.keyVersion,
        requestHash: hexEncode(sha256(utf8Encode(`${invocationCid}${hexEncode(sha256(utf8Encode(String(init!.body))))}`))),
        nodeId: NODE, nodeSignature: "AA==",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  let signed = 0;
  const client = new NamedKeyClient({
    host: HOST, crypto, fetch: fetchImpl, defaultNetworkId: () => NETWORK_ID,
    signInvocation: async () => ({ authorization: `Bearer ${++signed}`, invocationCid: `cid${signed}` }),
    decryptRoot: async () => {
      throw new Error("a v2 secret never opens through the network root key");
    },
  });
  const kv = {
    get: async (path: string) => records.has(path)
      ? { ok: true, data: { data: records.get(path), headers: { etag: `"${records.get(path)!.length}"` } } }
      : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing", service: "kv" } },
    put: async (path: string, body: string) => {
      records.set(path, body);
      return { ok: true, data: undefined };
    },
  };
  const context = new ServiceContext({ hosts: [HOST], invoke: () => ({}), fetch: (async () => new Response()) as never });
  context.setSession({
    delegationHeader: { Authorization: "a" }, delegationCid: "bafy-delegation", spaceId: SPACE_ID,
    verificationMethod: "did:key:z6MkSession", jwk: {},
  });
  const vault = new DataVaultService({
    spaceId: SPACE_ID,
    encryption: {
      networkId: NETWORK_ID,
      service: {
        encryptToNetwork: async (_networkId: string, plaintext: Uint8Array) => {
          calls.networkEncrypt++;
          const sym = crypto.randomBytes(32);
          const wrap = base64Encode(xor(ROOT_PUB, sym));
          return {
            ok: true,
            data: {
              v: 1, networkId: NETWORK_ID, alg: "x25519-aes256gcm/v1", keyVersion: 1, encryptedSymmetricKey: wrap,
              encryptedSymmetricKeyHash: "00", ciphertext: base64Encode(xor(sym, plaintext)),
            },
          };
        },
        decryptEnvelope: async (e: { encryptedSymmetricKey: string; ciphertext: string }) => {
          calls.networkDecrypt++;
          return { ok: true, data: xor(xor(ROOT_PUB, base64Decode(e.encryptedSymmetricKey)), base64Decode(e.ciphertext)) };
        },
      },
      namedKeys: async () => client,
    },
    tc: { kv, did: "did:key:z6MkPrincipal", address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", chainId: 1, hosts: [HOST] },
  } as never);
  vault.initialize(context);
  const stored = (key: string) => JSON.parse(records.get(`vault/${key}`)!) as Record<string, unknown>;
  return { vault, calls, stored };
}

/** The envelope's one wrap opens with the named key and not with the network root key. */
function expectOneWrapToTheNamedKey(envelope: Record<string, unknown>, plaintext: string) {
  expect(envelope).toMatchObject({ v: 2, keyPath: KEY_PATH, networkId: NETWORK_ID });
  expect(Object.keys(envelope).sort()).toEqual([
    "aad", "alg", "ciphertext", "encryptedSymmetricKey", "encryptedSymmetricKeyHash", "keyPath", "keyVersion", "metadata", "networkId", "v",
  ]);
  const wrap = base64Decode(envelope.encryptedSymmetricKey as string);
  expect(wrap).toHaveLength(32);
  const ciphertext = base64Decode(envelope.ciphertext as string);
  expect(new TextDecoder().decode(xor(xor(KEY_PUB, wrap), ciphertext))).toContain(plaintext);
  expect(new TextDecoder().decode(xor(xor(ROOT_PUB, wrap), ciphertext))).not.toContain(plaintext);
}

describe("a v2 secret carries exactly one wrap, to its own key", () => {
  test("put", async () => {
    const h = harness();
    expect(await h.vault.put("secrets/API_KEY", { value: "put-plaintext" }, { keyPath: KEY_PATH, expectAad: true } as never)).toEqual({ ok: true, data: undefined });
    expectOneWrapToTheNamedKey(h.stored("secrets/API_KEY"), "put-plaintext");
    expect(h.calls.networkEncrypt).toBe(0);
  });

  test("resealToKey", async () => {
    const h = harness();
    expect(await h.vault.put("secrets/API_KEY", { value: "resealed-plaintext" })).toEqual({ ok: true, data: undefined });
    expect(h.stored("secrets/API_KEY")).toMatchObject({ v: 1 });
    expect(await h.vault.resealToKey("secrets/API_KEY", KEY_PATH)).toEqual({ status: "moved" });
    expectOneWrapToTheNamedKey(h.stored("secrets/API_KEY"), "resealed-plaintext");
    expect(h.calls).toEqual({ networkEncrypt: 1, networkDecrypt: 1 });
  });
});
