import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { Wallet } from "ethers";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { revokePolicyRootV3 } from "@tinycloud/sdk-core";
import { canonicalize, didKeyFromEd25519PublicKey, shareEnvelopeV3Schema, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import {
  bindPathBoundContentSource,
  defaultEncryptionNetworkForOwner,
  encryptAddressedShareContent,
  historyRecordForPublishedShare,
  planPathBoundShare,
  pathBoundSessionPermissions,
  prepareAddressedShare,
  publishAddressedShare,
  revokeShare,
  ShareRecipientClient,
  type SenderShareRecord,
  type ShareRevocationAdapter,
} from "@tinycloud/share-sdk";
import { z } from "zod";
import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * TC-2337: `revokeShare` on an addressed Policy/v3 share, against a real
 * local Node. One call ends every root the share created; a recipient's open
 * policy session can then neither read nor decrypt, a new session cannot be
 * minted, and revoking again is a no-op.
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test share-revoke-live.test.ts
 *
 * Keys are throwaway; nothing here prints key material or Authorization values.
 */

const SHARE_ORIGIN = "https://share.revoke.test";
/** The signed envelope admits only an https node origin; recipients and the owner are pointed at SERVER_URL directly. */
const ENVELOPE_NODE_ORIGIN = "https://node.revoke.test";
const enc = (text: string) => new TextEncoder().encode(text);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const ChallengeResponse = z.object({ challengeId: z.string(), nonce: z.string() }).passthrough();
const MintResponse = z.object({ admitted: z.literal(true), sessionCid: z.string(), authorization: z.string() }).passthrough();
const StatusFailure = z.object({ status: z.number() }).passthrough();
const RootStatus = z.object({ state: z.string() }).passthrough();

interface Holder {
  readonly did: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

interface PolicySession {
  readonly authorization: string;
  readonly cid: string;
}

function newHolder(): Holder {
  const secret = ed25519.utils.randomPrivateKey();
  return { did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(secret)), sign: async (bytes) => ed25519.sign(bytes, secret) };
}

let owner: TinyCloudNode;
let spaceId: string;
let nodeDid: string;

/** Claim/v2 signed by the owner and presentation/v2 signed by the holder, as `validate_claim_and_presentation` admits for a recipient-DID share. */
async function claimMaterial(challenge: { readonly challengeId: string; readonly nonce: string }, envelope: ShareEnvelopeV3, holder: Holder) {
  const ownerDid = envelope.policy.ownerDid;
  const issued = Math.floor(Date.now() / 1000) - 2;
  const common = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    policyCid: envelope.policyCid,
    requestedCapabilities: envelope.policy.capabilityCeiling,
    issuedAt: new Date(issued * 1000).toISOString().replace(".000Z", "Z"),
    expiresAt: new Date((issued + 240) * 1000).toISOString().replace(".000Z", "Z"),
  };
  const claimUnsigned = {
    schema: "xyz.tinycloud.policy/claim/v2",
    jti: `jti_${crypto.randomUUID()}`,
    ...common,
    issuerDid: ownerDid,
    subjectDid: holder.did,
    holderDid: holder.did,
    recipientDid: holder.did,
    credentialEvidence: [{ format: "tinycloud.recipient-did/v1", issuerDid: ownerDid, subjectDid: holder.did, digestHex: createHash("sha256").update(holder.did).digest("hex") }],
  };
  const claimSignature = await owner.signSessionBytes(createHash("sha256").update(`xyz.tinycloud.policy/Claim/v2\0${canonicalize(claimUnsigned)}`).digest());
  const claim = { ...claimUnsigned, signature: { suite: "Ed25519", signerDid: ownerDid, value: b64url(claimSignature) } };
  const presentationUnsigned = {
    schema: "xyz.tinycloud.policy/presentation/v2",
    jti: `jti_${crypto.randomUUID()}`,
    ...common,
    holderDid: holder.did,
    subjectDid: holder.did,
    vpBytesBase64: b64url(enc(canonicalize(claim))),
  };
  const presentationSignature = await holder.sign(createHash("sha256").update(`xyz.tinycloud.policy/Presentation/v2\0${canonicalize(presentationUnsigned)}`).digest());
  return { claim, presentation: { ...presentationUnsigned, signature: { suite: "Ed25519", signerDid: holder.did, value: b64url(presentationSignature) } } };
}

