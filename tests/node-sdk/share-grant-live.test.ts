/**
 * TC-1423 D3: per-share grants on per-share encryption networks against a
 * real local Node (PERSHARE-NETWORK design v2).
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> [TC_NODE_LABEL=n1b|n4p|v1206] bun test share-grant-live.test.ts
 *
 * Proves, with approvals counted:
 * - one approval per share; the per-share key creates `share-<shareId>` and
 *   registers the share's policy with no further approval;
 * - the key decrypts its own share only: refused on another share's network,
 *   on `:share` and on `:default`; it cannot create another network, and a
 *   retired network cannot be re-created;
 * - retiring the network (0 approvals) cuts decrypt at the next request, for
 *   the key and for a recipient session delegated from it; kv stays; a
 *   recipient cannot retire;
 * - `publishAuthority` refuses registration on a retired network; the Node
 *   itself refuses only with N1b (`content-source-network-invalid`);
 * - revoke = retire + one owner SIWE; a TC-1428 version path; a shareId
 *   that is not network-safe costs no approval; owner read-back of an edit
 *   share is one approval;
 * - owner kill-all controls: sized by bytes, imported by the Node at full
 *   size, retire every network, then revoke grants (per-grant owner
 *   fallback where the Node refuses the control).
 * No key material is logged.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { x25519, ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { base64Decode, base64Encode, canonicalHashHex, canonicalizeEncryptionJson, hexEncode, type InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import { canonicalize, didKeyFromEd25519PublicKey, signCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { createDelegatedShareKey, prepareAddressedShare, publishAddressedShare, type AddressedPublishAuthority, type DelegatedShareKey } from "@tinycloud/share-sdk";
import {
  SHARE_CONTROL_HEADER_BUDGET_BYTES, ShareGrant, openEditShare, perShareNetworkIdFor, planShareControlBatches, revokeShareGrant, runShareControlBatch,
  signShareKeyDelegation, type ShareGrantAccess, type ShareKeySigner,
} from "@tinycloud/share-sdk/share-root";
import { Wallet } from "ethers";
import { checkServerHealth, SERVER_URL } from "./setup";

const DAY = 86_400_000;
const PREFIX = "xyz.tinycloud.share/shares/";
const NODE_LABEL = process.env.TC_NODE_LABEL ?? "release";
const seconds = (ms: number) => Math.floor(ms / 1000);
// Real Node (debug builds): a 34-network control is ~70 sequential requests, beyond bun's 5 s default.
setDefaultTimeout(60_000);

class CountingSigner extends PrivateKeySigner {
  approvals = 0;
  override async signMessage(message: string): Promise<string> {
    this.approvals++;
    return super.signMessage(message);
  }
}

const wallet = new CountingSigner(Wallet.createRandom().privateKey.slice(2));
const nodeConfig = (extra: Partial<TinyCloudNodeConfig> = {}) => new TinyCloudNode({
  host: SERVER_URL, autoBootstrapAccount: false, tinycloudFallbackHosts: [SERVER_URL], autoDiscoverLocalNode: false,
  enablePublicSpace: false, domain: "share.test", signer: wallet, prefix: "applications", ...extra,
});
const owner = nodeConfig({ autoCreateSpace: true });
let spaceId: string;
let ownerDid: string;
let nodeDid: string;
let shareNetwork: string;
let defaultNetwork: string;
let envShare: InlineEncryptedEnvelope;
let envDefault: InlineEncryptedEnvelope;
const approvalsUsed: Record<string, number> = {};

interface LiveShare { id: string; path: string; grant: ShareGrant; key: DelegatedShareKey; env?: InlineEncryptedEnvelope }
let view: LiveShare;
let edit: LiveShare;

async function counted<T>(label: string, run: () => Promise<T>): Promise<T> {
  const before = wallet.approvals;
  const result = await run();
  approvalsUsed[label] = (approvalsUsed[label] ?? 0) + wallet.approvals - before;
  return result;
}

const newShareId = () => crypto.randomUUID();

async function post(path: string, authorization: string, body?: string, contentType = "application/json") {
  const response = await fetch(`${SERVER_URL}${path}`, { method: "POST", headers: { Authorization: authorization, ...(body === undefined ? {} : { "content-type": contentType }) }, ...(body === undefined ? {} : { body }) });
  return { status: response.status, text: (await response.text()).slice(0, 200) };
}

async function invoke(signer: ShareKeySigner, proof: string, path: string, action: string, body?: string) {
  const now = seconds(Date.now());
  const invocation = await signCompactUcanAuthorization({
    issuerDid: signer.did, audienceDid: nodeDid, attenuation: { [`${spaceId}/kv/${path}`]: { [action]: [{}] } }, facts: [{}], proofs: [proof],
    notBefore: now, expiresAt: now + 60, nonce: `urn:uuid:${crypto.randomUUID()}`, sign: signer.sign,
  });
  return post("/invoke", invocation.authorization, body, "text/markdown");
}

/** A network-admin invocation signed outside the SDK (what any key holder could send). */
async function networkAdmin(signer: ShareKeySigner, proof: string, networkId: string, action: "network.create" | "network.revoke") {
  const name = networkId.slice(networkId.lastIndexOf(":") + 1);
  const owner = networkId.slice("urn:tinycloud:encryption:".length, networkId.lastIndexOf(":"));
  const body = action === "network.create" ? canonicalize({ name, ownerDid: owner, threshold: { n: 1, t: 1 } }) : canonicalize({});
  const now = seconds(Date.now());
  const invocation = await signCompactUcanAuthorization({
    issuerDid: signer.did, audienceDid: nodeDid, attenuation: { [networkId]: { [`tinycloud.encryption/${action}`]: [{}] } },
    facts: [{ type: "tinycloud.encryption.network-admin/v1", targetNode: nodeDid, networkId, bodyHash: hexEncode(sha256(new TextEncoder().encode(body))), action: `tinycloud.encryption/${action}` }],
    proofs: [proof], notBefore: now, expiresAt: now + 60, nonce: `urn:uuid:${crypto.randomUUID()}`, sign: signer.sign,
  });
  return action === "network.create" ? post("/encryption/networks", invocation.authorization, body) : post(`/encryption/networks/${encodeURIComponent(networkId)}/revoke`, invocation.authorization);
}

