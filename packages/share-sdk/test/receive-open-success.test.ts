import { describe, expect, it } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, toBase64Url, verifyCompactUcanAuthorization, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { addressedCredentialRequirement, publishAddressedShare, receiveShare, ShareReceiveError, type ShareOpenOptions } from "../src/index.js";
import { attackerSeed, didFor, enc, nodeDid, nodeSeed, ownerDid, ownerSeed, signedBinding, signedRoot } from "./support/signed-share.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const canonicalHashHex = (value: string): string => hex(sha256(enc(canonicalize(value))));
const cidFor = (text: string): string => CID.createV1(0x55, createDigest(0x1e, blake3(enc(text)))).toString();
const hex64 = (char: string): string => char.repeat(64);

const holderSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 61);
const holderDid = didFor(holderSeed);
const contentKey = Uint8Array.from({ length: 32 }, (_, index) => index + 81);
const wrappedKeyText = "network-wrapped-key";
const plaintext = "shared plaintext for the holder";
const path = "shares/note.md";
const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;

interface CeilingEntry { readonly kind: string; readonly resource: string; readonly action?: string; readonly actions?: readonly string[]; readonly selector?: string }

/** Mirror of `policyAttenuationForV3` (recipient.ts), which is not exported. */
function attenuationFor(envelope: ShareEnvelopeV3): Record<string, Record<string, unknown[]>> {
  const attenuation: Record<string, Record<string, unknown[]>> = {};
  for (const capability of envelope.policy.capabilityCeiling as unknown as readonly CeilingEntry[]) {
    if (capability.kind === "encryption") {
      attenuation[capability.resource] = { [capability.action as string]: [{}] };
      continue;
    }
    attenuation[capability.resource] = Object.fromEntries((capability.actions ?? []).map((action) => [action, [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }]]));
  }
  return attenuation;
}

async function aesEncrypt(key: Uint8Array, bytes: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  return Uint8Array.from([...nonce, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, bytes as BufferSource))]);
}

/** The node-signed policy session, assembled as the node does (see signedRoot for why it is not signCompactUcanAuthorization). */
function nodeSession(envelope: ShareEnvelopeV3): { readonly authorization: string; readonly cid: string } {
  const now = Math.floor(Date.now() / 1000);
  const binding = envelope.attestedEnforcerBinding as unknown as { readonly enforcerDid: string; readonly nodeAudience: string };
  const fact = {
    profile: "policy-session-ucan/v1", ownerDid, policyId: envelope.policy.policyId, policyDigestHex: hex64("a"), policyCid: envelope.policyCid,
    policyDelegationCid: envelope.policyRoot.cid, enforcementDelegationCid: envelope.enforcementRoot.cid,
    contentSourceDigestHex: envelope.contentSourceDigestHex, capabilityCeilingHashHex: hex64("b"), nativeProjectionHashHex: hex64("c"),
    enforcerDid: binding.enforcerDid, nodeAudience: binding.nodeAudience, recipientDid: holderDid, challengeId: "challenge-1",
    claimDigestHex: hex64("d"), claimJti: "claim-1", vpDigestHex: hex64("e"), credentialEvidenceDigestHex: hex64("f"),
    decisionContextDigestHex: hex64("1"), issuanceAuditDigestHex: hex64("2"), remainingRedelegationDepth: 0,
    credentialIdAuditDigestHex: hex64("3"), presentationJtiAuditDigestHex: hex64("4"),
  };
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: toBase64Url(ed25519.getPublicKey(nodeSeed)) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: attenuationFor(envelope), aud: holderDid, exp: Math.floor(Date.parse(envelope.expiry) / 1000), fct: [fact],
    iss: `${nodeDid}#${nodeDid.slice("did:key:".length)}`, nbf: now - 60, nnc: crypto.randomUUID(),
    prf: [envelope.policyRoot.cid, envelope.enforcementRoot.cid],
  };
  const head = toBase64Url(enc(canonicalize(header)));
  const body = toBase64Url(enc(canonicalize(payload)));
  const authorization = `${head}.${body}.${toBase64Url(ed25519.sign(enc(`${head}.${body}`), nodeSeed))}`;
  return { authorization, cid: cidFor(authorization) };
}

interface Published { readonly link: string; readonly envelope: ShareEnvelopeV3; readonly stored: Uint8Array }

