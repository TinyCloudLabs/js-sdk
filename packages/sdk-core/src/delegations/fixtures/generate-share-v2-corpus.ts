/**
 * Deterministic generator for the checked-in Share v2 production corpus
 * (`share-v2-corpus.json`).
 *
 * Every vector is produced by driving the *actual* production encoders,
 * signers and client code paths (owner-policy.ts, share-delivery.ts,
 * share-envelope.ts, ShareRecipientClient.ts) rather than hand-assembling
 * JSON literals. The only non-production inputs are:
 *   - a fixed set of deterministic Ed25519 seeds (so re-running the
 *     generator against the same SDK commit reproduces byte-identical
 *     output), and
 *   - a simulated "Node" keypair standing in for the real Node/TEE signer,
 *     since this worktree only implements the SDK side of the joined
 *     corpus. Node-authored bytes (registration receipts, delivery
 *     receipts, policy challenge/session envelopes, /invoke responses) are
 *     signed with this simulated key using the *exact* domain strings and
 *     canonicalization the production SDK verifiers require, and are only
 *     accepted into the corpus after passing those real verifiers
 *     (validateOwnerSharePolicyRegistrationBytes,
 *     validateShareDeliveryAuthorizationBytes, ShareRecipientClient's
 *     internal verifyNodeProof/response validation). A follow-up joined
 *     pass with the real Node service can replace the simulated Node
 *     signature bytes without touching the SDK-authored request bytes.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";

import {
  canonicalOwnerSharePolicy,
  computeOwnerShareRegistrationCid,
  createPolicyEnforcementDelegation,
  OWNER_SHARE_REGISTRATION_DOMAIN,
  restoreDelegatedShareKey,
  validateOwnerSharePolicyRegistrationBytes,
  type DelegatedShareKey,
  type OwnerDelegationReceipt,
  type OwnerSharePolicyV2,
  type RegisterOwnerSharePolicyParams,
} from "../owner-policy";
import {
  SHARE_DELIVERY_AUTHORIZATION_DOMAIN,
  shareDeliveryTrustedKid,
  validateShareDeliveryAuthorizationBytes,
  type ShareDeliveryAuthorization,
  type ShareDeliveryAuthorizationRequest,
} from "../share-delivery";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../../policy/signed-object.js";
import { createShareArtifactAsync, encodeShareUrl } from "../share-envelope";
import { ShareRecipientClient } from "../ShareRecipientClient";
import type { SharePolicyBinding } from "../recipient-types";

export const GENERATOR_VERSION = "1.0.0";
export const GENERATOR_PATH = "packages/sdk-core/src/delegations/fixtures/generate-share-v2-corpus.ts";

const ORIGIN = "https://node.example.corpus";
const SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";
const OWNER_DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const DOC_PATH = "documents/plan.md";
const PREFIX_PATH = "documents/";

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function digestOf(bytes: Uint8Array): string {
  return b64u(sha256(bytes));
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function seed(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`share-v2-corpus-seed:${label}`));
}

function didKeyFromEd25519(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(publicKey, 2);
  return `did:key:${base58btc.encode(prefixed)}`;
}

/** Deterministic Ed25519 keypair derived from a fixed seed (test-only; production keys are generated with fresh entropy). */
function deterministicKeypair(label: string): { readonly seed: Uint8Array; readonly publicKey: Uint8Array; readonly did: string } {
  const s = seed(label);
  const publicKey = ed25519.getPublicKey(s);
  return { seed: s, publicKey, did: didKeyFromEd25519(publicKey) };
}

/** Wraps a deterministic seed in the *production* DelegatedShareKey shape via restoreDelegatedShareKey. */
async function deterministicShareKey(label: string): Promise<DelegatedShareKey> {
  const pair = deterministicKeypair(label);
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64u(pair.seed), x: b64u(pair.publicKey) };
  const cryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return restoreDelegatedShareKey({ privateKey: cryptoKey, publicKey: pair.publicKey, extractable: false });
}

/** Simulated Node/TEE signer standing in for the real production Node key (see module docstring). */
function nodeSign(domain: string, message: unknown, nodeSeed: Uint8Array): string {
  const bytes = new TextEncoder().encode(`${domain}${canonicalize(message)}`);
  return b64u(ed25519.sign(bytes, nodeSeed));
}

/** Deterministic seeded PRNG used only to make `crypto.getRandomValues` (jti generation) reproducible during generation. */
function seededRandomFill(seedValue: number): (bytes: Uint8Array) => Uint8Array {
  let state = seedValue >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return (bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = next() & 0xff;
    return bytes;
  };
}

