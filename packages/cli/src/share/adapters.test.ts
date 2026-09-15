import { describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { encodeSealedInlineShareUrl } from "@tinycloud/share-envelope";
import { notifyShare, type SenderShareRecord } from "@tinycloud/share-sdk";

const transportDid = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX";
const credentialHolderDid = "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH";
const nodeDid = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const ownerRootInputs: Array<{ readonly ownerDid: string; readonly role: string }> = [];
const sessionSignatures: Uint8Array[] = [];
const deliveryAuthorizationInputs: Array<Record<string, unknown>> = [];

const node = {
  did: transportDid,
  credentialHolderDid,
  spaceId: "tinycloud:test-space",
  activeNodeIdentity: async () => ({ origin: "https://node.example", nodeDid }),
  getEncryptionNetworkIdForSpace: () => `urn:tinycloud:encryption:${credentialHolderDid}:default`,
  encryption: {
    encryptToNetwork: async (networkId: string) => ({
      ok: true as const,
      data: {
        v: 1,
        networkId,
        alg: "x25519-aes256gcm/v1",
        keyVersion: 1,
        encryptedSymmetricKey: "network-wrapped-key",
        encryptedSymmetricKeyHash: "1".repeat(64),
        ciphertext: "AQ",
        metadata: { contentType: "text/plain" },
      },
    }),
  },
  kvForSpace: () => ({ put: async () => ({ ok: true as const }) }),
  createUnifiedOwnerRoot: async (input: { readonly ownerDid: string; readonly role: "policy-authority" | "policy-enforcement" }) => {
    // Match TinyCloudNode.createUnifiedOwnerRoot's holder-identity guard. A
    // transport DID here must fail, so this real adapter path catches it.
    if (input.ownerDid !== credentialHolderDid) throw new Error("unified owner root signer does not match owner DID");
    ownerRootInputs.push(input);
    return {
      cid: input.role === "policy-authority" ? "bafy-policy-root" : "bafy-enforcement-root",
      delegationHeader: { Authorization: input.role === "policy-authority" ? "a.b.c" : "d.e.f" },
    };
  },
  signSessionBytes: async (bytes: Uint8Array) => {
    sessionSignatures.push(bytes.slice());
    return new Uint8Array(64).fill(7);
  },
  registerPolicy: async (input: { readonly policyCid: string; readonly policyRoot: { readonly cid: string }; readonly enforcementRoot: { readonly cid: string } }) => ({
    policyCid: input.policyCid,
    policyRootCid: input.policyRoot.cid,
    enforcementRootCid: input.enforcementRoot.cid,
    attestedEnforcerBinding: {
      schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const,
      enforcerDid: nodeDid,
      nodeAudience: nodeDid,
      attestationBindingDigestHex: "2".repeat(64),
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: "AQ" },
    },
  }),
  authorizeShareDeliveryV3: async (input: { readonly expiresAt: string; readonly idempotencyKey: string; readonly shareUrl: string }) => {
    deliveryAuthorizationInputs.push({ ...input });
    return {
      request: { returnLink: input.shareUrl },
      admission: {},
      proof: {},
    };
  },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "test", host: "https://node.example" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));

const { createShareAuthorityAdapters } = await import("./adapters.js");