/** Challenge and mint a recipient policy session; returns the session or the Node's refusal status. */
async function mintSession(envelope: ShareEnvelopeV3, holder: Holder): Promise<PolicySession | { readonly refused: number }> {
  const challengeResponse = await fetch(new URL("/policy/v3/challenges", SERVER_URL), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: envelope.policyCid, recipientDid: holder.did, requestedCapabilities: envelope.policy.capabilityCeiling }),
  });
  if (!challengeResponse.ok) return { refused: challengeResponse.status };
  const challenge = ChallengeResponse.parse(await challengeResponse.json());
  const { claim, presentation } = await claimMaterial(challenge, envelope, holder);
  const mintResponse = await fetch(new URL("/policy/v3/delegations", SERVER_URL), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: envelope.policyCid, challengeId: challenge.challengeId, nonce: challenge.nonce, claim, presentation, requestedExpiresAt: envelope.expiry }),
  });
  if (!mintResponse.ok) return { refused: mintResponse.status };
  const minted = MintResponse.parse(await mintResponse.json());
  return { authorization: minted.authorization, cid: minted.sessionCid };
}

/** The addressed publisher, recipient-DID target, as the CLI's addressed branch runs it. */
async function publishShare(text: string, holderDid: string): Promise<{ readonly record: SenderShareRecord; readonly envelope: ShareEnvelopeV3 }> {
  const shareId = crypto.randomUUID().replaceAll("-", "");
  const filename = "doc.txt";
  const resourcePath = `xyz.tinycloud.share/shares/${shareId}/${filename}`;
  const mediaType = "text/plain";
  const policyActions: ("tinycloud.kv/get" | "tinycloud.kv/metadata")[] = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
  const prepared = prepareAddressedShare({ target: { kind: "recipientDid", did: holderDid }, actions: ["read"], policyActions, filename });
  const plan = planPathBoundShare({ shareId, encryptionNetwork: owner.getEncryptionNetworkIdForSpace(spaceId) });
  const encrypted = await encryptAddressedShareContent({ plan, keys: owner.keys, plaintext: enc(text), metadata: { contentType: mediaType } });
  const stored = await owner.kvForSpace(spaceId).put(resourcePath, encrypted.storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  if (!stored.ok) throw new Error(`addressed source put: ${stored.error.code}`);
  let envelope: ShareEnvelopeV3 | undefined;
  const published = await publishAddressedShare({
    shareId,
    shareOrigin: SHARE_ORIGIN,
    nodeOrigin: ENVELOPE_NODE_ORIGIN,
    nodeAudience: nodeDid,
    enforcerDid: nodeDid,
    spaceId,
    target: prepared.target,
    resource: { kind: "exact", path: resourcePath },
    actions: ["read"],
    policyActions,
    contentSource: bindPathBoundContentSource({ plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes, kvResource: `${spaceId}/kv/${resourcePath}`, selector: "exact" }),
    filename,
    mediaType,
    byteLength: enc(text).byteLength,
    expiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000),
    onDeliveryMaterial: (delivery) => { envelope = shareEnvelopeV3Schema.parse(delivery.envelope); },
    authority: {
      ownerDid: owner.credentialHolderDid,
      createOwnerRoot: (request) => owner.createUnifiedOwnerRoot(request),
      sign: (bytes) => owner.signSessionBytes(bytes),
      registerPolicy: (request) => owner.registerPolicy(request),
    },
  });
  if (envelope === undefined) throw new Error("publication did not expose its envelope");
  return { record: historyRecordForPublishedShare(published), envelope };
}

/**
 * The owner's session-signed root revocation, as the CLI and the composer
 * send it. The record names the envelope's https origin; the local Node is
 * reached at SERVER_URL. A root the Node already holds a revocation for is done.
 */
const revocation: ShareRevocationAdapter = {
  async revokePolicyRoot(request) {
    if (request.nodeOrigin !== ENVELOPE_NODE_ORIGIN || request.nodeAudience !== nodeDid || request.ownerDid !== owner.credentialHolderDid) {
      throw new Error("revocation is not bound to the owner node");
    }
    try {
      await revokePolicyRootV3({
        nodeOrigin: SERVER_URL,
        rootCid: request.rootCid,
        targetRole: request.targetRole,
        ownerDid: owner.credentialHolderDid,
        issuerDid: owner.credentialHolderDid,
        nodeAudience: nodeDid,
        reason: "share revoked",
        sign: (digest) => owner.signSessionBytes(digest),
      });
    } catch (error) {
      // The Node holds an earlier revocation of this root: already revoked.
      if (!(error instanceof Error && error.message.endsWith(" - root-revocation-irreversible"))) throw error;
    }
  },
};

/** The Node's own answer for a root (`GET /policy/v3/status/<cid>`). */
async function rootState(rootCid: string): Promise<string> {
  const response = await fetch(new URL(`/policy/v3/status/${encodeURIComponent(rootCid)}`, SERVER_URL), { headers: { accept: "application/json" } });
  if (!response.ok) return `HTTP ${response.status}`;
  return RootStatus.parse(await response.json()).state;
}

