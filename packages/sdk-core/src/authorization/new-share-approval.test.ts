import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prepareSession } from "@tinycloud/node-sdk-wasm";
import { verifyNewShareApproval, type NewShareApprovalExpected } from "./new-share-approval";

async function fixture(extra = false) {
  const account = privateKeyToAccount(generatePrivateKey());
  const ownerDid = `did:pkh:eip155:1:${account.address}`;
  const shareId = randomBytes(16).toString("hex");
  const resource = `urn:tinycloud:encryption:${ownerDid}:default/share/${shareId}`;
  const file = `tinycloud:pkh:eip155:1:${account.address}:applications/kv/app/shares/export.json`;
  const now = Date.now();
  const prepared = prepareSession({ address: account.address, chainId: 1, domain: "thirdparty.example",
    issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + 3600_000).toISOString(),
    spaceId: `tinycloud:pkh:eip155:1:${account.address}:applications`,
    jwk: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }), abilities: {},
    rawAbilities: { [resource]: ["tinycloud.encryption/decrypt"], [file]: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      ...(extra ? { [`urn:tinycloud:encryption:${ownerDid}:default/share/`]: ["tinycloud.encryption/decrypt"] } : {}) },
  });
  const identity = { requestId: randomBytes(32).toString("base64url"), shareId, ownerDid,
    sessionDid: prepared.verificationMethod, origin: "https://thirdparty.example", preparedSiwe: prepared.siwe, expiresAt: now + 60_000 };
  const result = { purpose: "share-create" as const, ...identity, prepared, signature: await account.signMessage({ message: prepared.siwe }) };
  const expected: NewShareApprovalExpected = { identity, ownerAddress: account.address, chainId: 1,
    sessionDid: prepared.verificationMethod, origin: identity.origin, sessionExpiresAt: now + 7200_000,
    requestedExpiresAt: now + 3600_000, fileGrants: [{ resource: file, actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] }] };
  return { result, expected, now, resource };
}

test("a real owner signature covers only the minted key and the unchanged file rows", async () => {
  const f = await fixture();
  expect((await verifyNewShareApproval(f.result, f.expected, f.now)).resource).toBe(f.resource);
  await expect(verifyNewShareApproval({ ...f.result, shareId: "f".repeat(32) }, f.expected, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval(f.result, { ...f.expected, sessionDid: "did:key:zOther" }, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval(f.result, { ...f.expected, origin: "https://other.example" }, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval(f.result, { ...f.expected, sessionExpiresAt: f.now + 1000 }, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval(f.result, { ...f.expected, fileGrants: [] }, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval({ ...f.result, signature: "0x" + "00".repeat(65) }, f.expected, f.now)).rejects.toThrow();
  await expect(verifyNewShareApproval(f.result, f.expected, f.now + 60_000)).rejects.toThrow();
});

test("an extra prefix grant is refused even when genuinely owner-signed and pinned by the transport", async () => {
  const f = await fixture(true);
  await expect(verifyNewShareApproval(f.result, f.expected, f.now)).rejects.toThrow("scope");
});

test("verification retains the exact checked bytes across its signature await", async () => {
  const f = await fixture();
  const original = f.result.prepared.siwe;
  const signature = f.result.signature;
  const pending = verifyNewShareApproval(f.result, f.expected, f.now);
  f.result.prepared.siwe = "changed while verification was pending";
  f.result.signature = "changed";
  f.expected.sessionDid = "did:key:changed";
  const verified = await pending;
  expect(verified.signedMessage).toBe(original);
  expect(verified.signature).toBe(signature);
  expect(verified.sessionDid).not.toBe(f.expected.sessionDid);
});
