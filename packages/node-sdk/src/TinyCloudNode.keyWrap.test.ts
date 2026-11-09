import { describe, expect, test } from "bun:test";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { base64Decode } from "../../sdk-services/src/encryption/canonical";
import { decryptColumn, isKeyWrapV2, openKeyV2, sealKeyV2, type KeyWrapContext } from "../../sdk-services/src/encryption/keyWrap";
import type { EncryptionCrypto } from "@tinycloud/sdk-services";
import fixture from "../../sdk-services/src/encryption/fixtures/key-wrap-v2.json";
import { generateKeyPairSync, sign } from "node:crypto";
import { didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import { EncryptionService } from "../../sdk-services/src/encryption/EncryptionService";
import { canonicalSignedResponse } from "../../sdk-services/src/encryption/response";
import { base64Encode, canonicalHashHex, canonicalize, hexEncode, utf8Encode } from "../../sdk-services/src/encryption/canonical";
import { DEFAULT_ENCRYPTION_ALG, DECRYPT_RESULT_TYPE, type DecryptRequestBody, type DecryptResponseBody, type NetworkDescriptor } from "../../sdk-services/src/encryption/types";
import { KEY_WRAP_V2_ALG, readKeyWrapV2 } from "../../sdk-services/src/encryption/keyWrap";
import { NamedKeyClient } from "../../sdk-services/src/encryption/namedKeys";

function adapter(strictEncryption = false): EncryptionCrypto {
  const node = new TinyCloudNode({ strictEncryption, wasmBindings: new NodeWasmBindings() });
  return Reflect.get(node, "createEncryptionCrypto").call(node);
}

describe("real node key wrapping", () => {
  test("opens the legacy fixture with encrypted framing", () => {
    const crypto = adapter();
    const vector = fixture.vectors.find(v => v.version === 1)!;
    expect(crypto.openWithReceiverKey(base64Decode(vector.recipientPrivateKey), base64Decode(vector.wrappedKey)))
      .toEqual(base64Decode(vector.plaintext));
  });

  test("v1 reader requires framing even when strict mode is off", () => {
    const crypto = adapter();
    const receiver = crypto.x25519FromSeed(new Uint8Array(32).fill(3));
    const ephemeral = crypto.x25519FromSeed(new Uint8Array(32).fill(4));
    const unframed = new Uint8Array(64);
    unframed.set(ephemeral.publicKey);
    expect(() => crypto.openWithReceiverKey(receiver.privateKey, unframed)).toThrow();
    expect(() => crypto.openWithReceiverKey(receiver.privateKey, new TextEncoder().encode("TCW2"))).toThrow();
  });

  test("default v1 and opt-in v2 adapters interoperate", () => {
    const crypto = adapter();
    const receiver = crypto.x25519FromSeed(new Uint8Array(32).fill(5));
    const key = new Uint8Array(32).fill(6);
    const context: KeyWrapContext = { purpose: "receiver-key", networkId: "", keyPath: "", keyVersion: 1, metadata: {} };
    const v1 = crypto.sealToNetworkKey(receiver.publicKey, key);
    expect(isKeyWrapV2(v1)).toBe(false);
    expect(crypto.openWithReceiverKey(receiver.privateKey, v1)).toEqual(key);
    const v2 = crypto.sealToNetworkKey(receiver.publicKey, key, { keyWrapV2: true, context });
    expect(openKeyV2(receiver.privateKey, v2, context)).toEqual(key);
    expect(crypto.openWithReceiverKey(receiver.privateKey, sealKeyV2(receiver.publicKey, key, context), context)).toEqual(key);
  });

  test("explicit stored column format preserves marker-prefixed plaintext", () => {
    const wasm = new NodeWasmBindings();
    const key = new Uint8Array(32).fill(9);
    for (const plain of [new Uint8Array([0, 2, 3]), new Uint8Array([1, 2, 3])]) {
      expect(decryptColumn((k, b) => wasm.vault_decrypt(k, b), key, plain, "legacy-plaintext")).toBe(plain);
      expect(() => decryptColumn((k, b) => wasm.vault_decrypt(k, b), key, plain, "legacy-plaintext", true)).toThrow();
      expect(() => decryptColumn((k, b) => wasm.vault_decrypt(k, b), key, plain, "encrypted")).toThrow();
      const encrypted = wasm.vault_encrypt(key, plain);
      const frame = new Uint8Array(1 + encrypted.length); frame[0] = 1; frame.set(encrypted, 1);
      expect(decryptColumn((k, b) => wasm.vault_decrypt(k, b), key, frame, "encrypted", true)).toEqual(plain);
    }
  });
});

describe("service key wrap versions with real crypto", () => {
  const networkId = "urn:tinycloud:encryption:did:key:zTestOwner:default";
  const crypto = adapter();
  const network = crypto.x25519FromSeed(new Uint8Array(32).fill(13));
  const signer = generateKeyPairSync("ed25519");
  const signingPublic = signer.publicKey.export({ format: "jwk" });
  const nodeId = didKeyFromEd25519PublicKey(new Uint8Array(Buffer.from(signingPublic.x!, "base64url")));
  const descriptor: NetworkDescriptor = {
    networkId, ownerDid: "did:key:zTestOwner", name: "default", members: [{ nodeId, role: "primary" }],
    threshold: { n: 1, t: 1 }, state: "active", publicEncryptionKey: base64Encode(network.publicKey),
    alg: DEFAULT_ENCRYPTION_ALG, keyVersion: 1, keyBackend: "local-one-of-one", createdAt: "", updatedAt: "",
  };
  const metadata = { mediaType: "text/plain" };
  const plaintext = utf8Encode("real encryption service round trip");

  function responseFor(body: DecryptRequestBody, responseV2: boolean): DecryptResponseBody {
    const context: KeyWrapContext = { purpose: "network-key", networkId, keyPath: body.keyPath ?? "", keyVersion: 1, metadata };
    const wrapped = base64Decode(body.encryptedSymmetricKey);
    const key = body.alg === KEY_WRAP_V2_ALG
      ? openKeyV2(network.privateKey, wrapped, context)
      : crypto.openWithReceiverKey(network.privateKey, wrapped);
    const receiver = base64Decode(body.receiverPublicKey);
    const receiverContext: KeyWrapContext = { ...context, purpose: "receiver-key", metadata: {} };
    const result: DecryptResponseBody = {
      type: DECRYPT_RESULT_TYPE, targetNode: nodeId, networkId, invocationCid: "invocation-test",
      encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash,
      wrappedKey: base64Encode(responseV2 ? sealKeyV2(receiver, key, receiverContext) : crypto.sealToNetworkKey(receiver, key)),
      alg: responseV2 ? KEY_WRAP_V2_ALG : DEFAULT_ENCRYPTION_ALG, keyVersion: 1,
      requestHash: hexEncode(crypto.sha256(utf8Encode(`invocation-test${canonicalHashHex(crypto.sha256, { ...body })}`))),
      nodeId, nodeSignature: "",
    };
    result.nodeSignature = base64Encode(new Uint8Array(sign(null, Buffer.from(canonicalSignedResponse(result)), signer.privateKey)));
    return result;
  }

  function service(writerV2 = false, responseV2 = false) {
    return new EncryptionService({
      keyWrapV2: writerV2, crypto,
      node: { fetchByNetworkId: async () => descriptor },
      signer: { signDecryptInvocation: async input => ({
        authorization: "test-authorization", invocationCid: "invocation-test", canonicalBody: canonicalize({ ...input.body }),
      }) },
      transport: { postDecrypt: async ({ canonicalBody }) => responseFor(JSON.parse(canonicalBody), responseV2) },
    });
  }

  for (const requestV2 of [false, true]) for (const responseV2 of [false, true]) for (const keyPath of [undefined, "share/test"]) {
    test(`round trips request v${requestV2 ? 2 : 1}, response v${responseV2 ? 2 : 1}, ${keyPath ?? "root"}`, async () => {
      const client = service(requestV2, responseV2);
      const encrypted = await client.encryptToNetwork(networkId, plaintext, { keyPath, metadata });
      expect(encrypted.ok).toBe(true);
      if (!encrypted.ok) throw encrypted.error;
      expect(encrypted.data.v).toBe(1);
      expect(encrypted.data.alg).toBe(requestV2 ? KEY_WRAP_V2_ALG : DEFAULT_ENCRYPTION_ALG);
      expect(isKeyWrapV2(base64Decode(encrypted.data.encryptedSymmetricKey))).toBe(requestV2);
      const result = await client.decryptEnvelope(encrypted.data, { proofs: ["test-proof"] });
      expect(result).toEqual({ ok: true, data: plaintext });
    });
  }

  test("defaults to v1 and lets each call opt in or out", async () => {
    const defaultWriter = service();
    const defaultResult = await defaultWriter.encryptToNetwork(networkId, plaintext);
    const optIn = await defaultWriter.encryptToNetwork(networkId, plaintext, { keyWrapV2: true });
    const optOut = await service(true).encryptToNetwork(networkId, plaintext, { keyWrapV2: false });
    expect(defaultResult.ok && defaultResult.data.alg).toBe(DEFAULT_ENCRYPTION_ALG);
    expect(optIn.ok && optIn.data.alg).toBe(KEY_WRAP_V2_ALG);
    expect(optOut.ok && optOut.data.alg).toBe(DEFAULT_ENCRYPTION_ALG);
  });

  test("checks inline metadata and capsule algorithm before transport", async () => {
    const client = service(true);
    const result = await client.encryptToNetwork(networkId, plaintext, { metadata });
    if (!result.ok) throw result.error;
    for (const changed of [
      { metadata: {} }, { keyVersion: 2 }, { keyPath: "share/other" }, { alg: DEFAULT_ENCRYPTION_ALG },
    ]) {
      const decrypted = await client.decryptEnvelope({ ...result.data, ...changed }, { proofs: ["test-proof"] });
      expect(decrypted.ok).toBe(false);
      if (!decrypted.ok) expect(decrypted.error.code).toBe("INVALID_ENVELOPE");
    }
    expect(readKeyWrapV2(base64Decode(result.data.encryptedSymmetricKey)).header.metadata).toEqual(metadata);
  });

  test("named key client keeps its payload schema and supports both wrap writers and response versions", async () => {
    for (const requestV2 of [false, true]) for (const responseV2 of [false, true]) {
      const path = "share/test";
      const client = new NamedKeyClient({
        host: "https://node.test", crypto, keyWrapV2: requestV2, defaultNetworkId: () => networkId,
        signInvocation: async () => ({ authorization: "test", invocationCid: "invocation-test" }),
        fetch: (async (input, init) => {
          if (String(input).endsWith("/info")) return Response.json({ nodeId, features: ["encryption-named-keys-v1"] });
          if (String(input).endsWith("/invoke")) return Response.json(responseFor(JSON.parse(String(init?.body)), responseV2));
          return Response.json({ networkId, keyPath: path, alg: DEFAULT_ENCRYPTION_ALG, keyVersion: 1, publicEncryptionKey: base64Encode(network.publicKey) });
        }) as typeof fetch,
      });
      const envelope = await client.encrypt(path, plaintext, { metadata });
      expect(envelope.v).toBe(2);
      expect(envelope.alg).toBe(requestV2 ? KEY_WRAP_V2_ALG : DEFAULT_ENCRYPTION_ALG);
      expect(await client.decrypt(envelope)).toEqual(plaintext);
      if (requestV2) await expect(client.decrypt({ ...envelope, metadata: {} })).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    }
  });
});