/** The composer's wallet path: one approval, for the enforcement root; the keyless policy root is left to lapse. */
const enforcementOnly: ShareRevocationAdapter = {
  async revokePolicyRoot(request) {
    if (request.targetRole === "policy-authority") return "left-live";
    await revocation.revokePolicyRoot!(request);
  },
};

beforeAll(async () => {
  await checkServerHealth();
  const wallet = Wallet.createRandom();
  // The Share composer's sign-in: key.create and decrypt on the default network's `share/` prefix, plus creating that network.
  const network = defaultEncryptionNetworkForOwner(wallet.address);
  const sharePermissions = [
    ...pathBoundSessionPermissions({ encryptionNetwork: network }),
    { service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/network.create"] },
  ];
  owner = new TinyCloudNode({
    host: SERVER_URL,
    signer: new PrivateKeySigner(wallet.privateKey.slice(2)),
    domain: "revoke-live.test",
    autoBootstrapAccount: false,
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoCreateSpace: true,
    manifest: { app_id: "xyz.tinycloud.share", name: "Revoke live", permissions: sharePermissions.map((entry) => ({ ...entry, skipPrefix: true })) },
  });
  await owner.signIn();
  spaceId = owner.restorableSession!.spaceId;
  nodeDid = (await owner.activeNodeIdentity()).nodeDid;
  await owner.ensureEncryptionNetwork(owner.getEncryptionNetworkIdForSpace(spaceId));
}, 120_000);

describe.each([
  { mode: "every root", adapter: revocation, policyRoot: "revoked" },
  { mode: "the enforcement root, policy root left live", adapter: enforcementOnly, policyRoot: "left-live" },
])("TC-2337: revokeShare revoking $mode ends recipient access (live node)", ({ adapter, policyRoot }) => {
  const holder = newHolder();
  const text = `revoke ${crypto.randomUUID()}`;
  let share: { readonly record: SenderShareRecord; readonly envelope: ShareEnvelopeV3 };
  let session: PolicySession;
  let ciphertext: Uint8Array;

  beforeAll(async () => {
    share = await publishShare(text, holder.did);
    const minted = await mintSession(share.envelope, holder);
    if ("refused" in minted) throw new Error(`recipient session refused: HTTP ${minted.refused}`);
    session = minted;
  }, 120_000);

  test("before revocation the recipient reads and decrypts", async () => {
    const client = new ShareRecipientClient({ nodeOrigin: SERVER_URL, envelope: share.envelope, holderDid: holder.did, sign: holder.sign, policyAuthorization: session });
    const response = await client.nativeInvoke({ action: "get", resource: share.envelope.resource });
    expect(response.status).toBe(200);
    ciphertext = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode((await client.decryptV3Content(ciphertext)).bytes)).toBe(text);
    expect([await rootState(share.envelope.enforcementRoot.cid), await rootState(share.envelope.policyRoot.cid)]).toEqual(["active", "active"]);
  }, 60_000);

  test("one revokeShare reports each root as the Node holds it", async () => {
    const result = await revokeShare({ record: share.record, adapter });
    expect({
      enforcement: await rootState(share.envelope.enforcementRoot.cid),
      policy: await rootState(share.envelope.policyRoot.cid),
    }).toEqual({ enforcement: "revoked", policy: policyRoot === "revoked" ? "revoked" : "active" });
    expect(result).toMatchObject({
      state: "revoked",
      roots: [
        { rootCid: share.envelope.enforcementRoot.cid, targetRole: "policy-enforcement", state: "revoked" },
        { rootCid: share.envelope.policyRoot.cid, targetRole: "policy-authority", state: policyRoot },
      ],
    });
  }, 60_000);

  test("after revocation the open session can neither read nor decrypt, and no new session is minted", async () => {
    const client = new ShareRecipientClient({ nodeOrigin: SERVER_URL, envelope: share.envelope, holderDid: holder.did, sign: holder.sign, policyAuthorization: session });
    const response = await client.nativeInvoke({ action: "get", resource: share.envelope.resource });
    expect(response.status).toBe(403);
    const decrypt = await client.decryptV3Content(ciphertext).then(() => "decrypted", (error: unknown) => StatusFailure.safeParse(error).data?.status ?? String(error));
    expect(decrypt).toBe(403);
    const fresh = await mintSession(share.envelope, newHolder());
    expect("refused" in fresh).toBe(true);
  }, 60_000);

  test("revoking again succeeds without a second revocation", async () => {
    const result = await revokeShare({ record: share.record, adapter });
    expect(result).toMatchObject({ state: "revoked", roots: [{ state: "revoked" }, { state: policyRoot }] });
  }, 60_000);
});