describe("TinyCloud share authority adapter", () => {
  it("routes addressed delivery through Policy/v3 with no retired Node delivery fallback", async () => {
    const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
    expect(source).toContain("node.authorizeShareDeliveryV3({");
    expect(source).not.toContain("node.authorizeShareDelivery({");
    expect(source).not.toContain("/share/v2/deliveries/authorize");
  });

  it("uses the existing signed Policy/v3 root revocation primitive for addressed shares", async () => {
    const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
    expect(source).toContain("revokePolicyRootV3({");
    expect(source).toContain("revokePolicyRoot: input.revokePolicyRoot");
    expect(source).toContain('reason: "share revoked"');
    expect(source).not.toContain("/share/v2/revoke");
  });

  it("uses the credential holder for owner roots and the signed Policy/v3 revoke payload", async () => {
    ownerRootInputs.length = 0;
    sessionSignatures.length = 0;
    const originalFetch = globalThis.fetch;
    const revocations: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      revocations.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true });
    }) as typeof globalThis.fetch;

    try {
      const { targetAdapter, revocation } = createShareAuthorityAdapters({
        origin: "https://share.example",
        profileName: async () => "test",
        fetchFn: (async (input) => {
          expect(String(input)).toBe("https://share.example/.well-known/tinycloud-share/config.json");
          return Response.json({
            version: "tinycloud.share/config-v2",
            shareOrigin: "https://share.example",
            registryOrigin: "https://registry.example",
            credentialsOrigin: "https://credentials.example",
          });
        }) as typeof globalThis.fetch,
      });

      await targetAdapter.publish({
        source: new TextEncoder().encode("holder-bound share"),
        filename: "readme.txt",
        target: { kind: "email", address: "alice@example.com" },
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        origin: "https://share.example",
        mediaType: "text/plain",
      });

      expect(ownerRootInputs.map(({ ownerDid, role }) => ({ ownerDid, role }))).toEqual([
        { ownerDid: credentialHolderDid, role: "policy-authority" },
        { ownerDid: credentialHolderDid, role: "policy-enforcement" },
      ]);

      await revocation.revokePolicyRoot!({
        rootCid: "bafy-enforcement-root",
        targetRole: "policy-enforcement",
        ownerDid: credentialHolderDid,
        nodeOrigin: "https://node.example",
        nodeAudience: nodeDid,
      });

      expect(revocations).toHaveLength(1);
      expect(revocations[0]?.url).toBe("https://node.example/revoke");
      expect(revocations[0]?.body).toMatchObject({
        revocation: {
          schema: "xyz.tinycloud.policy/root-revocation/v1",
          targetCid: "bafy-enforcement-root",
          targetRole: "policy-enforcement",
          ownerDid: credentialHolderDid,
          issuerDid: credentialHolderDid,
          nodeAudience: nodeDid,
          reason: "share revoked",
          signature: { suite: "Ed25519", signerDid: credentialHolderDid },
        },
      });
      expect(sessionSignatures).toHaveLength(3);
      expect(sessionSignatures.at(-1)).toHaveLength(32);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the reusable Share SDK invitation client and forwards notify idempotency to Node", async () => {
    const source = await readFile(new URL("./adapters.ts", import.meta.url), "utf8");
    expect(source).toContain("deliverCredentialInvitation({");
    expect(source).toContain("idempotencyKey: request.idempotencyKey");
    expect(source).not.toContain("credential-invitations");
    expect(source).not.toContain("postAddressedShareDelivery");
  });

  it("keeps the Node authorization body identical when a real adapter retry advances the clock", async () => {
    deliveryAuthorizationInputs.length = 0;
    const originalNow = Date.now;
    let now = Date.parse("2026-09-15T01:00:00.000Z");
    Date.now = () => now;
    let invitationAttempts = 0;
    try {
      const link = await encodeSealedInlineShareUrl({
        origin: "https://share.example",
        ciphertext: new Uint8Array([1, 2, 3]),
        key32: new Uint8Array(32).fill(7),
      });
      const record: SenderShareRecord = {
        shareId: "share-retry",
        target: { origin: "https://node.example", nodeAudience: nodeDid, spaceId: "tinycloud:test-space" },
        resource: { kind: "exact", path: "shares/share-retry/readme.md" },
        actions: ["tinycloud.kv/get"],
        recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
        registeredAt: "2026-09-15T00:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
        link,
        filename: "readme.md",
        deliveryMaterial: {
          envelope: { version: 3 },
          sealedEnvelope: "AQ",
          envelopeKey: "A".repeat(43),
          shareCid: "bafkreibm6jg3ux5qucnwb24kinphs4b5fbc7n5t3lti2skm4du5qjn4fli",
        },
      };
      const { delivery } = createShareAuthorityAdapters({
        origin: "https://share.example",
        profileName: async () => "test",
        fetchFn: (async (input) => {
          const url = String(input);
          if (url.endsWith("/.well-known/tinycloud-share/config.json")) {
            return Response.json({
              version: "tinycloud.share/config-v2",
              shareOrigin: "https://share.example",
              registryOrigin: "https://registry.example",
              credentialsOrigin: "https://credentials.example",
            });
          }
          expect(url).toBe("https://credentials.example/v1/credential-invitations");
          invitationAttempts += 1;
          if (invitationAttempts === 1) {
            now += 2_000;
            throw new Error("response lost after Node authorization");
          }
          return Response.json({ status: "accepted" }, { status: 202 });
        }) as typeof globalThis.fetch,
      });

      await expect(notifyShare({
        shareId: record.shareId,
        recipient: "alice@example.com",
        record,
        adapter: delivery,
        idempotencyKey: "tinycloud-share:share-retry:stable-recipient-digest",
        maxAttempts: 2,
      })).resolves.toMatchObject({ state: "delivered", attempts: 2 });

      expect(deliveryAuthorizationInputs).toHaveLength(2);
      expect(deliveryAuthorizationInputs[1]).toEqual(deliveryAuthorizationInputs[0]);
    } finally {
      Date.now = originalNow;
    }
  });

});
