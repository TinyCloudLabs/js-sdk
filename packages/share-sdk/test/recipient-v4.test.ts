import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
  canonicalize,
  didKeyFromEd25519PublicKey,
  signCompactUcanAuthorization,
  verifyCompactUcanAuthorization,
} from "@tinycloud/share-envelope";
import { ShareRecipientClient } from "../src/recipient.js";

function policySessionFacts(input: {
  policyCid: string;
  policyRoot: string;
  enforcementRoot: string;
  enforcerDid: string;
  nodeAudience: string;
  recipientDid: string;
  overrides?: Record<string, unknown>;
}) {
  return {
    profile: "policy-session-ucan/v1",
    ownerDid: "did:key:z6MkOwner",
    policyId: "pol_tc500",
    policyDigestHex: "0".repeat(64),
    policyCid: input.policyCid,
    policyDelegationCid: input.policyRoot,
    enforcementDelegationCid: input.enforcementRoot,
    contentSourceDigestHex: "1".repeat(64),
    capabilityCeilingHashHex: "2".repeat(64),
    nativeProjectionHashHex: "3".repeat(64),
    enforcerDid: input.enforcerDid,
    nodeAudience: input.nodeAudience,
    recipientDid: input.recipientDid,
    challengeId: "challenge-500",
    claimDigestHex: "4".repeat(64),
    claimJti: "claim-jti-500",
    vpDigestHex: "5".repeat(64),
    credentialEvidenceDigestHex: "6".repeat(64),
    decisionContextDigestHex: "7".repeat(64),
    issuanceAuditDigestHex: "8".repeat(64),
    remainingRedelegationDepth: 8,
    credentialIdAuditDigestHex: "9".repeat(64),
    presentationJtiAuditDigestHex: "a".repeat(64),
    ...input.overrides,
  };
}

