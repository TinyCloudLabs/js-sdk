import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddress, Wallet } from "ethers";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import {
  getPolicyRootStatusV3,
  parseSignedCompactUcanAttenuation,
  parseSignedSiweCacao,
  revokePolicyRootV3,
} from "@tinycloud/sdk-core";
import {
  canonicalize,
  computeCid,
  didKeyFromEd25519PublicKey,
  shareEnvelopeV3Schema,
  type ShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import {
  createNativeShare,
  historyRecordForPublishedShare,
  parseNativeShareUrl,
  prepareAddressedShare,
  publishAddressedShare,
  ShareRecipientClient,
  type AddressedPolicyRegistrationReceipt,
  type PublishedShare,
} from "@tinycloud/share-sdk";
import { z } from "zod";
import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * TC-1432 slice 2, DESIGN-C §10 test 8 (C5), on a real local node.
 *
 * The owner wallet signs in twice: as the CLI agent session A and as the
 * owner's web client W. A publishes a native bearer link and Policy/v3
 * recipient-DID shares the way `packages/cli/src/share/adapters.ts` does; W
 * then tries the owner-side revocations DESIGN-C §6 relies on.
 *
 * Needs `TC_TEST_SERVER` (a local tinycloud-node in a temp datadir; never
 * production). Keys are throwaway. Nothing here prints key material, links,
 * `tc1` tokens or Authorization values: only shapes, statuses and node codes.
 */

const SHARE_ORIGIN = "https://share.c5.test";
const ENVELOPE_NODE_ORIGIN = "https://node.c5.test";
/** Set to write the signed-material fixtures (never private keys, links or tokens) for offline verifier tests. */
const FIXTURE_DIR = process.env.C5_FIXTURE_DIR;
const enc = (text: string) => new TextEncoder().encode(text);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Node and SDK boundary shapes, parsed once where they enter the test. */
const JsonObject = z.record(z.string(), z.unknown());
const FailureShape = z.object({
  message: z.string().optional(),
  status: z.number().optional(),
  meta: z.object({ status: z.number().optional() }).passthrough().optional(),
}).passthrough();
const ChallengeResponse = z.object({ challengeId: z.string(), nonce: z.string(), nodeAudience: z.string().optional() }).passthrough();
const MintResponse = z.object({ admitted: z.literal(true), sessionCid: z.string(), authorization: z.string() }).passthrough();
const RevokeReceipt = z.object({ revoked: z.unknown(), cid: z.unknown() }).passthrough();

const ownerKey = Wallet.createRandom().privateKey.slice(2);

function ownerClient(): TinyCloudNode {
  return new TinyCloudNode({
    host: SERVER_URL,
    signer: new PrivateKeySigner(ownerKey),
    domain: "c5-live.test",
    autoBootstrapAccount: false,
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoCreateSpace: true,
  });
}

/** Never let a link, fragment token or Authorization value reach output. */
function scrub(text: string): string {
  return text
    .replace(/#(?:k|tc1)=[^\s"']*/g, "#<redacted>")
    .replace(/tc1[:=][A-Za-z0-9._~%-]{16,}/g, "<tc1>")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>")
    .slice(0, 300);
}

function errorInfo(error: unknown): { status?: number; message: string } {
  const parsed = FailureShape.safeParse(error);
  const fields = parsed.success ? parsed.data : {};
  const status = fields.status ?? fields.meta?.status;
  const message = fields.message ?? String(error);
  return { ...(status === undefined ? {} : { status }), message: scrub(message) };
}

type Outcome = { ok: true; detail?: unknown } | { ok: false; status?: number; code?: string; message: string };

/** Observed results, printed once as `C5-RESULTS`. */
const observed: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Recipient-DID Policy/v3 admission (Policy/v1 schema: owner claim + holder presentation)
// ---------------------------------------------------------------------------

interface Holder {
  readonly did: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

function newHolder(): Holder {
  const secret = ed25519.utils.randomPrivateKey();
  return { did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(secret)), sign: async (bytes) => ed25519.sign(bytes, secret) };
}

type OwnerSign = (bytes: Uint8Array) => Promise<Uint8Array>;

/**
 * Claim/v2 (signed by the policy owner, i.e. agent session A) and
 * presentation/v2 (signed by the holder), field-for-field what
 * `validate_claim_and_presentation` in tinycloud-node `policy_v3.rs` admits.
 * The SDK has no builder for this pair; for a recipient-DID share the owner's
 * device-authorization step issues the claim.
 */
async function claimMaterial(input: {
  readonly challenge: { readonly challengeId: string; readonly nonce: string };
  readonly envelope: ShareEnvelopeV3;
  readonly holder: Holder;
  readonly ownerSign: OwnerSign;
}) {
  const owner = input.envelope.policy.ownerDid;
  const holder = input.holder.did;
  const issued = Math.floor(Date.now() / 1000) - 2;
  const common = {
    challengeId: input.challenge.challengeId,
    nonce: input.challenge.nonce,
    policyCid: input.envelope.policyCid,
    requestedCapabilities: input.envelope.policy.capabilityCeiling,
    issuedAt: new Date(issued * 1000).toISOString().replace(".000Z", "Z"),
    expiresAt: new Date((issued + 240) * 1000).toISOString().replace(".000Z", "Z"),
  };
  const claimUnsigned = {
    schema: "xyz.tinycloud.policy/claim/v2",
    jti: `jti_${crypto.randomUUID()}`,
    ...common,
    issuerDid: owner,
    subjectDid: holder,
    holderDid: holder,
    recipientDid: holder,
    credentialEvidence: [{ format: "tinycloud.recipient-did/v1", issuerDid: owner, subjectDid: holder, digestHex: createHash("sha256").update(holder).digest("hex") }],
  };
  const claimSignature = await input.ownerSign(createHash("sha256").update(`xyz.tinycloud.policy/Claim/v2\0${canonicalize(claimUnsigned)}`).digest());
  const claim = { ...claimUnsigned, signature: { suite: "Ed25519", signerDid: owner, value: b64url(claimSignature) } };
  const presentationUnsigned = {
    schema: "xyz.tinycloud.policy/presentation/v2",
    jti: `jti_${crypto.randomUUID()}`,
    ...common,
    holderDid: holder,
    subjectDid: holder,
    vpBytesBase64: b64url(enc(canonicalize(claim))),
  };
  const presentationSignature = await input.holder.sign(createHash("sha256").update(`xyz.tinycloud.policy/Presentation/v2\0${canonicalize(presentationUnsigned)}`).digest());
  const presentation = { ...presentationUnsigned, signature: { suite: "Ed25519", signerDid: holder, value: b64url(presentationSignature) } };
  return { claim, presentation };
}

interface PolicySession {
  readonly authorization: string;
  readonly cid: string;
}

/** The share-sdk ceremony: ShareRecipientClient.establishPolicySession(). */
async function sdkClaim(envelope: ShareEnvelopeV3, holder: Holder, ownerSign: OwnerSign): Promise<{ outcome: Outcome; client: ShareRecipientClient }> {
  const client = new ShareRecipientClient({
    nodeOrigin: SERVER_URL,
    envelope,
    holderDid: holder.did,
    sign: holder.sign,
    buildPresentation: async ({ challenge }) => {
      const { claim, presentation } = await claimMaterial({ challenge, envelope, holder, ownerSign });
      return { holderDid: holder.did, credential: "", holderBinding: {}, proof: {}, sign: holder.sign, claim, presentation };
    },
  });
  try {
    const session = await client.establishPolicySession();
    return { outcome: { ok: true, detail: { sessionCidPresent: session.sessionId.length > 0 } }, client };
  } catch (error) {
    return { outcome: { ok: false, ...errorInfo(error) }, client };
  }
}

/**
 * The same two node requests `establishV3` sends, without its client-side
 * challenge check (that check requires `nodeAudience` in the challenge).
 */
async function wireClaim(envelope: ShareEnvelopeV3, holder: Holder, ownerSign: OwnerSign): Promise<{ challenge: Outcome; mint?: Outcome; session?: PolicySession }> {
  const challengeResponse = await fetch(new URL("/policy/v3/challenges", SERVER_URL), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: envelope.policyCid, recipientDid: holder.did, requestedCapabilities: envelope.policy.capabilityCeiling }),
  });
  if (!challengeResponse.ok) {
    return { challenge: { ok: false, status: challengeResponse.status, code: scrub(await challengeResponse.text()), message: "challenge rejected" } };
  }
  const challenge = ChallengeResponse.parse(await challengeResponse.json());
  const challengeOutcome: Outcome = { ok: true, detail: { keys: Object.keys(challenge).sort(), hasNodeAudience: challenge.nodeAudience !== undefined } };
  const { claim, presentation } = await claimMaterial({ challenge, envelope, holder, ownerSign });
  const mintResponse = await fetch(new URL("/policy/v3/delegations", SERVER_URL), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: envelope.policyCid, challengeId: challenge.challengeId, nonce: challenge.nonce, claim, presentation, requestedExpiresAt: envelope.expiry }),
  });
  if (!mintResponse.ok) {
    return { challenge: challengeOutcome, mint: { ok: false, status: mintResponse.status, code: scrub(await mintResponse.text()), message: "mint rejected" } };
  }
  const minted = MintResponse.safeParse(await mintResponse.json());
  if (!minted.success) {
    return { challenge: challengeOutcome, mint: { ok: false, status: mintResponse.status, message: "mint response not admitted" } };
  }
  return { challenge: challengeOutcome, mint: { ok: true }, session: { authorization: minted.data.authorization, cid: minted.data.sessionCid } };
}

