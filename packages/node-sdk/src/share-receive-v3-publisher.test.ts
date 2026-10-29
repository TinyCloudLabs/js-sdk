import { expect, mock, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { httpUrlToMultiaddr, signLocationRecord, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import { canonicalize, signCompactUcanAuthorization, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { publishEmailShareV3 } from "../../cli/src/share/email-publish-v3.js";
import * as emailProof from "./credentials/email-proof.js";
import { completeEmailProofWithIssuerKeys, createEd25519HolderSigner } from "./credentials/email-proof.js";
import { makeWitness } from "./credentials/test-support/witness-stub.mjs";

// The local witness signs with a test issuer key. The proof algorithm and holder binding stay unchanged.
let testIssuerKeys: ReturnType<typeof makeWitness>["issuerKeys"] | undefined;
mock.module("./credentials/email-proof.js", () => ({
  ...emailProof,
  completeEmailProof: (input: Parameters<typeof emailProof.completeEmailProof>[0]) => completeEmailProofWithIssuerKeys(input, testIssuerKeys!),
}));
const { completeAgentShareReceive, requestAgentShareEmailProof } = await import("./share-receive.js");

const key = (value: number) => new Uint8Array(32).fill(value);
const did = (seed: Uint8Array) => `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
const ownerKey = key(21);
const nodeKey = key(22);
const holderKey = key(23);
const ownerDid = did(ownerKey);
const nodeDid = did(nodeKey);
const holder = createEd25519HolderSigner(did(holderKey), async (bytes) => ed25519.sign(bytes, holderKey));
const descriptorFixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const descriptor = descriptorFixture.vectors[0]!.descriptor;
const address = "reader@example.com";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
async function aesEncrypt(keyBytes: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  return Uint8Array.from([...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource))]);
}

async function publishedV3(storedBytes: Uint8Array, encryptedSymmetricKeyDigestHex: string, shareId = "agentreceivetest0001") {
  const expiry = new Date(Date.now() + 50_000);
  const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
  return publishEmailShareV3({
    shareId, shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example",
    nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: "tinycloud:test-space",
    target: { kind: "email", address }, resource: { kind: "exact", path: `shares/${shareId}/readme.md` },
    actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId, kvResource: `tinycloud:test-space/kv/shares/${shareId}/readme.md`, selector: "exact",
      encryptionNetwork: networkId, encryptionKeyPath: `share/${shareId}`,
      encryptedSymmetricKeyDigestHex, keyVersion: 1, mode: "immutable",
      initialCiphertextDigestHex: hex(sha256(storedBytes)),
    },
    credentialDescriptor: descriptor, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
    filename: "readme.md", mediaType: "text/plain", byteLength: 21, expiresAt: expiry,
    authority: {
      ownerDid,
      async sign(bytes) { return ed25519.sign(bytes, ownerKey); },
      async createOwnerRoot(input) {
        const attenuation = Object.fromEntries(input.capabilities.map((capability) => capability.kind === "encryption"
          ? [capability.resource, { [capability.action]: [{}] }]
          : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
        const fact = {
          ownerDid: input.ownerDid, policyId: input.policyId, policyDigestHex: input.policyDigestHex,
          policyCid: input.policyCid, contentSourceDigestHex: input.contentSourceDigestHex,
          capabilityCeilingHashHex: input.capabilityCeilingHashHex, nativeProjectionHashHex: input.nativeProjectionHashHex,
          nodeAudience: input.nodeAudience, role: input.role,
          mode: input.role === "policy-authority" ? "policy-source" : "conditional-mint",
          ...(input.role === "policy-enforcement" ? { enforcerDid: nodeDid } : {}),
        };
        const root = await signCompactUcanAuthorization({
          issuerDid: ownerDid, audienceDid: input.audienceDid, attenuation, facts: [fact], proofs: [],
          notBefore: Math.floor(input.notBefore.getTime() / 1000), expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
          nonce: input.role, sign: async (bytes) => ed25519.sign(bytes, ownerKey),
        });
        return { cid: root.cid, delegationHeader: { Authorization: root.authorization } };
      },
      async registerPolicy(input) {
        const unsigned = {
          schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const, enforcerDid: nodeDid, nodeAudience: nodeDid,
          attestationBindingDigestHex: hex(sha256(new TextEncoder().encode(canonicalize({ enforcerDid: nodeDid, nodeAudience: nodeDid })))),
          issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: input.rootExpiresAt,
        };
        return {
          policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid,
          attestedEnforcerBinding: { ...unsigned, signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: toBase64Url(ed25519.sign(sha256(new TextEncoder().encode(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${canonicalize(unsigned)}`)), nodeKey)) } },
        };
      },
    },
  });
}