describe("TC-500 accountless v4 recipient", () => {
  test("rejects a substituted or expired challenge audience before credential presentation", async () => {
    const receiverKey = new Uint8Array(32).fill(61);
    const nodeKey = new Uint8Array(32).fill(62);
    const enforcerKey = new Uint8Array(32).fill(63);
    const receiverDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(receiverKey));
    const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
    const enforcerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(enforcerKey));
    const envelope = { version: 3, actions: ["read"], resource: { kind: "exact", path: "shares/file" }, target: { origin: "https://node.example", nodeAudience: enforcerDid }, attestedEnforcerBinding: { enforcerDid, nodeAudience: nodeDid }, policyCid: "policy", policy: { capabilityCeiling: [] }, policyRoot: { cid: "root" }, enforcementRoot: { cid: "enforcement" } } as any;
    let presentations = 0;
    const client = new ShareRecipientClient({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: "did:web:keys.example#share", invitationPublicKey: new Uint8Array(32).fill(1) },
      holderDid: receiverDid,
      envelope,
      fetchFn: async () => Response.json({ challengeId: "challenge", nonce: "nonce", policyCid: "policy", recipientDid: receiverDid, nodeAudience: "did:web:attacker.example", expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      buildPresentation: async () => { presentations += 1; throw new Error("must not present"); },
    });
    await expect(client.establishPolicySession()).rejects.toThrow("challenge binding");
    expect(presentations).toBe(0);
  });

  test("posts only v4 evidence, imports the ordinary delegation, and invokes with the receiver signer", async () => {
    const receiverKey = new Uint8Array(32).fill(51);
    const nodeKey = new Uint8Array(32).fill(52);
    const enforcerKey = new Uint8Array(32).fill(53);
    const receiverDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(receiverKey));
    const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
    const enforcerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(enforcerKey));
    const policyRoot = "bafy-policy-root-500";
    const enforcementRoot = "bafy-enforcement-root-500";
    const policyCid = "bafy-policy-500";
    const resource = "tinycloud://owner-space/kv/shares/tc-500/document.txt";
    const encryptionNetwork = "urn:tinycloud:encryption:owner:default";
    const capability = { kind: "kv", resource, selector: "exact", actions: ["tinycloud.kv/get"] };
    const decryptCapability = { kind: "encryption", resource: encryptionNetwork, action: "tinycloud.encryption/decrypt" };
    const now = Math.floor(Date.now() / 1000);
    const session = await signCompactUcanAuthorization({
      issuerDid: nodeDid,
      audienceDid: receiverDid,
      attenuation: {
        [resource]: { "tinycloud.kv/get": [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource }] },
        [encryptionNetwork]: { "tinycloud.encryption/decrypt": [{}] },
      },
      facts: [policySessionFacts({ policyCid, policyRoot, enforcementRoot, enforcerDid, nodeAudience: nodeDid, recipientDid: receiverDid })],
      proofs: [policyRoot, enforcementRoot],
      notBefore: now,
      expiresAt: now + 60,
      nonce: "session-500",
      sign: async (bytes) => ed25519.sign(bytes, nodeKey),
    });
    let delegationRequest: Record<string, unknown> | undefined;
    let importedAuthorization = "";
    let invocationAuthorization = "";
    let decryptAuthorization = "";
    let decryptBody: Record<string, unknown> | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/share/v3/policy/challenges") return Response.json({ challengeId: "challenge-500", nonce: "nonce-500", policyCid, recipientDid: receiverDid, nodeAudience: nodeDid, expiresAt: new Date((now + 60) * 1000).toISOString() });
      if (path === "/share/v3/policy/delegations") {
        delegationRequest = JSON.parse(String(init?.body));
        return Response.json({ admitted: true, sessionCid: session.cid, authorization: session.authorization });
      }
      if (path === "/delegate") {
        importedAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(null, { status: 204 });
      }
      if (path === "/invoke") {
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        if (init?.body !== undefined) {
          decryptAuthorization = authorization;
          decryptBody = JSON.parse(String(init.body));
          return new Response(null, { status: 400 });
        }
        invocationAuthorization = authorization;
        return new Response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`unexpected request ${path}`);
    };
    const envelope = {
      version: 3,
      actions: ["read"],
      resource: { kind: "exact", path: "shares/tc-500/document.txt" },
      target: { origin: "https://node.example", nodeAudience: enforcerDid },
      attestedEnforcerBinding: { enforcerDid, nodeAudience: nodeDid },
      policyCid,
      policy: { ownerDid: "did:key:z6MkOwner", policyId: "pol_tc500", capabilityCeiling: [capability, decryptCapability] },
      policyRoot: { cid: policyRoot },
      enforcementRoot: { cid: enforcementRoot },
      contentSourceDigestHex: "1".repeat(64),
      encryptionNetwork,
      contentSource: { keyVersion: 1, encryptedSymmetricKeyDigestHex: "unused" },
      metadata: { mediaType: "text/plain" },
    } as any;
    let signerCalls = 0;
    const sign = async (bytes: Uint8Array) => { signerCalls += 1; return ed25519.sign(bytes, receiverKey); };
    const presentation = { schema: "xyz.tinycloud.policy/presentation/v4", holderDid: receiverDid, subjectDid: receiverDid };
    const credential = { type: "OpenCredentialsIssuedCredential", version: 1, holderDid: receiverDid, subjectDid: receiverDid };
    const requirement = { type: "TinyCloudCredentialRequirement", version: 1, claims: { email: "receiver@example.com" } };
    const client = new ShareRecipientClient({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: `${nodeDid}#${nodeDid.slice("did:key:".length)}`, invitationPublicKey: ed25519.getPublicKey(nodeKey) },
      holderDid: receiverDid,
      envelope,
      fetchFn,
      sign,
      buildPresentation: async () => ({ holderDid: receiverDid, credential: "not-sent", holderBinding: {}, proof: {}, sign, presentation, credentialEnvelope: credential, requirement }),
    });
    await client.establishPolicySession();
    const response = await client.nativeInvoke({ action: "get", resource: envelope.resource });
    expect(response.ok).toBe(true);
    expect(Object.keys(delegationRequest!).sort()).toEqual(["challengeId", "credential", "nonce", "policyCid", "presentation", "requirement"]);
    expect(delegationRequest).toMatchObject({ credential, presentation, requirement });
    expect(JSON.stringify(delegationRequest)).not.toMatch(/account|wallet|chain|credentialSpace|holderBinding|proof/i);
    expect(importedAuthorization).toBe(session.authorization);
    const invocation = verifyCompactUcanAuthorization(invocationAuthorization);
    expect(invocation.payload.iss.split("#", 1)[0]).toBe(receiverDid);
    expect(invocation.payload.aud).toBe(nodeDid);
    expect(invocation.payload.prf).toEqual([session.cid]);

    const encryptedSymmetricKey = "wrapped-key";
    const encryptedSymmetricKeyHash = [...sha256(new TextEncoder().encode(canonicalize(encryptedSymmetricKey)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    envelope.contentSource.encryptedSymmetricKeyDigestHex = encryptedSymmetricKeyHash;
    const encryptedEnvelope = new TextEncoder().encode(JSON.stringify({
      v: 1,
      networkId: encryptionNetwork,
      alg: "x25519-aes256gcm/v1",
      keyVersion: 1,
      encryptedSymmetricKey,
      encryptedSymmetricKeyHash,
      ciphertext: "AA",
    }));
    await expect(client.decryptV3Content(encryptedEnvelope)).rejects.toThrow("decrypt invocation rejected");
    expect(decryptBody?.targetNode).toBe(nodeDid);
    expect(verifyCompactUcanAuthorization(decryptAuthorization).payload.aud).toBe(nodeDid);
    expect(signerCalls).toBeGreaterThan(0);

    const fastPath = new ShareRecipientClient({
      nodeOrigin: "https://node.example",
      trustedNode: { invitationKid: `${nodeDid}#key`, invitationPublicKey: ed25519.getPublicKey(nodeKey) },
      holderDid: receiverDid,
      envelope,
      fetchFn,
      sign,
      policyAuthorization: { authorization: session.authorization, cid: session.cid },
    });
    expect((await fastPath.establishPolicySession()).sessionId).toBe(session.cid);
  });

  test("rejects substituted, inactive, or overbroad S0 authority before import", async () => {
    const receiverKey = new Uint8Array(32).fill(41);
    const nodeKey = new Uint8Array(32).fill(42);
    const attackerKey = new Uint8Array(32).fill(43);
    const enforcerKey = new Uint8Array(32).fill(44);
    const receiverDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(receiverKey));
    const nodeDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(nodeKey));
    const attackerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(attackerKey));
    const enforcerDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(enforcerKey));
    const policyRoot = "bafy-policy-root-security";
    const enforcementRoot = "bafy-enforcement-root-security";
    const policyCid = "bafy-policy-security";
    const resource = "tinycloud://owner-space/kv/shares/security/document.txt";
    const capability = { kind: "kv", resource, selector: "exact", actions: ["tinycloud.kv/get"] };
    const expectedAttenuation = { [resource]: { "tinycloud.kv/get": [{ type: "xyz.tinycloud.resource/selector", kind: "exact", value: resource }] } };
    const now = Math.floor(Date.now() / 1000);
    const envelope = {
      version: 3,
      actions: ["read"],
      resource: { kind: "exact", path: "shares/security/document.txt" },
      target: { origin: "https://node.example", nodeAudience: enforcerDid },
      attestedEnforcerBinding: { enforcerDid, nodeAudience: nodeDid },
      policyCid,
      policy: { ownerDid: "did:key:z6MkOwner", policyId: "pol_tc500", capabilityCeiling: [capability] },
      policyRoot: { cid: policyRoot },
      enforcementRoot: { cid: enforcementRoot },
      contentSourceDigestHex: "1".repeat(64),
    } as any;
    const createSession = async (input: {
      key: Uint8Array;
      nodeAudience: string;
      notBefore?: number;
      attenuation?: Record<string, Record<string, unknown[]>>;
      factOverrides?: Record<string, unknown>;
    }) => signCompactUcanAuthorization({
      issuerDid: didKeyFromEd25519PublicKey(ed25519.getPublicKey(input.key)),
      audienceDid: receiverDid,
      attenuation: input.attenuation ?? expectedAttenuation,
      facts: [policySessionFacts({ policyCid, policyRoot, enforcementRoot, enforcerDid, nodeAudience: input.nodeAudience, recipientDid: receiverDid, overrides: input.factOverrides })],
      proofs: [policyRoot, enforcementRoot],
      notBefore: input.notBefore ?? now,
      expiresAt: (input.notBefore ?? now) + 60,
      nonce: "session-security",
      sign: async (bytes) => ed25519.sign(bytes, input.key),
    });
    const presentation = { schema: "xyz.tinycloud.policy/presentation/v4", holderDid: receiverDid, subjectDid: receiverDid };
    const credential = { type: "OpenCredentialsIssuedCredential", version: 1, holderDid: receiverDid, subjectDid: receiverDid };
    const requirement = { type: "TinyCloudCredentialRequirement", version: 1, claims: { email: "receiver@example.com" } };
    const sign = async (bytes: Uint8Array) => ed25519.sign(bytes, receiverKey);
    const rejectSession = async (session: Awaited<ReturnType<typeof createSession>>) => {
      let imports = 0;
      expect(() => new ShareRecipientClient({
        nodeOrigin: "https://node.example",
        trustedNode: { invitationKid: `${nodeDid}#key`, invitationPublicKey: ed25519.getPublicKey(nodeKey) },
        holderDid: receiverDid,
        envelope,
        sign,
        policyAuthorization: { authorization: session.authorization, cid: session.cid },
      })).toThrow("signed binding");
      const client = new ShareRecipientClient({
        nodeOrigin: "https://node.example",
        trustedNode: { invitationKid: `${nodeDid}#key`, invitationPublicKey: ed25519.getPublicKey(nodeKey) },
        holderDid: receiverDid,
        envelope,
        fetchFn: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/share/v3/policy/challenges") return Response.json({ challengeId: "challenge-security", nonce: "nonce-security", policyCid, recipientDid: receiverDid, nodeAudience: nodeDid, expiresAt: new Date((now + 60) * 1000).toISOString() });
          if (path === "/share/v3/policy/delegations") return Response.json({ admitted: true, sessionCid: session.cid, authorization: session.authorization });
          if (path === "/delegate") { imports += 1; return new Response(null, { status: 204 }); }
          throw new Error(`unexpected request ${path}`);
        },
        buildPresentation: async () => ({ holderDid: receiverDid, credential: "not-sent", holderBinding: {}, proof: {}, sign, presentation, credentialEnvelope: credential, requirement }),
      });
      await expect(client.establishPolicySession()).rejects.toThrow("signed binding");
      expect(imports).toBe(0);
    };

    await rejectSession(await createSession({ key: attackerKey, nodeAudience: attackerDid }));
    await rejectSession(await createSession({ key: nodeKey, nodeAudience: nodeDid, factOverrides: { ownerDid: attackerDid } }));
    await rejectSession(await createSession({ key: nodeKey, nodeAudience: nodeDid, notBefore: now + 30 }));
    await rejectSession(await createSession({
      key: nodeKey,
      nodeAudience: nodeDid,
      attenuation: { ...expectedAttenuation, "tinycloud://owner-space/kv/private": { "tinycloud.kv/get": [{}] } },
    }));
  });
});