/** Decrypt with a key-signed invocation (as Share's recipient client does); plaintext or HTTP status. */
async function decryptWith(signer: ShareKeySigner, proof: string, envelope: InlineEncryptedEnvelope): Promise<string | number> {
  const receiverSecret = x25519.utils.randomPrivateKey();
  const receiverPublicKey = base64Encode(x25519.getPublicKey(receiverSecret));
  const body = {
    type: "tinycloud.encryption.decrypt/v1", targetNode: nodeDid, networkId: envelope.networkId, alg: envelope.alg, keyVersion: envelope.keyVersion,
    encryptedSymmetricKey: envelope.encryptedSymmetricKey, encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
    receiverPublicKey, receiverPublicKeyHash: canonicalHashHex(sha256, receiverPublicKey),
  };
  const canonicalBody = canonicalizeEncryptionJson(body);
  const now = seconds(Date.now());
  const invocation = await signCompactUcanAuthorization({
    issuerDid: signer.did, audienceDid: nodeDid, attenuation: { [envelope.networkId]: { "tinycloud.encryption/decrypt": [{}] } },
    facts: [{ type: body.type, targetNode: body.targetNode, networkId: body.networkId, bodyHash: hexEncode(sha256(new TextEncoder().encode(canonicalBody))), encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash, alg: body.alg, keyVersion: body.keyVersion }],
    proofs: [proof], notBefore: now, expiresAt: now + 60, nonce: `urn:uuid:${crypto.randomUUID()}`, sign: signer.sign,
  });
  const response = await fetch(`${SERVER_URL}/invoke`, { method: "POST", headers: { Authorization: invocation.authorization, "content-type": "application/json" }, body: canonicalBody });
  if (!response.ok) return response.status;
  const value = await response.json() as { wrappedKey: string };
  const wrapped = base64Decode(value.wrappedKey);
  const aes = async (key: Uint8Array, blob: Uint8Array) => new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12) }, await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]), blob.slice(12)));
  const symmetricKey = await aes(x25519.getSharedSecret(receiverSecret, wrapped.slice(0, 32)), wrapped.slice(33));
  return new TextDecoder().decode(await aes(symmetricKey, base64Decode(envelope.ciphertext)));
}