/** Read and decrypt through the share-sdk recipient client holding `session`. */
async function readWithSession(envelope: ShareEnvelopeV3, holder: Holder, session: PolicySession): Promise<{ invoke: Outcome; decrypt?: Outcome; text?: string }> {
  let client: ShareRecipientClient;
  try {
    client = new ShareRecipientClient({ nodeOrigin: SERVER_URL, envelope, holderDid: holder.did, sign: holder.sign, policyAuthorization: session });
  } catch (error) {
    return { invoke: { ok: false, message: `client refused session locally: ${errorInfo(error).message}` } };
  }
  const response = await client.nativeInvoke({ action: "get", resource: envelope.resource });
  if (!response.ok) return { invoke: { ok: false, status: response.status, code: scrub(await response.text()), message: "kv get rejected" } };
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    const opened = await client.decryptV3Content(bytes);
    return { invoke: { ok: true }, decrypt: { ok: true }, text: new TextDecoder().decode(opened.bytes) };
  } catch (error) {
    return { invoke: { ok: true }, decrypt: { ok: false, ...errorInfo(error) } };
  }
}

/** The CLI's native reader (`adapters.ts` nativeReader): receive without subdelegation, then read. */
async function openBearer(url: string): Promise<{ receive: Outcome; read?: Outcome; text?: string }> {
  const token = parseNativeShareUrl(url);
  const host = new TinyCloudNode({ autoDiscoverLocalNode: false }).sharing.decodeLink(token).host;
  const received = await new TinyCloudNode({ host, autoDiscoverLocalNode: false }).sharing.receive(token, { autoSubdelegate: false, useSessionKey: false });
  if (!received.ok) return { receive: { ok: false, ...errorInfo(received.error), code: received.error.code } };
  const value = await received.data.kv.get<Uint8Array>("", { binary: true });
  if (!value.ok) return { receive: { ok: true }, read: { ok: false, ...errorInfo(value.error), code: value.error.code } };
  const data = value.data.data;
  return { receive: { ok: true }, read: { ok: true }, ...(data instanceof Uint8Array ? { text: new TextDecoder().decode(data) } : {}) };
}