/** Publish a real Policy/v3 addressed share over stored owner-KV ciphertext, as `publishAddressedShare` does in artifact-pin.test.ts. */
async function publishOpenShare(): Promise<Published> {
  const stored = enc(canonicalize({
    v: 1, networkId, alg: "x25519-aes256gcm/v1", keyVersion: 1, encryptedSymmetricKey: wrappedKeyText,
    encryptedSymmetricKeyHash: canonicalHashHex(wrappedKeyText), ciphertext: b64(await aesEncrypt(contentKey, enc(plaintext))),
    metadata: { contentType: "text/markdown" },
  }));
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000);
  let delivered: { readonly envelope: Readonly<Record<string, unknown>> } | undefined;
  const published = await publishAddressedShare({
    shareId: "openshare00000001", shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example",
    nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: "tinycloud:test-space",
    target: { kind: "email", address: "bob@example.com" },
    resource: { kind: "exact", path },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: "openshare00000001",
      kvResource: `tinycloud:test-space/kv/${path}`,
      selector: "exact",
      encryptionNetwork: networkId,
      encryptedSymmetricKeyDigestHex: canonicalHashHex(wrappedKeyText),
      keyVersion: 1,
      mode: "immutable",
      initialCiphertextDigestHex: hex(sha256(stored)),
    },
    credentialRequirement: addressedCredentialRequirement({ kind: "email", address: "bob@example.com" }),
    filename: "note.md",
    mediaType: "text/markdown",
    byteLength: stored.byteLength,
    expiresAt,
    onDeliveryMaterial: (material) => { delivered = material; },
    authority: {
      ownerDid,
      createOwnerRoot: async (input) => signedRoot(input),
      async sign(bytes) { return ed25519.sign(bytes, ownerSeed); },
      async registerPolicy(input) {
        return { policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid, attestedEnforcerBinding: signedBinding(expiresAt) };
      },
    },
  });
  if (delivered === undefined) throw new Error("publish did not deliver the envelope");
  return { link: published.url, envelope: delivered.envelope as unknown as ShareEnvelopeV3, stored };
}

interface Node {
  readonly fetchFn: typeof fetch;
  readonly calls: string[];
  readonly issuers: string[];
}