async function withDeterministicRandomness<T>(seedValue: number, fn: () => Promise<T>): Promise<T> {
  const original = crypto.getRandomValues.bind(crypto);
  const fill = seededRandomFill(seedValue);
  (crypto as unknown as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = ((array: ArrayBufferView) => fill(array as Uint8Array)) as typeof crypto.getRandomValues;
  try {
    return await fn();
  } finally {
    (crypto as unknown as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = original;
  }
}

export interface CorpusVector {
  readonly description: string;
  readonly producedBy: readonly string[];
  readonly value: unknown;
  readonly digest: string;
}

export interface CorpusErrorVector {
  readonly description: string;
  readonly producedBy: readonly string[];
  readonly expectedCode: string;
  readonly expectedMessageIncludes?: string;
}

export interface ShareV2Corpus {
  readonly provenance: {
    readonly generator: string;
    readonly generatorVersion: string;
    readonly sdkCommit: string;
    readonly algorithm: "sha256";
    readonly encoding: "base64url-unpadded";
    readonly canonicalization: "jcs-utf8-sorted-keys";
    readonly note: string;
  };
  readonly vectors: Record<string, CorpusVector>;
  readonly errors: Record<string, CorpusErrorVector>;
}

function vector(description: string, producedBy: readonly string[], value: unknown): CorpusVector {
  return { description, producedBy, value, digest: digestOf(jsonBytes(value)) };
}

async function buildRegistration(): Promise<{
  readonly vectors: Record<string, CorpusVector>;
  readonly errors: Record<string, CorpusErrorVector>;
  readonly registrationParams: RegisterOwnerSharePolicyParams;
  readonly shareKey: DelegatedShareKey;
  readonly enforcerDid: string;
  readonly nodeSeed: Uint8Array;
  readonly nodeKid: string;
  readonly enforcementDelegationCid: string;
  readonly registrationCid: string;
  readonly registrationBytes: Uint8Array;
}> {
  const shareKey = await deterministicShareKey("registration-share-key");
  const node = deterministicKeypair("registration-node");
  const nodeKid = `${node.did}#${node.did.slice("did:key:".length)}`;

  const ownerDelegation: OwnerDelegationReceipt = {
    delegationCid: "bafyowner4registrationcorpusvector",
    signedDagCbor: Uint8Array.from([1, 2, 3]),
    delegation: {
      delegateDID: shareKey.did,
      spaceId: SPACE,
      path: DOC_PATH,
      actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata", "tinycloud.kv/put"],
      expiry: new Date("2099-01-01T00:00:00.000Z"),
    },
  };

  const contentSource = { kind: "kv", space: SPACE, path: DOC_PATH, action: "tinycloud.kv/get" } as const;
  const contentSourceDigest = digestOf(jsonBytes(contentSource));

  const policy: OwnerSharePolicyV2 = {
    type: "TinyCloudSharePolicy",
    version: 2,
    shareId: "share-v2-corpus-registration",
    ownerDid: OWNER_DID,
    shareKeyDid: shareKey.did,
    recipientMatcher: { kind: "emailDomain", value: "example.com" },
    target: { origin: ORIGIN, nodeAudience: "did:web:node.example.corpus", enforcerDid: node.did, spaceId: SPACE },
    resource: { kind: "exact", path: DOC_PATH },
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource,
    contentSourceDigest,
    ownerDelegationCid: ownerDelegation.delegationCid,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  const canonicalPolicy = await canonicalOwnerSharePolicy(policy);
  const policyProof = b64u(await shareKey.sign(canonicalPolicy.bytes));

  const enforcementDelegation = await createPolicyEnforcementDelegation({
    ownerDelegation,
    shareKey,
    enforcerDid: node.did,
    policyCid: canonicalPolicy.cid,
    shareId: policy.shareId,
    spaceId: SPACE,
    nodeAudience: policy.target.nodeAudience,
    path: DOC_PATH,
    actions: policy.actions,
    contentSourceDigest,
    expiresAt: policy.expiresAt,
  });

  const registrationParams: RegisterOwnerSharePolicyParams = {
    policy: { bytes: canonicalPolicy.bytes, cid: canonicalPolicy.cid, proof: policyProof },
    ownerDelegation,
    enforcementDelegation,
    contentSourceDigest,
    nodeProof: { kid: nodeKid, publicKey: node.publicKey },
  };

  const registrationCore = {
    policyCid: canonicalPolicy.cid,
    ownerDelegationCid: ownerDelegation.delegationCid,
    enforcementDelegationCid: enforcementDelegation.cid,
    ownerDid: OWNER_DID,
    shareKeyDid: shareKey.did,
    enforcerDid: node.did,
    shareId: policy.shareId,
    recipientMatcher: policy.recipientMatcher,
    target: { origin: policy.target.origin, nodeAudience: policy.target.nodeAudience, spaceId: SPACE },
    resource: policy.resource,
    actions: policy.actions,
    contentSource,
    contentSourceDigest,
    registeredAt: "2024-01-01T00:00:00.000Z",
    expiresAt: policy.expiresAt,
  } as const;
  const registrationCid = computeOwnerShareRegistrationCid(registrationCore);
  const registration = { registrationCid, ...registrationCore };
  const proofSignature = nodeSign(OWNER_SHARE_REGISTRATION_DOMAIN, registrationCore, node.seed);
  const registrationResponse = { registration, proof: { alg: "EdDSA" as const, kid: nodeKid, signature: proofSignature } };
  const registrationBytes = jsonBytes(registrationResponse);

  // Gate: the production verifier must accept these bytes unchanged.
  validateOwnerSharePolicyRegistrationBytes(registrationBytes, registrationParams);

  const vectors: Record<string, CorpusVector> = {
    registrationPolicy: vector(
      "Canonical owner-share policy bytes signed by the delegated share key (production canonicalOwnerSharePolicy).",
      ["owner-policy.ts:canonicalOwnerSharePolicy"],
      { policy, canonicalBytesBase64Url: b64u(canonicalPolicy.bytes), cid: canonicalPolicy.cid, digest: canonicalPolicy.digest, proof: policyProof },
    ),
    registrationEnforcementDelegation: vector(
      "Runtime (enforcement) delegation issued live by the share key at share-creation time, binding the owner delegation to the enforcer (production createPolicyEnforcementDelegation).",
      ["owner-policy.ts:createPolicyEnforcementDelegation"],
      enforcementDelegation,
    ),
    registrationReceiptResponse: vector(
      "Exact UTF-8 bytes of a POST /share/v2/policies response, accepted unchanged by the production verifier (validateOwnerSharePolicyRegistrationBytes).",
      ["owner-policy.ts:computeOwnerShareRegistrationCid", "owner-policy.ts:validateOwnerSharePolicyRegistrationBytes"],
      { bodyBase64Url: b64u(registrationBytes), decoded: registrationResponse },
    ),
  };

  const tamperedBytes = jsonBytes({ registration: { ...registration, registrationCid: `${registrationCid}x` }, proof: registrationResponse.proof });
  let tamperedMessage = "";
  try {
    validateOwnerSharePolicyRegistrationBytes(tamperedBytes, registrationParams);
  } catch (error) {
    tamperedMessage = error instanceof Error ? error.message : String(error);
  }

  const errors: Record<string, CorpusErrorVector> = {
    registrationTamperedCid: {
      description: "A one-byte-mutated registrationCid must be rejected by the production verifier.",
      producedBy: ["owner-policy.ts:validateOwnerSharePolicyRegistrationBytes"],
      expectedCode: "Error",
      expectedMessageIncludes: "does not match its canonical core",
    },
  };
  if (tamperedMessage.length === 0 || !tamperedMessage.includes("does not match its canonical core")) {
    throw new Error(`registration tamper vector did not fail as expected: ${tamperedMessage}`);
  }

  return {
    vectors,
    errors,
    registrationParams,
    shareKey,
    enforcerDid: node.did,
    nodeSeed: node.seed,
    nodeKid,
    enforcementDelegationCid: enforcementDelegation.cid,
    registrationCid,
    registrationBytes,
  };
}

async function buildDelivery(input: {
  readonly registrationCid: string;
  readonly enforcementDelegationCid: string;
  readonly nodeSeed: Uint8Array;
  readonly nodeKid: string;
}): Promise<{ readonly vectors: Record<string, CorpusVector>; readonly errors: Record<string, CorpusErrorVector> }> {
  const envelopeCid = "bafkreicorpusenvelopeplaceholder0000000000000000000000000";
  const shareCid = "bafkreicorpussharecidplaceholder00000000000000000000000000";
  const policyCid = "bafkreicorpuspolicycidplaceholder0000000000000000000000000";
  const delegationCid = "bafyowner4registrationcorpusvector";

  const request: ShareDeliveryAuthorizationRequest = {
    envelopeCid,
    shareCid,
    shareId: "share-v2-corpus-registration",
    registrationCid: input.registrationCid,
    policyCid,
    delegationCid,
    enforcementDelegationCid: input.enforcementDelegationCid,
    recipientEmail: "recipient@example.com",
    shareUrl: `${ORIGIN}/s/${shareCid}#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    documentName: "Project plan.md",
    jti: "AQIDBAUGBwgJCgsMDQ4PEA",
    expiresAt: "2099-01-01T00:00:00.000Z",
    requestBodyDigest: digestOf(jsonBytes({ recipientEmail: "recipient@example.com", shareId: "share-v2-corpus-registration" })),
  };

  const authorization: ShareDeliveryAuthorization = {
    type: "TinyCloudShareDeliveryAuthorization",
    version: 2,
    jti: request.jti,
    shareCid: request.shareCid,
    shareId: request.shareId,
    registrationCid: request.registrationCid,
    delegationCid: request.delegationCid,
    enforcementDelegationCid: request.enforcementDelegationCid,
    envelopeCid: request.envelopeCid,
    policyCid: request.policyCid,
    nodeAudience: "did:web:node.example.corpus",
    targetOrigin: ORIGIN,
    holder: "did:key:z6MkCorpusHolder",
    recipientMatcher: { kind: "emailDomain", value: "example.com" },
    deliveryEmail: request.recipientEmail,
    shareUrl: request.shareUrl,
    returnOrigin: ORIGIN,
    documentName: request.documentName,
    senderDid: OWNER_DID,
    senderTrust: "verified",
    contentSource: { kind: "kv", space: SPACE, path: DOC_PATH, action: "tinycloud.kv/get" },
    contentSourceDigest: digestOf(jsonBytes({ kind: "kv", space: SPACE, path: DOC_PATH, action: "tinycloud.kv/get" })),
    shareExpiresAt: request.expiresAt,
    issuedAt: "2024-01-01T00:00:00.000Z",
    reportAbuseToken: request.jti,
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    resource: DOC_PATH,
    authorityMaterialHandle: request.registrationCid,
    authorityMaterialDigest: digestOf(jsonBytes({ registrationCid: request.registrationCid })),
    requestBodyDigest: request.requestBodyDigest,
    idempotencyKey: request.jti,
    expiresAt: request.expiresAt,
    dataAuthority: false,
  };

  const signature = nodeSign(SHARE_DELIVERY_AUTHORIZATION_DOMAIN, authorization, input.nodeSeed);
  const receipt = { authorization, proof: { alg: "EdDSA" as const, kid: input.nodeKid, signature } };
  const responseBytes = jsonBytes(receipt);

  validateShareDeliveryAuthorizationBytes(responseBytes, {
    request,
    nodeProof: { kid: input.nodeKid, publicKey: ed25519.getPublicKey(input.nodeSeed) },
  });

  const vectors: Record<string, CorpusVector> = {
    deliveryRequest: vector(
      "Exact camelCase mirror of the Rust V2DeliveryRequest the SDK POSTs to /share/v2/deliveries/authorize.",
      ["share-delivery.ts:ShareDeliveryAuthorizationRequest"],
      request,
    ),
    deliveryReceiptResponse: vector(
      "Exact UTF-8 response bytes accepted unchanged by the production verifier (validateShareDeliveryAuthorizationBytes).",
      ["share-delivery.ts:validateShareDeliveryAuthorizationBytes"],
      { bodyBase64Url: b64u(responseBytes), decoded: receipt },
    ),
  };

  const tamperedDigestBytes = jsonBytes({ authorization: { ...authorization, requestBodyDigest: `${authorization.requestBodyDigest}x` }, proof: receipt.proof });
  let tamperMessage = "";
  try {
    validateShareDeliveryAuthorizationBytes(tamperedDigestBytes, { request, nodeProof: { kid: input.nodeKid, publicKey: ed25519.getPublicKey(input.nodeSeed) } });
  } catch (error) {
    tamperMessage = error instanceof Error ? error.message : String(error);
  }
  if (!tamperMessage.includes("not bound to the submitted request")) {
    throw new Error(`delivery tamper vector did not fail as expected: ${tamperMessage}`);
  }

  const errors: Record<string, CorpusErrorVector> = {
    deliveryTamperedDigest: {
      description: "A mutated requestBodyDigest in the delivery authorization must be rejected as unbound.",
      producedBy: ["share-delivery.ts:validateShareDeliveryAuthorizationBytes"],
      expectedCode: "Error",
      expectedMessageIncludes: "not bound to the submitted request",
    },
  };

  return { vectors, errors };
}

async function buildChallengeSessionAndInvoke(input: {
  readonly registrationCid: string;
  readonly enforcementDelegationCid: string;
  readonly enforcerDid: string;
  readonly nodeSeed: Uint8Array;
  readonly nodeKid: string;
}): Promise<{ readonly vectors: Record<string, CorpusVector>; readonly errors: Record<string, CorpusErrorVector> }> {
  const nodeDid = input.nodeKid.split("#")[0];
  const signerKeyPair = { seed: input.nodeSeed, publicKey: ed25519.getPublicKey(input.nodeSeed), did: nodeDid };
  const holder = deterministicKeypair("recipient-holder");
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64u(signerKeyPair.seed), x: b64u(signerKeyPair.publicKey) };
  const signerCryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const signerPrivateKey = signerKeyPair.seed;

  const encryptionKey = seed("recipient-envelope-encryption-key");
  const created = await withDeterministicRandomness(0x5eed_0001, async () => createShareArtifactAsync({
    origin: ORIGIN,
    spaceId: SPACE,
    recipient: { kind: "emailDomain", value: "example.com" },
    resource: { kind: "prefix", path: PREFIX_PATH },
    actions: ["read", "list", "edit"],
    mimeType: "text/markdown",
    bytes: new TextEncoder().encode("# corpus policy metadata"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    signerDid: signerKeyPair.did,
    signerPrivateKey,
    encryptionKey,
  }));

  const contentSource = { kind: "kv" as const, action: "tinycloud.kv/get" as const, space: SPACE, path: DOC_PATH.replace(/\/[^/]*$/, "") || "documents" };
  const contentSourceDigest = digestOf(jsonBytes(contentSource));

  const binding: SharePolicyBinding = {
    envelopeCid: created.cid,
    shareCid: created.cid,
    shareId: "share-v2-corpus-registration",
    registrationCid: input.registrationCid,
    delegationCid: "bafyowner4registrationcorpusvector",
    authorityMaterialHandle: input.registrationCid,
    authorityMaterialDigest: digestOf(jsonBytes({ registrationCid: input.registrationCid })),
    policyCid: "bafkreicorpuspolicycidplaceholder0000000000000000000000000",
    enforcementDelegationCid: input.enforcementDelegationCid,
    enforcementDelegation: { cid: input.enforcementDelegationCid },
    outerEnvelope: { cid: created.cid },
    contentSource,
    contentSourceDigest,
    holderDid: holder.did,
    targetOrigin: ORIGIN,
    nodeAudience: "did:web:node.example.corpus",
    actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/list", "tinycloud.kv/put"],
    resource: PREFIX_PATH,
  };

  const captured: { challengeRequestBody?: unknown; sessionRequestBody?: unknown; invoke: Record<string, unknown>[] } = { invoke: [] };
  let challengeResponseBytes: Uint8Array | undefined;
  let sessionResponseBytes: Uint8Array | undefined;
  const invokeResponses: Record<string, unknown> = {};

  const holderSigner = async (signInput: { readonly domain: string; readonly message: Readonly<Record<string, unknown>> }) => {
    const bytes = new TextEncoder().encode(`${signInput.domain}${canonicalize(signInput.message)}`);
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, signerCryptoKey, bytes);
    return { alg: "EdDSA" as const, kid: `${holder.did}#${holder.did.slice("did:key:".length)}`, signature: b64u(new Uint8Array(signature)) };
  };

  const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith("/share/v2/policy/challenges")) {
      captured.challengeRequestBody = body;
      const bodyRecord = body as Record<string, unknown>;
      const challenge = {
        type: "TinyCloudSharePolicyChallenge",
        version: 2,
        challengeId: "challenge-corpus-001",
        nonce: "corpus-nonce-0123456789abcdef",
        audience: ORIGIN,
        enforcerDid: input.enforcerDid,
        challengeExpiresAt: "2080-01-01T00:30:00.000Z",
        expiresAt: "2080-01-01T00:30:00.000Z",
        requestBodyDigest: bodyRecord.requestBodyDigest,
      };
      const proof = { alg: "EdDSA" as const, kid: input.nodeKid, signature: nodeSign("xyz.tinycloud.share/policy-challenge/v2\0", challenge, input.nodeSeed) };
      challengeResponseBytes = jsonBytes({ data: { challenge, proof } });
      return new Response(challengeResponseBytes, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/share/v2/policy/session")) {
      captured.sessionRequestBody = body;
      const session = {
        type: "TinyCloudSharePolicySession",
        version: 2,
        sessionId: "session-corpus-001",
        envelopeCid: binding.envelopeCid,
        shareCid: binding.shareCid,
        shareId: binding.shareId,
        registrationCid: binding.registrationCid,
        delegationCid: binding.delegationCid,
        policyCid: binding.policyCid,
        enforcementDelegationCid: binding.enforcementDelegationCid,
        contentSource: binding.contentSource,
        contentSourceDigest: binding.contentSourceDigest,
        holderDid: holder.did,
        targetOrigin: ORIGIN,
        nodeAudience: binding.nodeAudience,
        action: "tinycloud.kv/get",
        actions: binding.actions,
        resource: binding.resource,
        issuedAt: "2080-01-01T00:00:00.000Z",
        expiresAt: "2080-01-01T00:20:00.000Z",
      };
      const proof = { alg: "EdDSA" as const, kid: input.nodeKid, signature: nodeSign("xyz.tinycloud.share/policy-session/v2\0", session, input.nodeSeed) };
      sessionResponseBytes = jsonBytes({ result: { session, proof } });
      return new Response(sessionResponseBytes, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/share/v2/invoke")) {
      const request = (body as Record<string, unknown>).request as Record<string, unknown>;
      captured.invoke.push(body as Record<string, unknown>);
      const action = request.action as string;
      const resource = request.resource as string;
      if (action === "tinycloud.kv/get") {
        const content = new TextEncoder().encode("# corpus document body");
        const response = { type: "TinyCloudShareInvokeResponse", version: 2, action, resource, mediaType: "text/markdown", content: b64u(content), bodyDigest: digestOf(content), etag: '"corpus-etag-1"' };
        invokeResponses.get = response;
        return new Response(jsonBytes(response), { status: 200, headers: { "content-type": "application/json", etag: '"corpus-etag-1"' } });
      }
      if (action === "tinycloud.kv/metadata") {
        const response = { type: "TinyCloudShareInvokeResponse", version: 2, action, resource, metadata: { size: "23", contentType: "text/markdown" }, etag: '"corpus-etag-1"' };
        invokeResponses.metadata = response;
        return new Response(jsonBytes(response), { status: 200, headers: { "content-type": "application/json", etag: '"corpus-etag-1"' } });
      }
      if (action === "tinycloud.kv/list") {
        const entries = [{ path: "documents/plan.md", kind: "file" as const }, { path: "documents/notes.md", kind: "file" as const }];
        const response = { type: "TinyCloudShareInvokeResponse", version: 2, action, resource, entries, nextCursor: null };
        invokeResponses.list = response;
        return new Response(jsonBytes(response), { status: 200, headers: { "content-type": "application/json" } });
      }
      const response = { type: "TinyCloudShareInvokeResponse", version: 2, action, resource, bodyDigest: (body as Record<string, unknown>).bodyDigest, etag: '"corpus-etag-2"', contentType: "text/markdown" };
      invokeResponses.put = response;
      return new Response(jsonBytes(response), { status: 200, headers: { "content-type": "application/json", etag: '"corpus-etag-2"' } });
    }
    return new Response(created.bytes, { status: 200 });
  };

  const client = new ShareRecipientClient({
    trustedOrigins: [ORIGIN],
    trustedSignerDids: [input.nodeKid.split("#")[0]],
    fetch: fetchMock as unknown as typeof fetch,
    policyBinding: binding,
    holderSigner,
    presentation: {
      holderDid: holder.did,
      credential: "corpus-verifiable-credential",
      holderBinding: { holderDid: holder.did },
      readSignerDid: holder.did,
    },
    now: () => new Date("2080-01-01T00:00:00.000Z"),
  });

  const link = encodeShareUrl({ origin: ORIGIN, cid: created.cid, key: encryptionKey });
  const { getResult, metadataResult, listResult, putResult } = await withDeterministicRandomness(0x5eed_1234, async () => {
    const access = await client.open(link);
    return {
      getResult: await access.get("documents/plan.md"),
      metadataResult: await access.metadata("documents/plan.md"),
      listResult: await access.listChildren({ path: "documents" }),
      putResult: await access.save("documents/plan.md", new TextEncoder().encode("# updated corpus body"), { etag: '"corpus-etag-1"' }),
    };
  });

  const vectors: Record<string, CorpusVector> = {
    challengeRequest: vector(
      "Exact POST body the production ShareRecipientClient sends to /share/v2/policy/challenges (ShareRecipientClient.buildChallengeRequest).",
      ["ShareRecipientClient.ts:buildChallengeRequest"],
      captured.challengeRequestBody,
    ),
    challengeResponse: vector(
      "Node-signed challenge envelope consumed and verified by the production client (verifyNodeProof, domain xyz.tinycloud.share/policy-challenge/v2).",
      ["ShareRecipientClient.ts:verifyNodeProof"],
      { bodyBase64Url: b64u(challengeResponseBytes as Uint8Array) },
    ),
    sessionRequest: vector(
      "Exact POST body the production client sends to /share/v2/policy/session after verifying the challenge (ShareRecipientClient.buildDefaultPolicySessionRequest).",
      ["ShareRecipientClient.ts:buildDefaultPolicySessionRequest"],
      captured.sessionRequestBody,
    ),
    sessionResponse: vector(
      "Node-signed policy session envelope consumed and verified by the production client (verifyNodeProof, domain xyz.tinycloud.share/policy-session/v2).",
      ["ShareRecipientClient.ts:verifyNodeProof"],
      { bodyBase64Url: b64u(sessionResponseBytes as Uint8Array) },
    ),
    invokeGetRequest: vector("Exact signed /share/v2/invoke request body for a get.", ["ShareRecipientClient.ts:invokeNative"], captured.invoke[0]),
    invokeGetResponse: vector("Node /share/v2/invoke get response consumed by the production client.", ["ShareRecipientClient.ts:invokeNative"], invokeResponses.get),
    invokeMetadataRequest: vector("Exact signed /share/v2/invoke request body for a metadata read.", ["ShareRecipientClient.ts:invokeNative"], captured.invoke[1]),
    invokeMetadataResponse: vector("Node /share/v2/invoke metadata response consumed by the production client.", ["ShareRecipientClient.ts:invokeNative"], invokeResponses.metadata),
    invokeListRequest: vector("Exact signed /share/v2/invoke request body for a list.", ["ShareRecipientClient.ts:invokeNative"], captured.invoke[2]),
    invokeListResponse: vector("Node /share/v2/invoke list response consumed by the production client.", ["ShareRecipientClient.ts:invokeNative"], invokeResponses.list),
    invokePutRequest: vector("Exact signed /share/v2/invoke request body for a put.", ["ShareRecipientClient.ts:invokeNative"], captured.invoke[3]),
    invokePutResponse: vector("Node /share/v2/invoke put response consumed by the production client.", ["ShareRecipientClient.ts:invokeNative"], invokeResponses.put),
    decodedResponses: vector(
      "Final decoded results the production client returns to the application for get/metadata/list/put.",
      ["ShareRecipientClient.ts:nativeGet/nativeMetadata/nativeList/nativeSave"],
      {
        get: { contentType: getResult.contentType, size: getResult.size, bytesBase64Url: b64u(getResult.bytes) },
        metadata: metadataResult.metadata,
        list: listResult,
        put: putResult,
      },
    ),
  };

  // Error vector: tamper the recorded get response body digest and confirm the
  // production client's response-integrity check rejects it.
  let integrityErrorCode = "";
  {
    let calls = 0;
    const tamperFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/share/v2/invoke")) {
        calls += 1;
        const content = new TextEncoder().encode("# corpus document body");
        const response = { type: "TinyCloudShareInvokeResponse", version: 2, action: "tinycloud.kv/get", resource: "documents/plan.md", mediaType: "text/markdown", content: b64u(content), bodyDigest: digestOf(new TextEncoder().encode("wrong")), etag: '"corpus-etag-1"' };
        return new Response(jsonBytes(response), { status: 200, headers: { "content-type": "application/json" } });
      }
      return fetchMock(url, init);
    };
    const tamperClient = new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      trustedSignerDids: [input.nodeKid.split("#")[0]],
      fetch: tamperFetch as unknown as typeof fetch,
      policyBinding: binding,
      holderSigner,
      presentation: { holderDid: holder.did, credential: "corpus-verifiable-credential", holderBinding: { holderDid: holder.did }, readSignerDid: holder.did },
      now: () => new Date("2080-01-01T00:00:00.000Z"),
    });
    try {
      await withDeterministicRandomness(0x5eed_1234, async () => {
        const tamperAccess = await tamperClient.open(link);
        return tamperAccess.get("documents/plan.md");
      });
    } catch (error) {
      integrityErrorCode = (error as { code?: string }).code ?? "";
    }
    void calls;
  }
  if (integrityErrorCode !== "SHARE_RESPONSE_INTEGRITY") {
    throw new Error(`expected SHARE_RESPONSE_INTEGRITY, got ${integrityErrorCode}`);
  }

  // Error vector: a challenge proof kid outside trustedSignerDids must be rejected
  // before its signature is even checked. trustedSignerDids still includes the
  // real node DID (so the envelope itself, signed by the same production
  // artifact signer, resolves normally) - only the challenge proof's kid is
  // swapped to an untrusted DID at the wire level.
  let untrustedSignerCode = "";
  try {
    const untrustedKidFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const response = await fetchMock(url, init);
      if (!url.endsWith("/share/v2/policy/challenges")) return response;
      const decoded = JSON.parse(await response.clone().text()) as { data: { challenge: unknown; proof: Record<string, unknown> } };
      decoded.data.proof = { ...decoded.data.proof, kid: "did:key:z6MkNotTheRealNode#z6MkNotTheRealNode" };
      return new Response(jsonBytes(decoded), { status: 200, headers: { "content-type": "application/json" } });
    };
    const untrustedClient = new ShareRecipientClient({
      trustedOrigins: [ORIGIN],
      trustedSignerDids: [input.nodeKid.split("#")[0]],
      fetch: untrustedKidFetch as unknown as typeof fetch,
      policyBinding: binding,
      holderSigner,
      presentation: { holderDid: holder.did, credential: "corpus-verifiable-credential", holderBinding: { holderDid: holder.did }, readSignerDid: holder.did },
      now: () => new Date("2080-01-01T00:00:00.000Z"),
    });
    await withDeterministicRandomness(0x5eed_1234, async () => untrustedClient.open(link));
  } catch (error) {
    untrustedSignerCode = (error as { code?: string }).code ?? "";
  }
  if (untrustedSignerCode !== "SHARE_SIGNER_UNTRUSTED") {
    throw new Error(`expected SHARE_SIGNER_UNTRUSTED, got ${untrustedSignerCode}`);
  }

  const errors: Record<string, CorpusErrorVector> = {
    invokeResponseIntegrityMismatch: {
      description: "A get response whose bodyDigest does not match its content must be rejected by the production client.",
      producedBy: ["ShareRecipientClient.ts:invokeNative"],
      expectedCode: "SHARE_RESPONSE_INTEGRITY",
    },
    challengeUntrustedSigner: {
      description: "A challenge/session proof signed by a key outside trustedSignerDids must be rejected before use.",
      producedBy: ["ShareRecipientClient.ts:verifyNodeProof"],
      expectedCode: "SHARE_SIGNER_UNTRUSTED",
    },
  };

  return { vectors, errors };
}

