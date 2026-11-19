import { expect, test } from "bun:test";
import { EncryptionService } from "./EncryptionService";
import { encryptToNetwork } from "./envelope";
import { base64Encode, canonicalize } from "./canonical";
import type { EncryptionCrypto, NetworkDescriptor } from "./types";

const networkId = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";
const crypto: EncryptionCrypto = {
  sha256: () => new Uint8Array(32), randomBytes: (n) => new Uint8Array(n).fill(1),
  x25519FromSeed: (seed) => ({ publicKey: seed, privateKey: seed }),
  x25519Dh: () => new Uint8Array(32), authEncrypt: (_k, data) => data,
  authDecrypt: (_k, data) => data, sealToNetworkKey: (_k, data) => data,
  openWithReceiverKey: (_k, data) => data, verifyNodeSignature: () => true,
};
const descriptor: NetworkDescriptor = {
  networkId, ownerDid: "did:key:z6MkPrincipal", name: "default", members: [{ nodeId: "did:key:z6MkNode", role: "primary" }],
  threshold: { n: 1, t: 1 }, state: "active", publicEncryptionKey: base64Encode(new Uint8Array(32)),
  alg: "x25519-aes256gcm/v1", keyVersion: 1, keyBackend: "local-one-of-one", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

for (const stage of ["discovery", "sign", "transport"] as const) {
  test(`a decrypt cancelled during ${stage} reports a transport error, not a failed decryption`, async () => {
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const pause = async (at: typeof stage) => { if (stage === at) { entered(); await resumed; } };
    const service = new EncryptionService({ crypto,
      node: { fetchByNetworkId: async () => { await pause("discovery"); return descriptor; } },
      signer: { signDecryptInvocation: async (input) => {
        await pause("sign");
        return { authorization: "test", invocationCid: "test", canonicalBody: canonicalize(input.body as never) };
      } },
      transport: { postDecrypt: async (input) => { await pause("transport"); input.signal?.throwIfAborted(); throw new Error("unreachable"); } },
    });
    const { envelope } = encryptToNetwork(crypto, { networkId, networkPublicKey: new Uint8Array(32), plaintext: new Uint8Array([1]) });
    const pending = service.decryptEnvelope(envelope, { proofs: [] });
    await reached;
    service.onSignOut();
    resume();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TRANSPORT_ERROR");
  });
}
