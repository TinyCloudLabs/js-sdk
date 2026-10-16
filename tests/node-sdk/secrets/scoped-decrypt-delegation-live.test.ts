import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import {
  buildScopedDecryptResource,
  TinyCloudNode,
  type InlineEncryptedEnvelope,
  type Manifest,
} from "@tinycloud/node-sdk";
import { checkServerHealth, SERVER_URL } from "../setup";

describe("scoped decrypt child delegation (live)", () => {
  test("activates an exact A grant and refuses locally held sibling B ciphertext", async () => {
    await checkServerHealth();
    const ownerKey = Wallet.createRandom().privateKey.slice(2);
    const ownerAddress = new Wallet(ownerKey).address;
    const ownerDid = `did:pkh:eip155:1:${ownerAddress}`;
    const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;
    const secretA = "SCOPED_CHILD_A";
    const secretB = "SCOPED_CHILD_B";
    const valueA = `only-a-${Date.now()}`;
    const valueB = `only-b-${Date.now()}`;
    const manifest: Manifest = {
      manifest_version: 1,
      app_id: "dev.tinycloud.scoped-child-live",
      name: "Scoped Child Decrypt Live Test",
      defaults: false,
      permissions: [{
        service: "tinycloud.encryption",
        path: networkId,
        actions: ["network.create", "decrypt"],
      }],
      secrets: {
        [secretA]: { actions: ["get", "put", "del"] },
        [secretB]: { actions: ["get", "put", "del"] },
      },
    };
    const owner = new TinyCloudNode({
      privateKey: ownerKey,
      host: SERVER_URL,
      prefix: `scoped-owner-${Date.now()}`,
      autoCreateSpace: true,
      manifest,
      includeAccountRegistryPermissions: false,
    });
    await owner.signIn();
    const spaceId = await owner.ensureOwnedSpaceHosted("secrets");
    const child = new TinyCloudNode({
      privateKey: Wallet.createRandom().privateKey.slice(2),
      host: SERVER_URL,
      prefix: `scoped-child-${Date.now()}`,
      autoCreateSpace: true,
    });
    await child.signIn();

    const pathA = `vault/secrets/${secretA}`;
    const pathB = `vault/secrets/${secretB}`;
    const readEnvelope = async (path: string): Promise<InlineEncryptedEnvelope> => {
      const stored = await owner.kvForSpace(spaceId).get<string>(path, { raw: true });
      if (!stored.ok) throw new Error(`Unable to read ${path}: ${stored.error.message}`);
      return JSON.parse(stored.data.data) as InlineEncryptedEnvelope;
    };

    try {
      const putA = await owner.secrets.put(secretA, valueA);
      const putB = await owner.secrets.put(secretB, valueB);
      if (!putA.ok || !putB.ok) {
        throw new Error(`Unable to store named secrets: ${JSON.stringify({ putA, putB })}`);
      }
      const envelopeA = await readEnvelope(pathA);
      const envelopeB = await readEnvelope(pathB); // possession is not decrypt authority
      const resourceA = buildScopedDecryptResource(networkId, { spaceId, path: pathA });
      const recipient = child.session?.verificationMethod.split("#", 1)[0];
      if (!recipient) throw new Error("Child has no session DID");
      const { delegation } = await owner.delegateTo(recipient, [{
        service: "tinycloud.encryption",
        path: resourceA,
        actions: ["tinycloud.encryption/decrypt"],
      }]);
      expect(delegation.resources).toContainEqual(expect.objectContaining({
        path: resourceA,
        actions: ["tinycloud.encryption/decrypt"],
      }));
      await child.useRuntimeDelegation(delegation);

      const proof = { proofs: [delegation.cid] };
      const allowed = await child.encryption.decryptEnvelope(envelopeA, proof, { spaceId, path: pathA });
      if (!allowed.ok) throw new Error(`Scoped A decrypt failed: ${allowed.error.message}`);
      expect(new TextDecoder().decode(allowed.data)).toContain(valueA);

      const sibling = await child.encryption.decryptEnvelope(envelopeB, proof, { spaceId, path: pathB });
      expect(sibling.ok).toBe(false);
      if (!sibling.ok) expect(sibling.error.code).toBe("DECRYPT_DENIED");

      const forged = await child.encryption.decryptEnvelope(envelopeB, proof, { spaceId, path: pathA });
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.error.code).toBe("DECRYPT_DENIED");

      const missing = await child.encryption.decryptEnvelope(envelopeA, proof);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("DECRYPT_DENIED");
    } finally {
      await Promise.allSettled([owner.secrets.delete(secretA), owner.secrets.delete(secretB)]);
    }
  }, 180_000);
});