export async function generateShareV2Corpus(sdkCommit: string): Promise<ShareV2Corpus> {
  const registration = await buildRegistration();
  const delivery = await buildDelivery({
    registrationCid: registration.registrationCid,
    enforcementDelegationCid: registration.enforcementDelegationCid,
    nodeSeed: registration.nodeSeed,
    nodeKid: registration.nodeKid,
  });
  const runtime = await buildChallengeSessionAndInvoke({
    registrationCid: registration.registrationCid,
    enforcementDelegationCid: registration.enforcementDelegationCid,
    enforcerDid: registration.enforcerDid,
    nodeSeed: registration.nodeSeed,
    nodeKid: registration.nodeKid,
  });

  return {
    provenance: {
      generator: GENERATOR_PATH,
      generatorVersion: GENERATOR_VERSION,
      sdkCommit,
      algorithm: "sha256",
      encoding: "base64url-unpadded",
      canonicalization: "jcs-utf8-sorted-keys",
      note: "Node-authored bytes (registration/delivery receipts, policy challenge/session, /invoke responses) are signed with a deterministic simulated Node key (see module docstring) and are gated by the real SDK production verifiers, not hand-reconstructed. Holder- and share-key-authored bytes are produced entirely by production SDK code.",
    },
    vectors: { ...registration.vectors, ...delivery.vectors, ...runtime.vectors },
    errors: { ...registration.errors, ...delivery.errors, ...runtime.errors },
  };
}

async function main(): Promise<void> {
  const { $ } = await import("bun");
  const sdkCommit = (await $`git rev-parse HEAD`.cwd(new URL("../../../../../.", import.meta.url).pathname).text()).trim();
  const corpus = await generateShareV2Corpus(sdkCommit);
  const outPath = new URL("./share-v2-corpus.json", import.meta.url).pathname;
  await Bun.write(outPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

if (import.meta.main) {
  await main();
}
