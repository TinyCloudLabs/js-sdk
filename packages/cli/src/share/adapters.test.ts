import { describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";

const transportDid = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX";
const credentialHolderDid = "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH";
const nodeDid = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const ownerRootInputs: Array<{ readonly ownerDid: string; readonly role: string }> = [];
const sessionSignatures: Uint8Array[] = [];

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
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "test", host: "https://node.example" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));

const { createShareAuthorityAdapters, postAddressedShareDelivery } = await import("./adapters.js");

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

  it("posts the exact signed delivery receipt only to the credentials invitation endpoint", async () => {
    const credentialsOrigin = "https://credentials.example";
    const request = { returnLink: "https://share.example/s/inline#v=2&p=eyJjIjoiQVEiLCJjaWQiOiJjaWQiLCJrIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwidiI6Mn0" };
    const admission = { schema: "xyz.tinycloud.policy/delivery-admission/v0" };
    const proof = { alg: "EdDSA", kid: "did:web:node.example#key", signature: "test-signature" };
    const shareUrl = request.returnLink;
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];

    const response = await postAddressedShareDelivery({
      credentialsOrigin,
      receipt: { request, admission, proof },
      shareUrl,
      fetchFn: (async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 202 });
      }) as typeof globalThis.fetch,
    });

    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${credentialsOrigin}/v1/credential-invitations`);
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init).not.toHaveProperty("referrer");
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ request, admission, proof });
    expect(Object.keys(body).sort()).toEqual(["admission", "proof", "request"]);
  });

});