test("a V3 publisher link rejects another share's key and a substituted key before email proof", async () => {
  const stored = new TextEncoder().encode("synthetic encrypted owner row");
  const digest = "a".repeat(64);
  const first = await publishedV3(stored, digest, "agentreceivetest0001");
  const second = await publishedV3(stored, digest, "agentreceivetest0002");
  const secondKey = new URL(second.url).hash.match(/&k=([^&]+)/)?.[1];
  if (secondKey === undefined) throw new Error("publisher did not return a fragment key");
  const options = {
    holder, expectedOrigin: "https://share.tinycloud.xyz", registryOrigin: "https://registry.example",
    fetch: (async () => { throw new Error("proof or Node request was reached"); }) as typeof globalThis.fetch,
  };
  await expect(requestAgentShareEmailProof(first.url.replace(/&k=[^&]+/, `&k=${secondKey}`), options)).rejects.toMatchObject({ code: "decrypt-failed" });
  await expect(requestAgentShareEmailProof(first.url.replace(/&k=[^&]+/, `&k=${"A".repeat(43)}`), options)).rejects.toMatchObject({ code: "decrypt-failed" });
});

test("a proved recipient session reads and decrypts the signed share from the V3 publisher", async () => {
  const symmetricKey = key(41);
  const wrappedBytes = new Uint8Array(93).fill(17);
  const encryptedSymmetricKey = Buffer.from(wrappedBytes).toString("base64");
  const networkId = "urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
  const encryptedSymmetricKeyDigestHex = hex(sha256(wrappedBytes));
  const encryptedSymmetricKeyHash = hex(sha256(new TextEncoder().encode(canonicalize(encryptedSymmetricKey))));
  const stored = new TextEncoder().encode(canonicalize({
    v: 2, networkId, keyPath: "share/agentreceivetest0001", alg: "x25519-aes256gcm/v1", keyVersion: 1, encryptedSymmetricKey,
    encryptedSymmetricKeyHash,
    ciphertext: Buffer.from(await aesEncrypt(symmetricKey, new TextEncoder().encode("hello recipient agent"))).toString("base64"),
    metadata: { contentType: "text/plain" },
  }));
  const share = await publishedV3(stored, encryptedSymmetricKeyDigestHex);
  const envelope = share.deliveryMaterial!.envelope;
  const leaf = `${networkId}/share/agentreceivetest0001`;
  expect(envelope.contentSource.encryptionKeyPath).toBe("share/agentreceivetest0001");
  expect(envelope.policy.capabilityCeiling).toContainEqual({ kind: "encryption", resource: leaf, action: "tinycloud.encryption/decrypt" });
  const witness = makeWitness({ code: "12345678" });
  testIssuerKeys = witness.issuerKeys;
  const record = await signLocationRecord({ version: 1, subject: ownerDid, multiaddrs: [httpUrlToMultiaddr("https://node.example")], updated_at: new Date().toISOString(), sequence: 1 }, { type: "did:key", signBytes: async (bytes) => ed25519.sign(bytes, ownerKey) });
  const root = verifyCompactUcanAuthorization(envelope.policyRoot.authorization);
  expect(root.payload.att).toHaveProperty(leaf);
  const rootFact = root.payload.fct[0];
  const now = Math.floor(Date.now() / 1000);
  const session = await signCompactUcanAuthorization({
    issuerDid: nodeDid, audienceDid: holder.did, attenuation: root.payload.att,
    facts: [{
      profile: "policy-session-ucan/v1", ownerDid, policyId: envelope.policy.policyId,
      policyDigestHex: rootFact.policyDigestHex, policyCid: envelope.policyCid,
      policyDelegationCid: envelope.policyRoot.cid, enforcementDelegationCid: envelope.enforcementRoot.cid,
      contentSourceDigestHex: envelope.contentSourceDigestHex,
      capabilityCeilingHashHex: rootFact.capabilityCeilingHashHex,
      nativeProjectionHashHex: rootFact.nativeProjectionHashHex,
      enforcerDid: nodeDid, nodeAudience: nodeDid, recipientDid: holder.did,
      challengeId: "challenge-1", claimDigestHex: "4".repeat(64), claimJti: "claim-1",
      vpDigestHex: "5".repeat(64), credentialEvidenceDigestHex: "6".repeat(64),
      decisionContextDigestHex: "7".repeat(64), issuanceAuditDigestHex: "8".repeat(64),
      remainingRedelegationDepth: 0, credentialIdAuditDigestHex: "9".repeat(64), presentationJtiAuditDigestHex: "a".repeat(64),
    }],
    proofs: [envelope.policyRoot.cid, envelope.enforcementRoot.cid],
    notBefore: now, expiresAt: now + 45, nonce: "session-1",
    sign: async (bytes) => ed25519.sign(bytes, nodeKey),
  });
  let ownerRow = stored;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.hostname === "witness.credentials.org") return witness.fetch(input, init);
    if (url.hostname === "registry.example") return Response.json({ record });
    if (url.pathname === "/info") return Response.json({ nodeId: nodeDid });
    if (url.pathname === "/policy/v3/challenges") {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.policyCid).toBe(envelope.policyCid);
      expect(request.requestedCapabilities).toEqual(envelope.policy.capabilityCeiling);
      return Response.json({ challengeId: "challenge-1", nonce: "nonce-1", policyCid: envelope.policyCid, recipientDid: holder.did, nodeAudience: nodeDid, expiresAt: new Date(Date.now() + 45_000).toISOString() });
    }
    if (url.pathname === "/policy/v3/delegations") {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.policyCid).toBe(envelope.policyCid);
      return Response.json({ admitted: true, sessionCid: session.cid, authorization: session.authorization });
    }
    if (url.pathname === "/delegate") return new Response(null, { status: 204 });
    if (url.pathname === "/invoke" && init?.body === undefined) return new Response(ownerRow);
    if (url.pathname === "/invoke") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.networkId).toBe(networkId);
      expect(body.keyPath).toBe(envelope.contentSource.encryptionKeyPath);
      const receiverPublic = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64"));
      const ephemeral = key(42);
      const wrapped = await aesEncrypt(x25519.getSharedSecret(ephemeral, receiverPublic), symmetricKey);
      const invocation = verifyCompactUcanAuthorization(new Headers(init?.headers).get("Authorization")!);
      expect(invocation.payload.att).toEqual({ [leaf]: { "tinycloud.encryption/decrypt": [{}] } });
      expect(invocation.payload.iss).toBe(`${holder.did}#${holder.did.slice("did:key:".length)}`);
      const bodyHash = hex(sha256(new TextEncoder().encode(canonicalize(body))));
      const unsigned = {
        type: "tinycloud.encryption.decrypt-result/v1", targetNode: nodeDid, networkId,
        invocationCid: invocation.cid, encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash,
        wrappedKey: Buffer.from(Uint8Array.from([...x25519.getPublicKey(ephemeral), 1, ...wrapped])).toString("base64"),
        alg: "x25519-aes256gcm/v1", keyVersion: 1,
        requestHash: hex(sha256(new TextEncoder().encode(`${invocation.cid}${bodyHash}`))), nodeId: nodeDid,
      };
      return Response.json({ ...unsigned, nodeSignature: Buffer.from(ed25519.sign(new TextEncoder().encode(canonicalize(unsigned)), nodeKey)).toString("base64") });
    }
    throw new Error(`unexpected route ${url.pathname}`);
  }) as typeof globalThis.fetch;
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: fetchFn };
  const pending = await requestAgentShareEmailProof(share.url, options);
  const opened = await completeAgentShareReceive(pending, "12345678", options);
  expect(opened.text).toBe("hello recipient agent");
  expect(opened.untrusted).toBe(true);
  expect(calls).toContain("POST https://node.example/policy/v3/delegations");
  expect(calls).toContain("POST https://node.example/invoke");
  ownerRow = new TextEncoder().encode(canonicalize({
    ...JSON.parse(new TextDecoder().decode(stored)), keyPath: "share/agentreceivetest0002",
  }));
  const wrongSharePending = await requestAgentShareEmailProof(share.url, options);
  await expect(completeAgentShareReceive(wrongSharePending, "12345678", options)).rejects.toMatchObject({ code: "decrypt-failed" });
});