/** Fake owner node: challenge, delegation, delegate import, get and decrypt invoke. Every hit is recorded. */
function fakeNode(envelope: ShareEnvelopeV3, stored: Uint8Array): Node {
  const session = nodeSession(envelope);
  const calls: string[] = [];
  const issuers: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/policy/v3/challenges") {
      calls.push("POST /policy/v3/challenges");
      return Response.json({
        challengeId: "challenge-1", nonce: "nonce-1", policyCid: envelope.policyCid, recipientDid: holderDid, nodeAudience: nodeDid,
        enforcerDid: nodeDid, action: "tinycloud.kv/get", requestBodyDigest: hex64("0"), expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (url.pathname === "/policy/v3/delegations") {
      calls.push("POST /policy/v3/delegations");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.challengeId !== "challenge-1" || body.nonce !== "nonce-1") return new Response("stale challenge", { status: 409 });
      return Response.json({ admitted: true, sessionCid: session.cid, authorization: session.authorization });
    }
    if (url.pathname === "/delegate") {
      calls.push("POST /delegate");
      if (headers.get("Authorization") !== session.authorization) return new Response("unexpected session", { status: 403 });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/invoke") {
      const invocation = verifyCompactUcanAuthorization(headers.get("Authorization") ?? "");
      issuers.push(invocation.payload.iss.split("#", 1)[0]!);
      if (init?.body === undefined) {
        calls.push("POST /invoke get");
        return new Response(stored, { headers: { "content-type": "application/octet-stream" } });
      }
      calls.push("POST /invoke decrypt");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const receiverPublicKey = Uint8Array.from(Buffer.from(String(body.receiverPublicKey), "base64"));
      const ephemeralPrivate = Uint8Array.from({ length: 32 }, (_, index) => index + 23);
      const shared = x25519.getSharedSecret(ephemeralPrivate, receiverPublicKey);
      const wrapped = await aesEncrypt(shared, contentKey);
      const bodyHash = hex(sha256(enc(canonicalize(body))));
      const unsigned = {
        type: "tinycloud.encryption.decrypt-result/v1", targetNode: nodeDid, networkId: body.networkId, invocationCid: invocation.cid,
        encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash,
        wrappedKey: b64(Uint8Array.from([...x25519.getPublicKey(ephemeralPrivate), 1, ...wrapped])), alg: body.alg, keyVersion: body.keyVersion,
        requestHash: hex(sha256(enc(`${invocation.cid}${bodyHash}`))), nodeId: nodeDid,
      };
      return Response.json({ ...unsigned, nodeSignature: b64(ed25519.sign(enc(canonicalize(unsigned)), nodeSeed)) });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchFn, calls, issuers };
}

describe("receiveShare open flow, success path", () => {
  it("admits the holder, fetches the sealed content and returns the decrypted plaintext", async () => {
    const published = await publishOpenShare();
    const node = fakeNode(published.envelope, published.stored);
    let presentationSignCalls = 0;
    let decoySignCalls = 0;
    const open: ShareOpenOptions = {
      holderDid,
      sign: async (bytes) => { decoySignCalls += 1; return ed25519.sign(bytes, attackerSeed); },
      fetchFn: node.fetchFn,
      buildPresentation: async ({ challenge }) => ({
        holderDid,
        credential: "fixture-credential",
        holderBinding: {},
        proof: {},
        sign: async (bytes) => { presentationSignCalls += 1; return ed25519.sign(bytes, holderSeed); },
        presentation: { schema: "xyz.tinycloud.policy/presentation/v4", challengeId: challenge.challengeId, nonce: challenge.nonce },
        credentialEnvelope: { fixture: true },
        requirement: { kind: "email" },
      }),
    };

    const result = await receiveShare(published.link, { open });

    expect(result.state).toBeUndefined();
    if (!("bytes" in result)) throw new Error("expected an opened share");
    expect(new TextDecoder().decode(result.bytes)).toBe(plaintext);
    expect(result.mediaType).toBe("text/markdown");
    expect(node.calls).toEqual([
      "POST /policy/v3/challenges",
      "POST /policy/v3/delegations",
      "POST /delegate",
      "POST /invoke get",
      "POST /invoke decrypt",
    ]);
    // The presentation signer signs both invocations; the decoy `open.sign` is never used.
    expect(presentationSignCalls).toBe(2);
    expect(decoySignCalls).toBe(0);
    expect(node.issuers).toEqual([holderDid, holderDid]);
  });

  it("refuses content over the byte limit before any decrypt invocation", async () => {
    const published = await publishOpenShare();
    const node = fakeNode(published.envelope, published.stored);
    const open: ShareOpenOptions = {
      holderDid,
      sign: async (bytes) => ed25519.sign(bytes, attackerSeed),
      fetchFn: node.fetchFn,
      buildPresentation: async ({ challenge }) => ({
        holderDid,
        credential: "fixture-credential",
        holderBinding: {},
        proof: {},
        sign: async (bytes) => ed25519.sign(bytes, holderSeed),
        presentation: { schema: "xyz.tinycloud.policy/presentation/v4", challengeId: challenge.challengeId, nonce: challenge.nonce },
        credentialEnvelope: { fixture: true },
        requirement: { kind: "email" },
      }),
    };

    const error = await receiveShare(published.link, { open, maxContentBlobBytes: 16 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ShareReceiveError);
    expect((error as ShareReceiveError).code).toBe("max-bytes-exceeded");
    expect(node.calls).toEqual(["POST /policy/v3/challenges", "POST /policy/v3/delegations", "POST /delegate", "POST /invoke get"]);
  });

  it("refuses to open without a presentation builder before any network call", async () => {
    const published = await publishOpenShare();
    const node = fakeNode(published.envelope, published.stored);
    const transport: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      transport.push(String(input));
      return node.fetchFn(input, init);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      // Same valid link and holder as the success path; only the presentation builder is missing.
      // The builder is a required runtime input that TypeScript callers can omit at the JS boundary.
      const withoutBuilder = { holderDid, sign: async (bytes: Uint8Array) => ed25519.sign(bytes, holderSeed), fetchFn: spy } as unknown as ShareOpenOptions;
      const error = await receiveShare(published.link, { open: withoutBuilder }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ShareReceiveError);
      expect((error as ShareReceiveError).code).toBe("authorization-denied");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(transport).toEqual([]);
    expect(node.calls).toEqual([]);
  });
});
