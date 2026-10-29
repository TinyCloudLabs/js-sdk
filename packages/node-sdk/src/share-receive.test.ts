import { expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { canonicalDigest, createEmailCredentialRequirement, httpUrlToMultiaddr, signLocationRecord, type CredentialFlowDescriptor } from "@tinycloud/sdk-core";
import { publishAddressedShare, addressedCredentialRequirement } from "@tinycloud/share-sdk";
import { canonicalize, fromBase64Url, signCompactUcanAuthorization, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { buildShortLink, parseLink } from "@tinycloud/share-envelope/links";
import { completeEmailProofWithIssuerKeys, createEd25519HolderSigner } from "./credentials/email-proof.js";
import { makeWitness } from "./credentials/test-support/witness-stub.mjs";
import { openVerifiedAgentShare } from "./share-receive-access.js";
import { completeAgentShareReceive, requestAgentShareEmailProof } from "./share-receive.js";

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
async function published(expiry = new Date(Date.now() + 50_000), source?: { encryptedSymmetricKeyDigestHex: string; initialCiphertextDigestHex: string }) {
  return publishAddressedShare({
    shareId: "agentreceivetest0001",
    shareOrigin: "https://share.tinycloud.xyz",
    nodeOrigin: "https://node.example",
    nodeAudience: nodeDid,
    enforcerDid: nodeDid,
    spaceId: "tinycloud:test-space",
    target: { kind: "email", address },
    resource: { kind: "exact", path: "shares/agentreceivetest0001/readme.md" },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: "agentreceivetest0001",
      kvResource: "tinycloud:test-space/kv/shares/agentreceivetest0001/readme.md",
      selector: "exact",
      encryptionNetwork: `urn:tinycloud:encryption:${ownerDid}:default`,
      encryptedSymmetricKeyDigestHex: source?.encryptedSymmetricKeyDigestHex ?? "1".repeat(64),
      keyVersion: 1,
      mode: "immutable",
      initialCiphertextDigestHex: source?.initialCiphertextDigestHex ?? "2".repeat(64),
    },
    credentialRequirement: addressedCredentialRequirement({ kind: "email", address }),
    filename: "readme.md",
    mediaType: "text/markdown",
    byteLength: 8,
    expiresAt: expiry,
    authority: {
      ownerDid,
      async createOwnerRoot(input) {
        const attenuation = Object.fromEntries(input.capabilities.map((capability) => capability.kind === "encryption"
          ? [capability.resource, { [capability.action]: [{}] }]
          : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
        const fact = {
          ownerDid: input.ownerDid,
          policyId: input.policyId,
          policyDigestHex: input.policyDigestHex,
          policyCid: input.policyCid,
          contentSourceDigestHex: input.contentSourceDigestHex,
          capabilityCeilingHashHex: input.capabilityCeilingHashHex,
          nativeProjectionHashHex: input.nativeProjectionHashHex,
          nodeAudience: input.nodeAudience,
          role: input.role,
          mode: input.role === "policy-authority" ? "policy-source" : "conditional-mint",
          ...(input.role === "policy-enforcement" ? { enforcerDid: nodeDid } : {}),
        };
        const root = await signCompactUcanAuthorization({
          issuerDid: ownerDid,
          audienceDid: input.audienceDid,
          attenuation,
          facts: [fact],
          proofs: [],
          notBefore: Math.floor(input.notBefore.getTime() / 1000),
          expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
          nonce: input.role,
          sign: async (bytes) => ed25519.sign(bytes, ownerKey),
        });
        return { cid: root.cid, delegationHeader: { Authorization: root.authorization } };
      },
      async sign(bytes) { return ed25519.sign(bytes, ownerKey); },
      async registerPolicy(input) {
        const unsignedBinding = {
          schema: "xyz.tinycloud.policy/attested-enforcer/v2" as const,
          enforcerDid: nodeDid,
          nodeAudience: nodeDid,
          attestationBindingDigestHex: hex(sha256(new TextEncoder().encode(canonicalize({ enforcerDid: nodeDid, nodeAudience: nodeDid })))),
          issuedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: expiry.toISOString(),
        };
        return {
          policyCid: input.policyCid,
          policyRootCid: input.policyRoot.cid,
          enforcementRootCid: input.enforcementRoot.cid,
          attestedEnforcerBinding: { ...unsignedBinding, signature: { suite: "Ed25519" as const, signerDid: nodeDid, value: toBase64Url(ed25519.sign(sha256(new TextEncoder().encode(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${canonicalize(unsignedBinding)}`)), nodeKey)) } },
        };
      },
    },
  });
}

function witnessFetch() {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.pathname === "/.well-known/opencredentials") return Response.json({ type: "tinycloud.credentials/catalog/v1", protocol: "tinycloud.credentials/acquisition/v1", catalogVersion: 1, profiles: [{ supported: true, enabled: true, readiness: "ready", descriptor, descriptorDigest: await canonicalDigest(descriptor) }] });
    if (url.pathname.endsWith("/challenge")) return Response.json({ type: "tinycloud.credentials/challenge/v1", step: "mailbox_otp", stepVersion: 1, challengeNonce: "N".repeat(32) });
    if (init?.method === "POST") return Response.json({ type: "tinycloud.credentials/acquisition-request/v1", protocol: descriptor.protocol, next: "challenge", endpoint: "challenge", requestId: "R".repeat(32), expiresAt: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
    return Response.json({ type: "tinycloud.credentials/acquisition-state/v1", requestId: "R".repeat(32), profile: descriptor.profile, profileVersion: 1, state: "challenge_required", resultPreviouslyRead: false });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("a complete signed link resolves locally; only the witness request sees the recipient email", async () => {
  const share = await published();
  const witness = witnessFetch();
  const pending = await requestAgentShareEmailProof(share.url, { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch });
  expect(pending.metadata.target.kind).toBe("email");
  expect(pending.proof.address).toBe(address);
  expect(pending.proof.holderDid).toBe(holder.did);
  expect(JSON.stringify(pending)).not.toContain(share.deliveryMaterial!.envelopeKey);
  expect(JSON.stringify(pending)).not.toContain(pending.proof.verifier);
  expect(witness.calls.every((call) => !call.includes("#"))).toBe(true);
  expect(witness.calls.every((call) => !call.includes(share.deliveryMaterial!.envelopeKey))).toBe(true);
});

test("a short code#key link fetches only its public sealed body and keeps the fragment local", async () => {
  const share = await published();
  const parsed = parseLink(share.url, { trustedOrigins: ["https://share.tinycloud.xyz"] });
  if (parsed.form !== "full") throw new Error("expected a full link fixture");
  const record = parsed.record as { header: { bodyCid: string }; signature: unknown; body: string };
  const short = buildShortLink({ origin: "https://share.tinycloud.xyz", type: "share", id: "lqdw5iopqq2tkkvjj6gbbi5vbv", key: parsed.key, bodyCid: record.header.bodyCid });
  const witness = witnessFetch();
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.tinycloud.xyz/v1/links/")) return new Response(fromBase64Url(record.body), { headers: { "content-type": "application/octet-stream", "x-link-record": toBase64Url(new TextEncoder().encode(canonicalize({ header: record.header, signature: record.signature }))) } });
    return witness.fetch(input, init);
  }) as typeof globalThis.fetch;
  const pending = await requestAgentShareEmailProof(short, { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: fetchFn });
  expect(pending.proof.address).toBe(address);
  expect(calls[0]).toBe("https://api.tinycloud.xyz/v1/links/lqdw5iopqq2tkkvjj6gbbi5vbv");
  expect(calls.every((call) => !call.includes("#") && !call.includes(share.deliveryMaterial!.envelopeKey))).toBe(true);
});

test("an expired share and malformed or substituted fragments refuse before a code request", async () => {
  const share = await published();
  const witness = witnessFetch();
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch };
  await expect(requestAgentShareEmailProof(share.url, { ...options, now: () => Date.now() + 7_200_000 })).rejects.toMatchObject({ code: "expired" });
  await expect(requestAgentShareEmailProof(share.url.split("#")[0]!, options)).rejects.toMatchObject({ code: "invalid-link" });
  await expect(requestAgentShareEmailProof(share.url.replace(/&k=[A-Za-z0-9_-]{43}/, `&k=${"A".repeat(43)}`), options)).rejects.toMatchObject({ code: "decrypt-failed" });
  expect(witness.calls).toHaveLength(0);
});

test("a different agent session key cannot complete another holder's email request", async () => {
  const share = await published();
  const witness = witnessFetch();
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch };
  const pending = await requestAgentShareEmailProof(share.url, options);
  const otherKey = key(24);
  const other = createEd25519HolderSigner(did(otherKey), async (bytes) => ed25519.sign(bytes, otherKey));
  await expect(completeAgentShareReceive(pending, "12345678", { ...options, holder: other })).rejects.toMatchObject({ code: "authorization-denied" });
  expect(witness.calls.filter((call) => call.includes("/v1/acquisitions/") && !call.endsWith("/challenge"))).toHaveLength(1);
});

test("an email proof for another mailbox is refused before it reaches the issuer or Node", async () => {
  const share = await published();
  const witness = witnessFetch();
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch };
  const pending = await requestAgentShareEmailProof(share.url, options);
  const calls = witness.calls.length;
  await expect(completeAgentShareReceive({ ...pending, proof: { ...pending.proof, address: "other@example.com" } }, "12345678", options)).rejects.toMatchObject({ code: "authorization-denied" });
  expect(witness.calls).toHaveLength(calls);
});

test("an unaccepted email code keeps the existing stable proof error", async () => {
  const share = await published();
  const witness = makeWitness({ code: "12345678" });
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch as typeof globalThis.fetch };
  const pending = await requestAgentShareEmailProof(share.url, options);
  await expect(completeAgentShareReceive(pending, "00000000", options)).rejects.toMatchObject({ name: "EmailProofError", code: "CODE_REJECTED", recoverable: true });
});

test("expiry between code request and completion refuses without exchanging the code", async () => {
  const share = await published();
  const witness = witnessFetch();
  const options = { holder, registryOrigin: "https://registry.example", expectedOrigin: "https://share.tinycloud.xyz", fetch: witness.fetch };
  const pending = await requestAgentShareEmailProof(share.url, options);
  const calls = witness.calls.length;
  await expect(completeAgentShareReceive(pending, "12345678", { ...options, now: () => Date.now() + 60_000 })).rejects.toMatchObject({ code: "expired" });
  expect(witness.calls).toHaveLength(calls);
});

async function aesEncrypt(keyBytes: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  return Uint8Array.from([...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource))]);
}

test("a proved recipient session reads and decrypts the signed share; a refused read returns the stable error", async () => {
  const symmetricKey = key(41);
  const wrappedBytes = new Uint8Array(93).fill(17);
  const encryptedSymmetricKey = Buffer.from(wrappedBytes).toString("base64");
  const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;
  const encryptedSymmetricKeyHash = hex(sha256(new TextEncoder().encode(canonicalize(encryptedSymmetricKey))));
  const stored = new TextEncoder().encode(canonicalize({
    v: 1, networkId, alg: "x25519-aes256gcm/v1", keyVersion: 1, encryptedSymmetricKey,
    encryptedSymmetricKeyHash,
    ciphertext: Buffer.from(await aesEncrypt(symmetricKey, new TextEncoder().encode("hello recipient agent"))).toString("base64"),
    metadata: { contentType: "text/plain" },
  }));
  // A no-path (v1) source registers the canonical hash of the base64 key, not the raw-byte digest.
  const share = await published(new Date(Date.now() + 50_000), { encryptedSymmetricKeyDigestHex: encryptedSymmetricKeyHash, initialCiphertextDigestHex: hex(sha256(stored)) });
  const envelope = share.deliveryMaterial!.envelope;
  const witness = makeWitness({ code: "12345678" });
  const record = await signLocationRecord({ version: 1, subject: ownerDid, multiaddrs: [httpUrlToMultiaddr("https://node.example")], updated_at: new Date().toISOString(), sequence: 1 }, { type: "did:key", signBytes: async (bytes) => ed25519.sign(bytes, ownerKey) });
  const root = verifyCompactUcanAuthorization(envelope.policyRoot.authorization);
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
      remainingRedelegationDepth: 8, credentialIdAuditDigestHex: "9".repeat(64), presentationJtiAuditDigestHex: "a".repeat(64),
    }],
    proofs: [envelope.policyRoot.cid, envelope.enforcementRoot.cid],
    notBefore: now, expiresAt: now + 45, nonce: "session-1",
    sign: async (bytes) => ed25519.sign(bytes, nodeKey),
  });
  let refuseRead = false;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.hostname === "witness.credentials.org") return witness.fetch(input, init);
    if (url.hostname === "registry.example") return Response.json({ record });
    if (url.pathname === "/info") return Response.json({ nodeId: nodeDid });
    if (url.pathname === "/policy/v3/challenges") return Response.json({ challengeId: "challenge-1", nonce: "nonce-1", policyCid: envelope.policyCid, recipientDid: holder.did, nodeAudience: nodeDid, expiresAt: new Date(Date.now() + 45_000).toISOString() });
    if (url.pathname === "/policy/v3/delegations") return Response.json({ admitted: true, sessionCid: session.cid, authorization: session.authorization });
    if (url.pathname === "/delegate") return new Response(null, { status: 204 });
    if (url.pathname === "/invoke" && init?.body === undefined) return refuseRead ? new Response("refused", { status: 403 }) : new Response(stored);
    if (url.pathname === "/invoke") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      const receiverPublic = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64"));
      const ephemeral = key(42);
      const wrapped = await aesEncrypt(x25519.getSharedSecret(ephemeral, receiverPublic), symmetricKey);
      const invocation = verifyCompactUcanAuthorization(new Headers(init?.headers).get("Authorization")!);
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
  const credential = await completeEmailProofWithIssuerKeys({ pending: pending.proof, code: "12345678", holder, fetch: fetchFn }, witness.issuerKeys);
  const requirement = createEmailCredentialRequirement({ email: address, profile: envelope.policy.credentialRequirement.profile, credentialType: envelope.policy.credentialRequirement.credentialType });
  const opened = await openVerifiedAgentShare(pending, credential, requirement, options);
  expect(opened.text).toBe("hello recipient agent");
  expect(opened.untrusted).toBe(true);
  expect(calls).toContain("POST https://node.example/policy/v3/delegations");
  expect(calls).toContain("POST https://node.example/invoke");
  refuseRead = true;
  await expect(openVerifiedAgentShare(pending, credential, requirement, options)).rejects.toMatchObject({ code: "authorization-denied" });
});