const authority = () => ({ ownerDid, createOwnerDelegation: (params: Parameters<TinyCloudNode["createOwnerDelegation"]>[0]) => owner.createOwnerDelegation(params) });

async function encryptTo(network: string, text: string): Promise<InlineEncryptedEnvelope> {
  const result = await owner.encryption.encryptToNetwork(network, new TextEncoder().encode(text), { metadata: { contentType: "text/markdown" } });
  if (!result.ok) throw new Error(`encrypt failed on ${network.split(":").pop()}`);
  return result.data;
}

/** prepare (0) -> approve (1) -> ensureNetwork (0) -> encrypt + store, as the publish order says. */
async function liveShare(label: string, access: ShareGrantAccess, path?: (id: string) => string): Promise<LiveShare> {
  const id = newShareId();
  const sharePath = path?.(id) ?? `${PREFIX}${id}/${access}.md`;
  let key: DelegatedShareKey | undefined;
  const pending = await counted(`${label}-prepare`, () => ShareGrant.prepare({
    owner: authority(), spaceId, nodeOrigin: SERVER_URL, shareId: id, path: sharePath, access, expiresAt: new Date(Date.now() + 7 * DAY),
    keyFactory: async () => (key = await createDelegatedShareKey({ extractable: false })),
  }));
  expect(pending.row.state).toBe("pending");
  const grant = await counted(`${label}-grant`, () => pending.approve());
  expect(await counted(`${label}-network`, () => grant.ensureNetwork())).toBe(perShareNetworkIdFor(ownerDid, id));
  const env = await encryptTo(grant.networkId, `secret ${label}`);
  await owner.kv.put(sharePath, new TextEncoder().encode(canonicalize(env)), { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  return { id, path: sharePath, grant, key: key!, env };
}

/** Publish the addressed share through `authority`; reports whether the Node registered the policy. */
async function register(share: LiveShare, authorityFor: (registerPolicy: AddressedPublishAuthority["registerPolicy"]) => AddressedPublishAuthority) {
  const storedBytes = new TextEncoder().encode(canonicalize(share.env!));
  const policyActions = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as ("tinycloud.kv/get" | "tinycloud.kv/metadata")[];
  const prepared = prepareAddressedShare({ target: { kind: "email", address: "alice@example.com" }, actions: ["read"], policyActions, filename: "view.md" });
  const contentSource = {
    shareId: share.id, kvResource: share.grant.resource, selector: "exact" as const, encryptionNetwork: share.env!.networkId,
    encryptedSymmetricKeyDigestHex: share.env!.encryptedSymmetricKeyHash, keyVersion: share.env!.keyVersion, mode: "immutable" as const,
    initialCiphertextDigestHex: hexEncode(sha256(storedBytes)),
  };
  share.grant.assertContentSource(contentSource);
  let registered: string | undefined;
  let error: string | undefined;
  try {
    await publishAddressedShare({
      shareId: share.id, shareOrigin: "https://share.test", nodeOrigin: SERVER_URL, nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId,
      target: prepared.target, resource: { kind: "exact", path: share.path }, actions: ["read"], policyActions, contentSource,
      ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
      filename: "view.md", mediaType: "text/markdown", byteLength: 10, expiresAt: new Date(Date.now() + 5 * DAY),
      authority: authorityFor(async (request) => { const receipt = await owner.registerPolicy(request); registered = receipt.policyCid; return receipt; }),
    });
  } catch (caught) {
    // A local Node is http, and the v3 envelope requires an https node origin; registration happens before that step.
    error = String(caught instanceof Error ? caught.message : caught).slice(0, 160);
  }
  return { registered, error };
}

function childKey(): ShareKeySigner {
  const secret = ed25519.utils.randomPrivateKey();
  return { did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(secret)), sign: async (bytes) => ed25519.sign(bytes, secret) };
}

beforeAll(async () => {
  await checkServerHealth();
  nodeDid = (await (await fetch(`${SERVER_URL}/info`)).json() as { nodeId: string }).nodeId;
  await owner.signIn();
  const session = owner.restorableSession!;
  spaceId = session.spaceId;
  ownerDid = `did:pkh:eip155:${session.chainId}:${session.address}`;
  const lower = session.address.toLowerCase();
  shareNetwork = `urn:tinycloud:encryption:did:pkh:eip155:${session.chainId}:${lower}:share`;
  defaultNetwork = `urn:tinycloud:encryption:did:pkh:eip155:${session.chainId}:${lower}:default`;
  // Fixtures only: the old owner-wide `:share` network and `:default`, to prove a per-share key reaches neither.
  const networkAdminNode = nodeConfig({
    includeAccountRegistryPermissions: false,
    manifest: { app_id: "xyz.tinycloud.share", name: "Owner network admin", space: "applications", defaults: false, includePublicSpace: false,
      permissions: [{ service: "tinycloud.encryption", path: shareNetwork, actions: ["network.create"], skipPrefix: true }] },
  });
  await networkAdminNode.signIn();
  await networkAdminNode.ensureEncryptionNetwork("share");
  await owner.ensureEncryptionNetwork("default");
  envShare = await encryptTo(shareNetwork, "secret on share");
  envDefault = await encryptTo(defaultNetwork, "secret on default");
}, 120_000);

describe("per-share grants and networks", () => {
  test("one approval per share; the key creates its own network for free", async () => {
    view = await liveShare("view", "view");
    edit = await liveShare("edit", "edit");
    const descriptor = await (await fetch(`${SERVER_URL}/encryption/networks/${encodeURIComponent(view.grant.networkId)}`)).json() as { descriptor?: Record<string, unknown> };
    console.log("[pershare] create", JSON.stringify({ approvals: approvalsUsed, descriptor: { ...descriptor.descriptor, ownerMatches: String(descriptor.descriptor?.ownerDid).toLowerCase() === ownerDid.toLowerCase() } }));
    expect(approvalsUsed).toMatchObject({ "view-prepare": 0, "view-grant": 1, "view-network": 0, "edit-prepare": 0, "edit-grant": 1, "edit-network": 0 });
    expect(view.key.cryptoKey.extractable).toBe(false);
    expect(view.grant.keyDid).not.toBe(edit.grant.keyDid);
    expect(view.grant.networkId).not.toBe(edit.grant.networkId);
  });

  test("the key decrypts its own share only, on its exact key", async () => {
    const otherNetwork = perShareNetworkIdFor(ownerDid, newShareId());
    const results = {
      get: (await invoke(view.key, view.grant.cid, view.path, "tinycloud.kv/get")).status,
      metadata: (await invoke(view.key, view.grant.cid, view.path, "tinycloud.kv/metadata")).status,
      put: (await invoke(view.key, view.grant.cid, view.path, "tinycloud.kv/put", "# overwritten")).status,
      getEditShare: (await invoke(view.key, view.grant.cid, edit.path, "tinycloud.kv/get")).status,
      decryptOwn: await decryptWith(view.key, view.grant.cid, view.env!),
      decryptOtherShare: await decryptWith(view.key, view.grant.cid, edit.env!),
      decryptShareNetwork: await decryptWith(view.key, view.grant.cid, envShare),
      decryptDefault: await decryptWith(view.key, view.grant.cid, envDefault),
      createOtherNetwork: (await networkAdmin(view.key, view.grant.cid, otherNetwork, "network.create")).status,
      createNearName: (await networkAdmin(view.key, view.grant.cid, `${view.grant.networkId}x`, "network.create")).status,
      recreateOwnNetwork: (await networkAdmin(view.key, view.grant.cid, view.grant.networkId, "network.create")).status,
      retireOtherShare: (await networkAdmin(view.key, view.grant.cid, edit.grant.networkId, "network.revoke")).status,
      editPut: (await invoke(edit.key, edit.grant.cid, edit.path, "tinycloud.kv/put", canonicalize(edit.env!))).status,
    };
    console.log("[pershare] scope", JSON.stringify(results));
    expect(results).toMatchObject({ get: 200, metadata: 200, put: 401, getEditShare: 401, decryptOwn: "secret view", recreateOwnNetwork: 409, editPut: 200 });
    for (const status of [results.decryptOtherShare, results.decryptShareNetwork, results.decryptDefault, results.createOtherNetwork, results.createNearName, results.retireOtherShare]) {
      expect(status).toBeNumber();
      expect(Number(status)).toBeGreaterThanOrEqual(400);
    }
  });

  test("the per-share key registers its share's policy with no approval, after a fresh active check", async () => {
    const before = wallet.approvals;
    const outcome = await register(view, (registerPolicy) => view.grant.publishAuthority(registerPolicy));
    console.log("[pershare] policy registration", JSON.stringify({ registered: outcome.registered !== undefined, laterStep: outcome.error }));
    expect(outcome.registered).toBeString();
    expect(wallet.approvals).toBe(before);
  });

  test("owner read-back of an edit share is one approval to a one-hour key", async () => {
    const reader = await counted("edit-read-back", () => openEditShare({ owner: authority(), record: edit.grant.toRecord() }));
    const results = {
      get: (await invoke(reader.signer, reader.cid, edit.path, "tinycloud.kv/get")).status,
      put: (await invoke(reader.signer, reader.cid, edit.path, "tinycloud.kv/put", "x")).status,
      decrypt: await decryptWith(reader.signer, reader.cid, edit.env!),
      decryptOther: await decryptWith(reader.signer, reader.cid, view.env!),
    };
    reader.clear();
    console.log("[pershare] edit read-back", JSON.stringify(results));
    expect(results).toMatchObject({ get: 200, put: 401, decrypt: "secret edit" });
    expect(Number(results.decryptOther)).toBeGreaterThanOrEqual(400);
    expect(approvalsUsed["edit-read-back"]).toBe(1);
  });

  test("retiring the network (no approval) cuts decrypt at the next request, for the key and a recipient session; recipients cannot retire", async () => {
    const recipient = childKey();
    const delegated = await signShareKeyDelegation({
      key: view.key, audienceDid: recipient.did, attenuation: { [view.grant.networkId]: { "tinycloud.encryption/decrypt": [{}] } },
      proofs: [view.grant.cid], notBefore: seconds(Date.now()) - 5, expiresAt: seconds(Date.now() + DAY),
    });
    expect((await post("/delegate", delegated.authorization)).status).toBe(200);
    const recipientBefore = await decryptWith(recipient, delegated.cid, view.env!);
    const recipientRetire = (await networkAdmin(recipient, delegated.cid, view.grant.networkId, "network.revoke")).status;
    const retired = await counted("view-retire", () => view.grant.retireNetwork());
    const results = {
      recipientBefore, recipientRetire, retired,
      ownDecryptAfter: await decryptWith(view.key, view.grant.cid, view.env!),
      recipientDecryptAfter: await decryptWith(recipient, delegated.cid, view.env!),
      kvGetAfter: (await invoke(view.key, view.grant.cid, view.path, "tinycloud.kv/get")).status,
      recreate: (await networkAdmin(view.key, view.grant.cid, view.grant.networkId, "network.create")).status,
      retireAgain: await view.grant.retireNetwork(),
    };
    console.log("[pershare] retire", JSON.stringify(results));
    expect(results).toMatchObject({ recipientBefore: "secret view", retired: "retired", kvGetAfter: 200, recreate: 409, retireAgain: "retired" });
    expect(recipientRetire).toBeGreaterThanOrEqual(400);
    expect(Number(results.ownDecryptAfter)).toBeGreaterThanOrEqual(400);
    expect(Number(results.recipientDecryptAfter)).toBeGreaterThanOrEqual(400);
    expect(approvalsUsed["view-retire"]).toBe(0);
    await expect(view.grant.ensureNetwork()).rejects.toMatchObject({ code: "network-not-active" });
  });

  test("registration on a retired network: the SDK refuses; the Node refuses only with N1b", async () => {
    // A fresh share, never registered, so a Node-side refusal cannot be a duplicate-registration conflict.
    const retired = await liveShare("retired", "view");
    await retired.grant.retireNetwork();
    const sdk = await register(retired, (registerPolicy) => retired.grant.publishAuthority(registerPolicy));
    const raw = await register(retired, (registerPolicy) => ({ ...retired.grant.policySigner(), registerPolicy }));
    console.log("[pershare] registration after retire", NODE_LABEL, JSON.stringify({ sdk, raw }));
    expect(sdk.registered).toBeUndefined();
    expect(sdk.error).toContain("share network is revoked");
    if (NODE_LABEL === "n1b") {
      expect(raw.registered).toBeUndefined();
      expect(raw.error).toContain("content-source-network-invalid");
    } else {
      expect(raw.registered).toBeString();
    }
    // The burned shareId is refused before any prompt.
    const before = wallet.approvals;
    await expect(ShareGrant.prepare({ owner: authority(), spaceId, nodeOrigin: SERVER_URL, shareId: retired.id, path: retired.path, access: "view", expiresAt: new Date(Date.now() + DAY) }))
      .rejects.toMatchObject({ code: "share-id-in-use" });
    expect(wallet.approvals).toBe(before);
  });

  test("a TC-1428 version path share; a shareId that is not network-safe costs no approval", async () => {
    const versioned = await liveShare("version", "view", () => `xyz.tinycloud.share/artifacts/${newShareId().slice(0, 8)}/versions/1/report.md`);
    expect((await invoke(versioned.key, versioned.grant.cid, versioned.path, "tinycloud.kv/get")).status).toBe(200);
    expect(await decryptWith(versioned.key, versioned.grant.cid, versioned.env!)).toBe("secret version");
    const before = wallet.approvals;
    await expect(ShareGrant.prepare({ owner: authority(), spaceId, nodeOrigin: SERVER_URL, shareId: "Not_Network_Safe", path: `${PREFIX}Not_Network_Safe/a.md`, access: "view", expiresAt: new Date(Date.now() + DAY) }))
      .rejects.toMatchObject({ code: "share-id-not-network-safe" });
    expect(wallet.approvals).toBe(before);
    expect(approvalsUsed).toMatchObject({ "version-grant": 1, "version-network": 0 });
  });

  test("revoke = retire (0 approvals) then one owner SIWE", async () => {
    const result = await counted("edit-revoke", () => revokeShareGrant({ grant: edit.grant, owner: { signOwnerRevocation: (cid) => owner.signOwnerRevocation(cid) } }));
    const get = await invoke(edit.key, edit.grant.cid, edit.path, "tinycloud.kv/get");
    const results = { result, decrypt: await decryptWith(edit.key, edit.grant.cid, edit.env!), get: [get.status, get.text.split(":")[0]] };
    console.log("[pershare] revoke", JSON.stringify(results));
    expect(result).toEqual({ network: "retired", grant: "revoked" });
    expect(Number(results.decrypt)).toBeGreaterThanOrEqual(400);
    expect(results.get[0]).toBe(401);
    expect(approvalsUsed["edit-revoke"]).toBe(1);
  });
});

describe("owner kill-all controls", () => {
  test("a full-size control (by bytes) is accepted by the Node", async () => {
    const targets = Array.from({ length: 40 }, () => ({ networkId: perShareNetworkIdFor(ownerDid, newShareId()), grantCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" }));
    const signer = { ownerDid, domain: "share.test", signMessage: (message: string) => wallet.signMessage(message) };
    const batches = planShareControlBatches({ owner: signer, targets: targets.map(({ networkId }) => ({ networkId })), spaceIds: [spaceId] });
    const result = await counted("control-full", () => runShareControlBatch({ owner: signer, nodeOrigin: SERVER_URL, batch: batches[0]! }));
    console.log("[pershare] full control", JSON.stringify({ batches: batches.map((batch) => [batch.targets.length, batch.headerBytes]), budget: SHARE_CONTROL_HEADER_BUDGET_BYTES, networks: result.networks.length, absent: result.networks.filter((entry) => entry.result === "absent").length }));
    expect(batches[0]!.headerBytes).toBeLessThanOrEqual(SHARE_CONTROL_HEADER_BUDGET_BYTES);
    expect(result.networks.every((entry) => entry.result === "absent")).toBe(true);
    expect(approvalsUsed["control-full"]).toBe(1);
  });

  test("two controls (space row in each) retire every network first, then revoke the grants through the control on v1.20.6 and N4'", async () => {
    const shares = [await liveShare("k1", "view"), await liveShare("k2", "view"), await liveShare("k3", "edit"), await liveShare("k4", "view")];
    const signer = { ownerDid, domain: "share.test", signMessage: (message: string) => wallet.signMessage(message) };
    const targets = shares.map((share) => ({ networkId: share.grant.networkId, grantCid: share.grant.cid }));
    // Force two shares per control (all ids have the same length), so the second control's grants prove the per-control space row.
    const budgetBytes = planShareControlBatches({ owner: signer, targets: targets.slice(0, 2), spaceIds: [spaceId] })[0]!.headerBytes;
    const batches = planShareControlBatches({ owner: signer, targets, spaceIds: [spaceId], budgetBytes });
    expect(batches.map((batch) => batch.targets.length)).toEqual([2, 2]);
    expect(batches.every((batch) => batch.spaceDelegationResources.length === 1)).toBe(true);
    const results = [];
    for (const batch of batches) results.push(await counted("control-kill", () => runShareControlBatch({ owner: signer, nodeOrigin: SERVER_URL, batch, revokeFallback: { signOwnerRevocation: (cid) => owner.signOwnerRevocation(cid) } })));
    const after = await Promise.all(shares.map(async (share) => ({
      decrypt: await decryptWith(share.key, share.grant.cid, share.env!),
      get: (await invoke(share.key, share.grant.cid, share.path, "tinycloud.kv/get")).status,
    })));
    const grants = results.flatMap((result) => result.grants);
    const fallbacks = grants.filter((entry) => entry.result === "revoked-by-owner").length;
    console.log("[pershare] kill-all", NODE_LABEL, JSON.stringify({ batches: batches.map((batch) => [batch.targets.length, batch.headerBytes]), networks: results.flatMap((result) => result.networks.map((entry) => entry.result)), grants: grants.map((entry) => [entry.result, entry.status]), approvals: approvalsUsed["control-kill"], after }));
    expect(results.flatMap((result) => result.networks.map((entry) => entry.result))).toEqual(["retired", "retired", "retired", "retired"]);
    expect(grants.every((entry) => entry.result !== "refused")).toBe(true);
    // v1.20.6 and N4' revoke every grant through its control (batch 2 included); 1.21.0 and N1b need the owner fallback for each.
    expect(fallbacks).toBe(NODE_LABEL === "n4p" || NODE_LABEL === "v1206" ? 0 : 4);
    expect(approvalsUsed["control-kill"]).toBe(2 + fallbacks);
    for (const entry of after) {
      expect(Number(entry.decrypt)).toBeGreaterThanOrEqual(400);
      expect(entry.get).toBe(401);
    }
    console.log("[pershare] approvals", JSON.stringify(approvalsUsed));
  });
});