// ---------------------------------------------------------------------------
// Shared scenario state
// ---------------------------------------------------------------------------

let A: TinyCloudNode;
let W: TinyCloudNode;
let spaceId: string;
let nodeDid: string;
let agentSessionCid: string;

interface V3Share {
  readonly published: PublishedShare;
  readonly envelope: ShareEnvelopeV3;
  readonly registration: AddressedPolicyRegistrationReceipt;
  readonly text: string;
  /** When the publication finished: the sender record's `registeredAt`. */
  readonly registeredAt: Date;
}

const material: {
  bearer?: { url: string; delegationCid: string; text: string };
  v3?: V3Share;
  control?: V3Share;
  holder?: Holder;
  holderSession?: PolicySession;
  /** A second v3 share with an open recipient session, for the owner's generic root revocation (5f). */
  ownerRevoked?: { share: V3Share; holder: Holder; session: PolicySession };
} = {};

/** The CLI's addressed branch (`adapters.ts` targetAdapter) for a recipient-DID target. */
async function publishV3(text: string, holderDid: string): Promise<V3Share> {
  const activeNode = await A.activeNodeIdentity();
  const shareId = crypto.randomUUID().replaceAll("-", "");
  const filename = "doc.txt";
  const resourcePath = `shares/${shareId}/${filename}`;
  const mediaType = "text/plain";
  const policyActions: ("tinycloud.kv/get" | "tinycloud.kv/metadata")[] = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
  const prepared = prepareAddressedShare({ target: { kind: "recipientDid", did: holderDid }, actions: ["read"], policyActions, filename });
  // The CLI first publishes a registry location record (`publishActiveNodeLocation`);
  // a local node has no registry and nothing below reads it.
  const encrypted = await A.encryption.encryptToNetwork(A.getEncryptionNetworkIdForSpace(spaceId), enc(text), { metadata: { contentType: mediaType } });
  if (!encrypted.ok) throw new Error(`encryptToNetwork: ${encrypted.error.code}`);
  const storedBytes = enc(canonicalize(encrypted.data));
  const stored = await A.kvForSpace(spaceId).put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  if (!stored.ok) throw new Error(`addressed source put: ${stored.error.code}`);
  const contentSource = {
    shareId,
    kvResource: `${spaceId}/kv/${resourcePath}`,
    selector: "exact" as const,
    encryptionNetwork: encrypted.data.networkId,
    encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash,
    keyVersion: encrypted.data.keyVersion,
    mode: "immutable" as const,
    initialCiphertextDigestHex: createHash("sha256").update(storedBytes).digest("hex"),
  };
  let envelope: ShareEnvelopeV3 | undefined;
  let registration: AddressedPolicyRegistrationReceipt | undefined;
  const published = await publishAddressedShare({
    shareId,
    shareOrigin: SHARE_ORIGIN,
    // The signed envelope admits only an https node origin; the local node is
    // plain http. The origin is a routing label for recipients (who are told
    // SERVER_URL directly below); the node never sees the envelope.
    nodeOrigin: ENVELOPE_NODE_ORIGIN,
    nodeAudience: activeNode.nodeDid,
    enforcerDid: activeNode.nodeDid,
    spaceId,
    target: prepared.target,
    resource: { kind: "exact", path: resourcePath },
    actions: ["read"],
    policyActions,
    contentSource,
    filename,
    mediaType,
    byteLength: enc(text).byteLength,
    expiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000),
    onDeliveryMaterial: (delivery) => { envelope = shareEnvelopeV3Schema.parse(delivery.envelope); },
    authority: {
      ownerDid: A.credentialHolderDid,
      createOwnerRoot: (request) => A.createUnifiedOwnerRoot(request),
      sign: (bytes) => A.signSessionBytes(bytes),
      registerPolicy: async (request) => {
        registration = await A.registerPolicy(request);
        return registration;
      },
    },
  });
  if (envelope === undefined || registration === undefined) throw new Error("publication did not expose its envelope");
  return { published, envelope, registration, text, registeredAt: new Date() };
}

async function revokeRoot(input: { rootCid: string; role: "policy-authority" | "policy-enforcement"; issuerDid: string; sign: OwnerSign }): Promise<Outcome> {
  try {
    const receipt = await revokePolicyRootV3({
      nodeOrigin: SERVER_URL,
      rootCid: input.rootCid,
      targetRole: input.role,
      ownerDid: A.credentialHolderDid,
      issuerDid: input.issuerDid,
      nodeAudience: nodeDid,
      reason: "share revoked",
      sign: input.sign,
    });
    return { ok: true, detail: { keys: Object.keys(receipt).sort() } };
  } catch (error) {
    const info = errorInfo(error);
    const code = /HTTP \d+ - ([a-z0-9-]+)/.exec(info.message)?.[1];
    return { ok: false, ...info, ...(code === undefined ? {} : { code }) };
  }
}

const RootStatusResponse = z.object({
  state: z.string(),
  checkpoint: z.object({ nodeAudience: z.unknown(), issuerDid: z.unknown(), checkedAt: z.string(), freshUntil: z.string(), sequence: z.unknown() }).passthrough(),
}).passthrough();

/** The node's root state, plus whether sdk-core's `getPolicyRootStatusV3` accepts the signed checkpoint. */
async function rootState(rootCid: string): Promise<{ state: string; sdk: string; checkpoint?: unknown }> {
  const response = await fetch(new URL(`/policy/v3/status/${encodeURIComponent(rootCid)}`, SERVER_URL), { headers: { accept: "application/json" } });
  if (!response.ok) return { state: `HTTP ${response.status}: ${scrub(await response.text())}`, sdk: "not called" };
  const raw = RootStatusResponse.parse(await response.json());
  let sdk: string;
  try {
    sdk = (await getPolicyRootStatusV3({ nodeOrigin: SERVER_URL, rootCid, expectedNodeAudience: nodeDid })).state;
  } catch (error) {
    sdk = `error: ${errorInfo(error).message}`;
  }
  const { checkpoint } = raw;
  return {
    state: raw.state,
    sdk,
    ...(sdk.startsWith("error") ? {
      checkpoint: {
        keys: Object.keys(checkpoint).sort(),
        nodeAudienceIsNodeDid: checkpoint.nodeAudience === nodeDid,
        issuerIsNodeAudience: checkpoint.issuerDid === checkpoint.nodeAudience,
        sequence: checkpoint.sequence,
        freshWindowSeconds: (Date.parse(checkpoint.freshUntil) - Date.parse(checkpoint.checkedAt)) / 1000,
        freshUntilInFuture: Date.parse(checkpoint.freshUntil) > Date.now(),
      },
    } : {}),
  };
}

/** Owner client W's wallet-signed revocation of `cid` on the node's generic `POST /revoke` (the CLI owner-key path). */
async function ownerGenericRevoke(cid: string): Promise<{ status: number; revoked: unknown; cidMatches: boolean; code?: string }> {
  const authorization = await W.signOwnerRevocation(cid);
  const response = await fetch(`${(await W.activeNodeIdentity()).origin}/revoke`, { method: "POST", headers: { Authorization: authorization } });
  const body = await response.text();
  let json: unknown;
  try { json = JSON.parse(body); } catch { json = undefined; }
  const receipt = RevokeReceipt.safeParse(json);
  return {
    status: response.status,
    revoked: receipt.success ? receipt.data.revoked : undefined,
    cidMatches: receipt.success && receipt.data.cid === cid,
    ...(response.ok ? {} : { code: scrub(body) }),
  };
}

describe("C5: owner revocation of an agent session (live node)", () => {
  beforeAll(async () => {
    await checkServerHealth();
    A = ownerClient();
    await A.signIn();
    W = ownerClient();
    await W.signIn();
    spaceId = A.restorableSession!.spaceId;
    agentSessionCid = A.session!.delegationCid;
    nodeDid = (await A.activeNodeIdentity()).nodeDid;
    await A.ensureEncryptionNetwork(A.getEncryptionNetworkIdForSpace(spaceId));
    observed.setup = {
      sameOwnerSpace: W.restorableSession!.spaceId === spaceId,
      distinctSessionKeys: W.credentialHolderDid !== A.credentialHolderDid,
      distinctSessionDelegations: W.session!.delegationCid !== agentSessionCid,
      agentIsSessionOnly: A.isSessionOnly,
    };
  }, 120_000);

  test("step 1: agent A publishes a native bearer link (CLI bearer branch); a fresh recipient reads it", async () => {
    const text = `c5 bearer ${crypto.randomUUID()}`;
    const shareId = crypto.randomUUID().replaceAll("-", "");
    const resourcePath = `xyz.tinycloud.share/shares/${shareId}/note.txt`;
    const written = await A.kvForSpace(spaceId).put(resourcePath, enc(text), { contentType: "text/plain" });
    expect(written.ok).toBe(true);
    const native = await createNativeShare(A.sharing, {
      path: resourcePath,
      expiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000),
      viewerOrigin: SHARE_ORIGIN,
    });
    expect(native.spaceId).toBe(spaceId);
    material.bearer = { url: native.url, delegationCid: native.delegationCid, text };
    const opened = await openBearer(native.url);
    observed.step1 = { receive: opened.receive, read: opened.read, contentMatches: opened.text === text };
    expect(opened.receive.ok).toBe(true);
    expect(opened.read?.ok).toBe(true);
    expect(opened.text).toBe(text);
  }, 60_000);

  test("step 2: agent A publishes a Policy/v3 recipient-DID share; the recipient claims and reads it", async () => {
    const holder = newHolder();
    material.holder = holder;
    const share = await publishV3(`c5 v3 ${crypto.randomUUID()}`, holder.did);
    material.v3 = share;
    const ownerSign: OwnerSign = (bytes) => A.signSessionBytes(bytes);
    const viaSdk = await sdkClaim(share.envelope, holder, ownerSign);
    const step2: Record<string, unknown> = { sdkEstablishPolicySession: viaSdk.outcome };
    if (viaSdk.outcome.ok) {
      const response = await viaSdk.client.nativeInvoke({ action: "get", resource: share.envelope.resource });
      step2.sdkSessionRead = response.ok ? { ok: true } : { ok: false, status: response.status, code: scrub(await response.text()) };
    }
    // The SDK client keeps its session private, so mint one more over the
    // wire that the test can replay after the revocations.
    const wire = await wireClaim(share.envelope, holder, ownerSign);
    step2.wireChallenge = wire.challenge;
    step2.wireMint = wire.mint;
    observed.step2 = step2;
    expect(wire.mint?.ok).toBe(true);
    material.holderSession = wire.session;
    const sessionPayload = decodeJsonSegment(wire.session!.authorization.split(".")[1]);
    step2.recipientSessionLifetimeSeconds = Number(sessionPayload.exp) - Number(sessionPayload.nbf);
    const read = await readWithSession(share.envelope, holder, wire.session!);
    step2.read = { invoke: read.invoke, decrypt: read.decrypt, contentMatches: read.text === share.text };
    expect(read.invoke.ok).toBe(true);
    expect(read.decrypt?.ok).toBe(true);
    expect(read.text).toBe(share.text);
  }, 120_000);

  test("step 2b: agent A publishes a second v3 share whose recipient opens a policy session (for 5f)", async () => {
    const holder = newHolder();
    const share = await publishV3(`c5 v3 owner-revoked ${crypto.randomUUID()}`, holder.did);
    const wire = await wireClaim(share.envelope, holder, (bytes) => A.signSessionBytes(bytes));
    expect(wire.mint?.ok).toBe(true);
    material.ownerRevoked = { share, holder, session: wire.session! };
    const read = await readWithSession(share.envelope, holder, wire.session!);
    expect(read.text).toBe(share.text);
  }, 120_000);

  test("step 6 (control, before step 4): agent A revokes one of its own roots precisely", async () => {
    const holder = newHolder();
    const share = await publishV3(`c5 control ${crypto.randomUUID()}`, holder.did);
    material.control = share;
    const ownerSign: OwnerSign = (bytes) => A.signSessionBytes(bytes);
    const before = await wireClaim(share.envelope, holder, ownerSign);
    // `tc share revoke` default scope: the enforcement root, role policy-enforcement.
    const revoked = await revokeRoot({ rootCid: share.envelope.enforcementRoot.cid, role: "policy-enforcement", issuerDid: A.credentialHolderDid, sign: ownerSign });
    const state = await rootState(share.envelope.enforcementRoot.cid);
    const after = await wireClaim(share.envelope, newHolder(), ownerSign);
    const replay = before.session === undefined ? undefined : await readWithSession(share.envelope, holder, before.session);
    observed.step6 = {
      mintBefore: before.mint,
      revoke: revoked,
      enforcementRootState: state,
      freshClaimAfter: { challenge: after.challenge, mint: after.mint },
      priorSessionReadAfter: replay && { invoke: replay.invoke, decrypt: replay.decrypt },
    };
    expect(revoked.ok).toBe(true);
    expect(state.state).toBe("revoked");
  }, 120_000);

  // Only the JSON root-revocation route (`revokePolicyRootV3`) checks the
  // issuer against the root's ownerDid. The generic `/revoke` route accepts
  // the owner wallet's CACAO over a root CID (5f).
  test("step 3: the JSON root-revocation route refuses owner client W on agent A's v3 roots (403 root-revocation-issuer-invalid)", async () => {
    const { envelope } = material.v3!;
    const wSign: OwnerSign = (bytes) => W.signSessionBytes(bytes);
    const ownerPkh = `did:pkh:eip155:${W.session!.chainId}:${getAddress(W.session!.address)}`;
    const attempts = {
      // W's session key as issuer, on both roots.
      wSessionOnEnforcementRoot: await revokeRoot({ rootCid: envelope.enforcementRoot.cid, role: "policy-enforcement", issuerDid: W.credentialHolderDid, sign: wSign }),
      wSessionOnPolicyRoot: await revokeRoot({ rootCid: envelope.policyRoot.cid, role: "policy-authority", issuerDid: W.credentialHolderDid, sign: wSign }),
      // The owner wallet as issuer. Root revocations carry only Ed25519
      // signatures, which a wallet cannot make; the node checks the issuer
      // before the signature, so this probes the issuer rule.
      ownerWalletOnEnforcementRoot: await revokeRoot({ rootCid: envelope.enforcementRoot.cid, role: "policy-enforcement", issuerDid: ownerPkh, sign: wSign }),
    };
    const states = { policyRoot: await rootState(envelope.policyRoot.cid), enforcementRoot: await rootState(envelope.enforcementRoot.cid) };
    const read = await readWithSession(envelope, material.holder!, material.holderSession!);
    observed.step3 = { attempts, rootStatesAfter: states, recipientReadAfter: { invoke: read.invoke, decrypt: read.decrypt } };
    for (const attempt of Object.values(attempts)) {
      expect(attempt).toMatchObject({ ok: false, status: 403, code: "root-revocation-issuer-invalid" });
    }
    expect({ policyRoot: states.policyRoot.state, enforcementRoot: states.enforcementRoot.state }).toEqual({ policyRoot: "active", enforcementRoot: "active" });
    expect(read.decrypt?.ok).toBe(true);
  }, 60_000);

  test("step 4: owner client W revokes the owner->A session delegation with an owner-signed revocation", async () => {
    const result = await ownerGenericRevoke(agentSessionCid);
    observed.step4 = result;
    expect(result).toMatchObject({ status: 200, revoked: true, cidMatches: true });
  }, 60_000);

  describe("step 5: after the session revocation (DESIGN-C §6 [INFERENCE] under test)", () => {
    test("5a: the agent's bearer link no longer opens", async () => {
      const opened = await openBearer(material.bearer!.url);
      observed.step5a = { receive: opened.receive, read: opened.read, contentReturned: opened.text !== undefined };
      expect(opened.text).toBeUndefined();
    }, 60_000);

    test("5b: a fresh claim of the agent's v3 share fails", async () => {
      const { envelope } = material.v3!;
      const ownerSign: OwnerSign = (bytes) => A.signSessionBytes(bytes);
      const viaSdk = await sdkClaim(envelope, newHolder(), ownerSign);
      const fresh = newHolder();
      const wire = await wireClaim(envelope, fresh, ownerSign);
      const read = wire.session === undefined ? undefined : await readWithSession(envelope, fresh, wire.session);
      const states = { policyRoot: await rootState(envelope.policyRoot.cid), enforcementRoot: await rootState(envelope.enforcementRoot.cid) };
      observed.step5b = {
        sdkEstablishPolicySession: viaSdk.outcome,
        wireChallenge: wire.challenge,
        wireMint: wire.mint,
        freshSessionRead: read && { invoke: read.invoke, decrypt: read.decrypt },
        rootStates: states,
      };
      expect(wire.mint?.ok ?? false).toBe(false);
      expect(read?.text).toBeUndefined();
    }, 60_000);

    // Finding: DESIGN-C §6 assumed the owner->session cascade stops every v3
    // share of the agent session. It stops new claims (5b) but not a policy
    // session minted before it; that session reads until its own expiry
    // (step2.recipientSessionLifetimeSeconds, ~3,598 s). The node liveness
    // check (N3, test B-1) closes this. Today a root revocation ends it: by
    // the agent's key on the JSON route (5e), or by the owner wallet on the
    // generic /revoke route (5f).
    test("5c: an open v3 policy session SURVIVES the owner→session cascade until its own expiry (DESIGN-C §6 [INFERENCE] is false)", async () => {
      const { envelope, text } = material.v3!;
      const read = await readWithSession(envelope, material.holder!, material.holderSession!);
      const sessionPayload = decodeJsonSegment(material.holderSession!.authorization.split(".")[1]);
      const sessionSecondsRemaining = Number(sessionPayload.exp) - Math.floor(Date.now() / 1000);
      observed.step5c = { invoke: read.invoke, decrypt: read.decrypt, contentReturned: read.text !== undefined, sessionSecondsRemaining };
      expect(sessionSecondsRemaining).toBeGreaterThan(0);
      expect(read.invoke.ok).toBe(true);
      expect(read.decrypt?.ok).toBe(true);
      expect(read.text).toBe(text);
    }, 60_000);

    test("5d (informative): agent A's own session and owner client W after the revocation", async () => {
      const results: Record<string, unknown> = {};
      for (const [name, client] of [["agentKvGet", A], ["ownerClientKvGet", W]] as const) {
        const result = await client.kvForSpace(spaceId).get(`xyz.tinycloud.share/none-${crypto.randomUUID()}`);
        results[name] = result.ok ? { ok: true } : { ok: false, code: result.error.code, ...errorInfo(result.error) };
      }
      observed.step5d = results;
    }, 60_000);

    test("5f: the owner wallet revokes agent A's v3 roots through the generic /revoke route; the open recipient session then gets 403 root-revoked", async () => {
      const { share, holder, session } = material.ownerRevoked!;
      const before = await readWithSession(share.envelope, holder, session);
      const policyRoot = await ownerGenericRevoke(share.envelope.policyRoot.cid);
      const enforcementRoot = await ownerGenericRevoke(share.envelope.enforcementRoot.cid);
      const states = { policyRoot: await rootState(share.envelope.policyRoot.cid), enforcementRoot: await rootState(share.envelope.enforcementRoot.cid) };
      const after = await readWithSession(share.envelope, holder, session);
      observed.step5f = {
        openSessionBefore: { invoke: before.invoke, decrypt: before.decrypt },
        policyRoot,
        enforcementRoot,
        rootStatesAfter: states,
        openSessionAfter: { invoke: after.invoke, decrypt: after.decrypt, contentReturned: after.text !== undefined },
      };
      expect(before.text).toBe(share.text);
      expect(policyRoot).toMatchObject({ status: 200, revoked: true, cidMatches: true });
      expect(enforcementRoot).toMatchObject({ status: 200, revoked: true, cidMatches: true });
      expect(after.invoke).toMatchObject({ ok: false, status: 403, code: "root-revoked" });
    }, 60_000);

    test("5e (control): agent A, its session delegation revoked, can still revoke its own v3 root, which ends the open recipient session", async () => {
      const { envelope } = material.v3!;
      const revoked = await revokeRoot({ rootCid: envelope.enforcementRoot.cid, role: "policy-enforcement", issuerDid: A.credentialHolderDid, sign: (bytes) => A.signSessionBytes(bytes) });
      const state = await rootState(envelope.enforcementRoot.cid);
      const read = await readWithSession(envelope, material.holder!, material.holderSession!);
      observed.step5e = { agentRootRevoke: revoked, enforcementRootState: state, recipientSessionReadAfter: { invoke: read.invoke, decrypt: read.decrypt, contentReturned: read.text !== undefined } };
      console.log(`C5-RESULTS ${JSON.stringify(observed)}`);
      expect(revoked.ok).toBe(true);
      expect(state.state).toBe("revoked");
      expect(read.invoke).toMatchObject({ ok: false, status: 403, code: "root-revoked" });
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
// Structural report of the real delegation material (shapes only, no values)
// ---------------------------------------------------------------------------

function typeMap(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, typeOf(value[key])]));
}

function decodeJsonSegment(segment: string | undefined): Record<string, unknown> {
  return JsonObject.parse(JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8")));
}

describe("C5-SHAPES: structural report of the agent's signed material", () => {
  test("emit shapes and the raw fixture", async () => {
    const bearer = material.bearer;
    const v3Share = material.v3;
    if (bearer === undefined || v3Share === undefined) throw new Error("scenario material is missing; run the C5 scenario first");
    const token = parseNativeShareUrl(bearer.url);
    const decoded = A.sharing.decodeLink(token);
    const shareIds = [decoded.path.split("/").at(-2) ?? "", v3Share.published.metadata.shareId, material.control?.published.metadata.shareId ?? ""].filter((id) => id.length > 0);
    const pattern = (value: string): string => {
      let out = value.split(spaceId).join("<space>");
      for (const id of shareIds) out = out.split(id).join("<shareId>");
      return out
        .replace(/0x[0-9a-fA-F]{40}/g, "<addr>")
        .replace(/did:key:z[1-9A-HJ-NP-Za-km-z]+/g, "<did:key>")
        .replace(/#z[1-9A-HJ-NP-Za-km-z]+/g, "#<fragment>")
        .replace(/[0-9a-f]{64}/g, "<hex64>");
    };
    const attShape = (att: unknown): unknown => {
      const resources = JsonObject.safeParse(att);
      if (!resources.success) return typeOf(att);
      return Object.fromEntries(Object.entries(resources.data).map(([resource, abilitiesValue]) => {
        const abilities = JsonObject.safeParse(abilitiesValue);
        if (!abilities.success) return [pattern(resource), typeOf(abilitiesValue)];
        return [pattern(resource), Object.fromEntries(Object.entries(abilities.data).map(([ability, caveats]) => [
          ability,
          Array.isArray(caveats)
            ? caveats.map((caveatValue: unknown) => {
              const caveat = JsonObject.safeParse(caveatValue);
              if (!caveat.success) return typeOf(caveatValue);
              const { type, kind, value } = caveat.data;
              return {
                keys: typeMap(caveat.data),
                ...(typeof type === "string" ? { type } : {}),
                ...(typeof kind === "string" ? { kind } : {}),
                ...(typeof value === "string" ? { value: pattern(value) } : {}),
              };
            })
            : typeOf(caveats),
        ]))];
      }));
    };
    const didForm = (did: string) => ({
      form: pattern(did),
      hasFragment: did.includes("#"),
      fragmentIsOwnMultibase: did.includes("#") && did.split("#")[1] === did.split("#", 1)[0].slice("did:key:".length),
      equalsAgentSessionDid: did === A.sessionDid,
      bareEqualsAgentHolderDid: did.split("#", 1)[0] === A.credentialHolderDid,
    });
    const ucanShape = (authorization: string, cid: string) => {
      const segments = authorization.split(".");
      const header = decodeJsonSegment(segments[0]);
      const payload = decodeJsonSegment(segments[1]);
      let parsed: Record<string, unknown>;
      try {
        parsed = { accepted: true, cidMatches: parseSignedCompactUcanAttenuation(authorization, cid).cid === cid };
      } catch (error) {
        parsed = { accepted: false, error: errorInfo(error).message };
      }
      const prf = Array.isArray(payload.prf) ? payload.prf : [];
      return {
        segments: segments.length,
        headerKeys: Object.keys(header).sort(),
        headerAlg: header.alg,
        headerTyp: header.typ,
        payloadKeys: typeMap(payload),
        iss: didForm(String(payload.iss)),
        aud: { form: pattern(String(payload.aud)), hasFragment: String(payload.aud).includes("#") },
        prfLength: prf.length,
        prfElementTypes: prf.map(typeOf),
        prf0IsAgentSessionDelegation: prf[0] === agentSessionCid,
        att: attShape(payload.att),
        factsShape: Array.isArray(payload.fct)
          ? payload.fct.map((fact: unknown) => {
            const parsedFact = JsonObject.safeParse(fact);
            return parsedFact.success ? typeMap(parsedFact.data) : typeOf(fact);
          })
          : typeOf(payload.fct),
        nbfPresent: payload.nbf !== undefined,
        expPresent: payload.exp !== undefined,
        parseSignedCompactUcanAttenuation: parsed,
      };
    };

    // Bearer link delegation.
    const linkAuth = (decoded.delegation.authHeader ?? "").replace(/^Bearer\s+/i, "");
    const linkUcan = ucanShape(linkAuth, decoded.delegation.cid);
    const link = {
      delegationCidMatchesShare: decoded.delegation.cid === bearer.delegationCid,
      keyDid: { form: pattern(decoded.keyDid), hasFragment: decoded.keyDid.includes("#") },
      audIsLinkKey: linkUcan.segments === 3 && String(decodeJsonSegment(linkAuth.split(".")[1]).aud).split("#", 1)[0] === decoded.keyDid.split("#", 1)[0],
      ...linkUcan,
    };

    // Agent session: owner -> session SIWE CACAO.
    const session = A.session!;
    const sessionAuth = session.delegationHeader.Authorization.replace(/^Bearer\s+/i, "");
    let sessionShape: Record<string, unknown>;
    try {
      const cacao = await parseSignedSiweCacao(sessionAuth, agentSessionCid);
      const address = /0x[0-9a-fA-F]{40}$/.exec(cacao.issuer)?.[0] ?? "";
      sessionShape = {
        base64urlDagCbor: /^[A-Za-z0-9_-]+$/.test(sessionAuth),
        parseSignedSiweCacao: { accepted: true, cidMatches: cacao.cid === agentSessionCid },
        issuerForm: pattern(cacao.issuer),
        issuerAddressCase: address === getAddress(address) ? "checksummed" : address === address.toLowerCase() ? "lowercase" : "mixed",
        issuerChainMatchesSession: cacao.issuer.startsWith(`did:pkh:eip155:${session.chainId}:`),
        audience: didForm(cacao.audience),
        expiresAtPresent: cacao.expiresAt !== undefined,
        nbfPresentInSiwe: /\nNot Before: /.test(session.siwe),
        attenuation: attShape(cacao.attenuation),
      };
    } catch (error) {
      sessionShape = { base64urlDagCbor: /^[A-Za-z0-9_-]+$/.test(sessionAuth), parseSignedSiweCacao: { accepted: false, error: errorInfo(error).message } };
    }

    // Policy/v3 roots, policy, attested enforcer binding.
    const { envelope, registration } = v3Share;
    const infoRecord = JsonObject.parse(await (await fetch(new URL("/info", SERVER_URL))).json());
    const infoDidKeys = Object.keys(infoRecord).filter((key) => typeof infoRecord[key] === "string" && String(infoRecord[key]).startsWith("did:"));
    const binding = envelope.attestedEnforcerBinding;
    const signerDid = binding.signature.signerDid;
    const v3 = {
      policyKeys: typeMap(envelope.policy),
      policySchema: envelope.policy.schema,
      policyCidAlgorithmMatches: (await computeCid(enc(canonicalize(envelope.policy)))) === envelope.policyCid,
      policyOwnerIsAgentHolderDid: envelope.policy.ownerDid === A.credentialHolderDid,
      policyRoot: { roleField: envelope.policyRoot.role, ...ucanShape(envelope.policyRoot.authorization, envelope.policyRoot.cid) },
      enforcementRoot: { roleField: envelope.enforcementRoot.role, ...ucanShape(envelope.enforcementRoot.authorization, envelope.enforcementRoot.cid) },
      enforcementRootAudIsNode: decodeJsonSegment(envelope.enforcementRoot.authorization.split(".")[1]).aud === nodeDid,
      attestedEnforcerBinding: {
        keys: typeMap(binding),
        signatureKeys: typeMap(binding.signature),
        signerDidForm: pattern(signerDid),
        signerDidHasFragment: signerDid.includes("#"),
        signerBareEqualsNodeDid: signerDid.split("#", 1)[0] === nodeDid,
        enforcerDidEqualsNodeDid: binding.enforcerDid === nodeDid,
        nodeAudienceEqualsNodeDid: binding.nodeAudience === nodeDid,
        equalsRegistrationReceiptBinding: canonicalize(binding) === canonicalize(registration.attestedEnforcerBinding),
      },
      registrationReceiptKeys: typeMap({ ...registration }),
      nodeDid: {
        form: pattern(nodeDid),
        infoKeys: Object.keys(infoRecord).sort(),
        infoDidFields: Object.fromEntries(infoDidKeys.map((key) => [key, { form: pattern(String(infoRecord[key])), equalsActiveNodeIdentity: infoRecord[key] === nodeDid }])),
      },
    };

    console.log(`C5-SHAPES ${JSON.stringify({ link, session: sessionShape, v3 })}`);

    // Raw signed objects for verifier tests. Signatures from throwaway keys on
    // a temp node; no private key, JWK `d`, link URL or tc1 token.
    if (FIXTURE_DIR !== undefined) mkdirSync(FIXTURE_DIR, { recursive: true });
    const fixture = {
      description: "TC-1432 slice 2 C5 live material: signatures from throwaway keys on a temp local tinycloud-node",
      generatedAt: new Date().toISOString(),
      ownerDid: `did:pkh:eip155:${session.chainId}:${getAddress(session.address)}`,
      agentSessionDid: A.sessionDid,
      agentHolderDid: A.credentialHolderDid,
      spaceId,
      nodeDid,
      link: {
        delegationCid: decoded.delegation.cid,
        authorization: linkAuth,
        keyDid: decoded.keyDid,
        path: decoded.path,
        resource: `${spaceId}/kv/${decoded.path}`,
      },
      agentSession: { delegationCid: agentSessionCid, authorization: sessionAuth, siwe: session.siwe },
      v3: {
        shareId: v3Share.published.metadata.shareId,
        policyCid: envelope.policyCid,
        policy: envelope.policy,
        policyRoot: envelope.policyRoot,
        enforcementRoot: envelope.enforcementRoot,
        attestedEnforcerBinding: envelope.attestedEnforcerBinding,
        contentSource: envelope.contentSource,
        contentSourceDigestHex: envelope.contentSourceDigestHex,
        registration,
        recipientMatcher: envelope.recipientMatcher,
        expiry: envelope.expiry,
      },
    };
    const serialized = JSON.stringify(fixture, null, 2);
    if (/"d"\s*:|#k=|tc1[:=]|\/viewer#/.test(serialized)) throw new Error("fixture would contain secret material");
    if (FIXTURE_DIR !== undefined) writeFileSync(join(FIXTURE_DIR, "c5-material.json"), `${serialized}\n`, { mode: 0o600 });

    // Chain fixture for real-data verifier unit tests: signed objects and the
    // sender-record fields only. The record comes from the SDK's own
    // `historyRecordForPublishedShare`; its link and delivery secrets are dropped.
    const history = historyRecordForPublishedShare(v3Share.published, v3Share.registeredAt);
    const chainFixture = {
      generatedAt: new Date().toISOString(),
      ownerDid: fixture.ownerDid,
      spaceId,
      agentDid: A.credentialHolderDid,
      sessionCid: agentSessionCid,
      sessionAuthorization: sessionAuth,
      link: { authorization: linkAuth, cid: decoded.delegation.cid, resourcePath: decoded.path },
      v3: {
        envelope,
        shareId: history.shareId,
        policyCid: history.policyCid,
        policyRootCid: history.ownerDelegationCid,
        enforcementRootCid: history.enforcementDelegationCid,
        resource: history.resource,
        target: { origin: history.target.origin, nodeAudience: history.target.nodeAudience, spaceId: history.target.spaceId },
        actions: history.actions,
        targetKind: history.targetKind,
        recipientMatcher: history.recipientMatcher,
        registeredAt: history.registeredAt,
        expiresAt: history.expiresAt,
      },
    };
    const chainSerialized = JSON.stringify(chainFixture, null, 2);
    if (/"d"\s*:|#k=|tc1[:=]|\/viewer#|\/s\/inline#|envelopeKey|sealedEnvelope/.test(chainSerialized)) throw new Error("chain fixture would contain secret material");
    if (FIXTURE_DIR !== undefined) writeFileSync(join(FIXTURE_DIR, "chain-fixture.json"), `${chainSerialized}\n`, { mode: 0o600 });
    // The SDK's history record keeps the publish metadata target, `kind` included.
    console.log(`CHAIN-FIXTURE ${JSON.stringify({ file: "chain-fixture.json", historyRecordTargetKeys: Object.keys(history.target).sort() })}`);
    expect(link.parseSignedCompactUcanAttenuation).toMatchObject({ accepted: true, cidMatches: true });
  }, 60_000);
});
