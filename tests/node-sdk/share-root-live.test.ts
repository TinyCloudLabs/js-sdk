/**
 * TC-1423 D3 slice 1: ShareRoot against a real local Node (REVIEW-D3 V2-3,
 * the H1 check on the build path, plus the kv-only-until-enforce rule).
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test share-root-live.test.ts
 *
 * Proves:
 * - one approval mints a root; on a Node that does not advertise
 *   owner-authority `enforce` (every Node today) it is kv-only, and the Node
 *   grants it exactly kv get + metadata on the share prefix;
 * - the Node refuses a Policy/v3 registration signed by a kv-only share key
 *   (signed outside ShareRoot, as anyone holding the key could), while the
 *   same publish under a `kv+share-decrypt` root is accepted (positive
 *   control; that root is forced here with a stub probe, since no local Node
 *   advertises `enforce`);
 * - `capabilities/read` is refused to the root where a holder of it succeeds;
 * - a bearer link signed outside WASM by the non-extractable key works;
 * - revoking the login session leaves the root alive; an owner SIWE revoke of
 *   the root kills it and its links.
 * No key material is logged.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { x25519, ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { signCompactUcanRootAuthorization } from "@tinycloud/sdk-core";
import { base64Decode, base64Encode, canonicalHashHex, canonicalizeEncryptionJson, hexEncode, type InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import { canonicalize, didKeyFromEd25519PublicKey, signCompactUcanAuthorization, toBase64Url } from "@tinycloud/share-envelope";
import { createDelegatedShareKey, prepareAddressedShare, publishAddressedShare, type AddressedOwnerRootInput, type AddressedPublishAuthority, type DelegatedShareKey } from "@tinycloud/share-sdk";
import { ShareRoot, signShareKeyDelegation, type PolicyOwnerModeProbe, type ShareKeySigner } from "@tinycloud/share-sdk/share-root";
import { Wallet } from "ethers";
import { checkServerHealth, SERVER_URL } from "./setup";

const DAY = 86_400_000;
const PREFIX = "xyz.tinycloud.share/shares/";
const seconds = (ms: number) => Math.floor(ms / 1000);

class CountingSigner extends PrivateKeySigner {
  approvals = 0;
  override async signMessage(message: string): Promise<string> {
    this.approvals++;
    return super.signMessage(message);
  }
}

const ownerKey = Wallet.createRandom().privateKey.slice(2);
const wallet = new CountingSigner(ownerKey);
const mkNode = (extra: Partial<TinyCloudNodeConfig> = {}) => new TinyCloudNode({
  host: SERVER_URL,
  autoBootstrapAccount: false,
  tinycloudFallbackHosts: [SERVER_URL],
  autoDiscoverLocalNode: false,
  enablePublicSpace: false,
  domain: "share.test",
  signer: wallet,
  prefix: "applications",
  ...extra,
});

const owner = mkNode({ autoCreateSpace: true });
/** Stands in for a Node advertising `enforce` (none does yet), to build the positive control. */
const enforcingStub: PolicyOwnerModeProbe = { isEnforced: async () => true, observe: () => {} };
let spaceId: string;
let ownerDid: string;
let nodeDid: string;
let loginSessionCid: string;
let shareNetwork: string;
let defaultNetwork: string;
const id = crypto.randomUUID();
const P1 = `${PREFIX}${id}/a.md`;
const P2 = `${PREFIX}${id}/b.md`;
const OUT = "xyz.tinycloud.other/secret.md";
let envShare: InlineEncryptedEnvelope;
let envDefault: InlineEncryptedEnvelope;
let root: ShareRoot;
let shareKey: DelegatedShareKey;
let policyRoot: ShareRoot;
let policyKey: DelegatedShareKey;

/** A link key is bearer material by design (it travels in the link); generated per test. */
function linkKey(): ShareKeySigner {
  const secret = ed25519.utils.randomPrivateKey();
  return { did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(secret)), sign: async (bytes) => ed25519.sign(bytes, secret) };
}

async function post(path: string, authorization: string, body?: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
  return { status: response.status, text: (await response.text()).slice(0, 300) };
}

async function invoke(signer: ShareKeySigner, proof: string, resource: string, action: string, body?: string) {
  const now = seconds(Date.now());
  const invocation = await signCompactUcanAuthorization({
    issuerDid: signer.did,
    audienceDid: nodeDid,
    attenuation: { [resource]: { [action]: [{}] } },
    facts: [{}],
    proofs: [proof],
    notBefore: now,
    expiresAt: now + 60,
    nonce: `urn:uuid:${crypto.randomUUID()}`,
    sign: signer.sign,
  });
  return { ...(await post("/invoke", invocation.authorization, body)), invocationCid: invocation.cid };
}

const kv = (path: string) => `${spaceId}/kv/${path}`;

/** Decrypt an envelope with a key-signed invocation (as Share's recipient client does); returns the plaintext or the HTTP status. */
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
    issuerDid: signer.did,
    audienceDid: nodeDid,
    attenuation: { [envelope.networkId]: { "tinycloud.encryption/decrypt": [{}] } },
    facts: [{ type: body.type, targetNode: body.targetNode, networkId: body.networkId, bodyHash: hexEncode(sha256(new TextEncoder().encode(canonicalBody))), encryptedSymmetricKeyHash: body.encryptedSymmetricKeyHash, receiverPublicKeyHash: body.receiverPublicKeyHash, alg: body.alg, keyVersion: body.keyVersion }],
    proofs: [proof],
    notBefore: now,
    expiresAt: now + 60,
    nonce: `urn:uuid:${crypto.randomUUID()}`,
    sign: signer.sign,
  });
  const response = await fetch(`${SERVER_URL}/invoke`, { method: "POST", headers: { Authorization: invocation.authorization, "content-type": "application/json" }, body: canonicalBody });
  if (!response.ok) return response.status;
  const value = await response.json() as { invocationCid: string; wrappedKey: string };
  expect(value.invocationCid).toBe(invocation.cid);
  const wrapped = base64Decode(value.wrappedKey);
  const aes = async (key: Uint8Array, blob: Uint8Array) => new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12) }, await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]), blob.slice(12)));
  const symmetricKey = await aes(x25519.getSharedSecret(receiverSecret, wrapped.slice(0, 32)), wrapped.slice(33));
  return new TextDecoder().decode(await aes(symmetricKey, base64Decode(envelope.ciphertext)));
}

async function ownerRevoke(cid: string) {
  return post("/revoke", await owner.signOwnerRevocation(cid));
}

/**
 * Owner authority built straight from a share key with the existing sdk-core
 * root signer, bypassing ShareRoot: what anyone holding the key could do.
 * Facts and attenuation as node-sdk `createUnifiedOwnerRoot`.
 */
function keyHolderAuthority(key: DelegatedShareKey): AddressedPublishAuthority {
  return {
    ownerDid: key.did,
    sign: (bytes) => key.sign(bytes),
    registerPolicy: (request) => owner.registerPolicy(request),
    async createOwnerRoot(input: AddressedOwnerRootInput) {
      const facts = {
        role: input.role, mode: input.role === "policy-authority" ? "policy-source" : "conditional-mint", ownerDid: input.ownerDid,
        policyId: input.policyId, policyDigestHex: input.policyDigestHex, policyCid: input.policyCid, contentSourceDigestHex: input.contentSourceDigestHex,
        capabilityCeilingHashHex: input.capabilityCeilingHashHex, nativeProjectionHashHex: input.nativeProjectionHashHex, nodeAudience: input.nodeAudience,
        ...(input.role === "policy-enforcement" ? { enforcerDid: input.audienceDid } : {}),
      };
      const attenuation = Object.fromEntries(input.capabilities.map((capability) => [capability.resource, capability.kind === "encryption"
        ? { [capability.action]: [{}] }
        : Object.fromEntries(capability.actions.map((action) => [action, [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }]]))]));
      const signed = await signCompactUcanRootAuthorization({
        issuerDid: key.did, audienceDid: input.audienceDid, attenuation, facts: [facts],
        notBefore: seconds(input.notBefore.getTime()), expiresAt: seconds(input.expiresAt.getTime()),
        nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), sign: (bytes) => key.sign(bytes),
      });
      return { cid: signed.cid, delegationHeader: { Authorization: signed.authorization } };
    },
  };
}

/**
 * Store one `:share`-encrypted source under the prefix and publish an email
 * share for it with `authority`. Reports whether the Node accepted the policy
 * registration; later envelope steps need an https node origin, which a
 * local Node lacks, so only the registration outcome is asserted.
 */
async function registerEmailShare(authority: AddressedPublishAuthority): Promise<{ registered: string | undefined; error?: string }> {
  const shareId = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const path = `${PREFIX}${shareId}/policy.md`;
  const plaintext = new TextEncoder().encode("# addressed");
  const encrypted = await owner.encryption.encryptToNetwork(shareNetwork, plaintext, { metadata: { contentType: "text/markdown" } });
  if (!encrypted.ok) throw new Error("source encryption failed");
  const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data));
  await owner.kv.put(path, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  const target = { kind: "email" as const, address: "alice@example.com" };
  const policyActions = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as ("tinycloud.kv/get" | "tinycloud.kv/metadata")[];
  const prepared = prepareAddressedShare({ target, actions: ["read"], policyActions, filename: "policy.md" });
  let registered: string | undefined;
  const recording: AddressedPublishAuthority = {
    ...authority,
    registerPolicy: async (request) => {
      const receipt = await authority.registerPolicy(request);
      registered = receipt.policyCid;
      return receipt;
    },
  };
  try {
    await publishAddressedShare({
      shareId, shareOrigin: "https://share.test", nodeOrigin: SERVER_URL, nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId,
      target: prepared.target, resource: { kind: "exact", path }, actions: ["read"], policyActions,
      contentSource: {
        shareId, kvResource: kv(path), selector: "exact", encryptionNetwork: encrypted.data.networkId,
        encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash, keyVersion: encrypted.data.keyVersion, mode: "immutable",
        initialCiphertextDigestHex: hexEncode(sha256(storedBytes)),
      },
      ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
      filename: "policy.md", mediaType: "text/markdown", byteLength: plaintext.byteLength, expiresAt: new Date(Date.now() + 7 * DAY), authority: recording,
    });
    return { registered };
  } catch (error) {
    return { registered, error: String(error instanceof Error ? error.message : error).slice(0, 120) };
  }
}

beforeAll(async () => {
  await checkServerHealth();
  nodeDid = (await (await fetch(`${SERVER_URL}/info`)).json() as { nodeId: string }).nodeId;
  await owner.signIn();
  const session = owner.restorableSession!;
  spaceId = session.spaceId;
  loginSessionCid = session.delegationCid;
  ownerDid = `did:pkh:eip155:${session.chainId}:${session.address}`;
  const lower = session.address.toLowerCase();
  shareNetwork = `urn:tinycloud:encryption:did:pkh:eip155:${session.chainId}:${lower}:share`;
  defaultNetwork = `urn:tinycloud:encryption:did:pkh:eip155:${session.chainId}:${lower}:default`;
  for (const path of [P1, P2, OUT]) await owner.kv.put(path, `# ${path}`);
  // The owner, not the share key, creates and owns `:share` (D3 addendum §1).
  const networkAdmin = mkNode({
    includeAccountRegistryPermissions: false,
    manifest: { app_id: "xyz.tinycloud.share", name: "Owner network admin", space: "applications", defaults: false, includePublicSpace: false,
      permissions: [{ service: "tinycloud.encryption", path: shareNetwork, actions: ["network.create"], skipPrefix: true }] },
  });
  await networkAdmin.signIn();
  await networkAdmin.ensureEncryptionNetwork("share");
  await owner.ensureEncryptionNetwork("default");
  const encrypt = async (network: string) => {
    const result = await owner.encryption.encryptToNetwork(network, new TextEncoder().encode(`secret on ${network.split(":").pop()}`));
    if (!result.ok) throw new Error(`encrypt failed on ${network.split(":").pop()}`);
    return result.data;
  };
  envShare = await encrypt(shareNetwork);
  envDefault = await encrypt(defaultNetwork);

  const authority = { ownerDid, createOwnerDelegation: (params: Parameters<TinyCloudNode["createOwnerDelegation"]>[0]) => owner.createOwnerDelegation(params) };
  const before = wallet.approvals;
  // The real default probe: this Node advertises no `enforce`, so the root is kv-only.
  root = await ShareRoot.create({
    owner: authority, spaceId, nodeOrigin: SERVER_URL, expiresAt: new Date(Date.now() + 37 * DAY),
    keyFactory: async () => (shareKey = await createDelegatedShareKey({ extractable: false })),
    options: { shareRootPolicyRoots: true },
  });
  expect(wallet.approvals - before).toBe(1);
  policyRoot = await ShareRoot.create({
    owner: authority, spaceId, nodeOrigin: SERVER_URL, expiresAt: new Date(Date.now() + 37 * DAY),
    keyFactory: async () => (policyKey = await createDelegatedShareKey({ extractable: false })),
    options: { shareRootPolicyRoots: true, policyOwnerModeProbe: enforcingStub },
  });
  console.log(`[share-root] node ${nodeDid.slice(0, 24)}… kv root ${root.cid} (${root.scope}), control root ${policyRoot.cid} (${policyRoot.scope})`);
}, 120_000);

describe("ShareRoot on a local Node", () => {
  test("without an advertised enforce mode the root is kv-only, non-extractable and lasts 37 days", async () => {
    expect(root.scope).toBe("kv");
    expect(policyRoot.scope).toBe("kv+share-decrypt");
    expect(shareKey.cryptoKey.extractable).toBe(false);
    expect(root.keyDid).toBe(shareKey.did);
    expect(Math.round((root.expiresAt.getTime() - Date.now()) / DAY)).toBe(37);
    await expect(root.policyRootSigner()).rejects.toMatchObject({ code: "root-not-policy-capable" });
  });

  test("the Node grants the kv-only root exactly kv get/metadata in the prefix", async () => {
    const results = {
      getIn: (await invoke(shareKey, root.cid, kv(P1), "tinycloud.kv/get")).status,
      metadataIn: (await invoke(shareKey, root.cid, kv(P1), "tinycloud.kv/metadata")).status,
      getOutside: (await invoke(shareKey, root.cid, kv(OUT), "tinycloud.kv/get")).status,
      putIn: (await invoke(shareKey, root.cid, kv(P2), "tinycloud.kv/put", "x")).status,
      deleteIn: (await invoke(shareKey, root.cid, kv(P2), "tinycloud.kv/del")).status,
      listPrefix: (await invoke(shareKey, root.cid, kv(PREFIX), "tinycloud.kv/list")).status,
      decryptShare: await decryptWith(shareKey, root.cid, envShare),
      decryptDefault: await decryptWith(shareKey, root.cid, envDefault),
      controlDecryptShare: await decryptWith(policyKey, policyRoot.cid, envShare),
      controlDecryptDefault: await decryptWith(policyKey, policyRoot.cid, envDefault),
    };
    console.log("[share-root] root scope", JSON.stringify(results));
    expect(results).toEqual({
      getIn: 200, metadataIn: 200, getOutside: 401, putIn: 401, deleteIn: 401, listPrefix: 401,
      decryptShare: expect.any(Number), decryptDefault: expect.any(Number),
      controlDecryptShare: "secret on share", controlDecryptDefault: expect.any(Number),
    });
    for (const status of [results.decryptShare, results.decryptDefault, results.controlDecryptDefault]) expect(status).toBeGreaterThanOrEqual(400);
  });

  test("capabilities/read: a holder gets 200 at <space>/capabilities/all, the share root 401", async () => {
    const holder = await createDelegatedShareKey({ extractable: false });
    const grant = await owner.createOwnerDelegation({
      delegateDid: holder.did, spaceId, expiresAt: new Date(Date.now() + 600_000),
      permissions: [{ service: "tinycloud.capabilities", path: "all", actions: ["tinycloud.capabilities/read"] }],
    });
    const resource = `${spaceId}/capabilities/all`;
    const holderRead = await invoke(holder, grant.delegationCid, resource, "tinycloud.capabilities/read");
    const rootRead = await invoke(shareKey, root.cid, resource, "tinycloud.capabilities/read");
    console.log("[share-root] capabilities/read", JSON.stringify({ holder: holderRead.status, root: [rootRead.status, rootRead.text.split(":")[0]] }));
    expect(holderRead.status).toBe(200);
    expect(rootRead.status).toBe(401);
    expect(rootRead.text).toContain("Unauthorized Action");
  });

  test("the Node refuses a policy registered by the kv-only share key, and accepts the same publish under the decrypt-bearing root", async () => {
    const before = wallet.approvals;
    const refused = await registerEmailShare(keyHolderAuthority(shareKey));
    const accepted = await registerEmailShare({ ...(await policyRoot.policyRootSigner()), registerPolicy: (request) => owner.registerPolicy(request) });
    console.log("[share-root] policy registration", JSON.stringify({ kvOnlyKey: refused, decryptRoot: { registered: accepted.registered !== undefined } }));
    expect(refused.registered).toBeUndefined();
    expect(refused.error).toContain("HTTP 403 - policy-owner-not-authorized");
    expect(accepted.registered).toBeString();
    expect(wallet.approvals).toBe(before);
  });

  test("a bearer link signed by the non-extractable key outside WASM reads one key and nothing else", async () => {
    const link = linkKey();
    const before = wallet.approvals;
    const signed = await root.signBearerLink({ linkDid: link.did, path: P1, expiresAt: new Date(Date.now() + 7 * DAY) });
    const delegated = await post("/delegate", signed.delegation.authorization);
    const results = {
      delegate: delegated.status,
      read: (await invoke(link, signed.delegation.cid, kv(P1), "tinycloud.kv/get")).status,
      readSibling: (await invoke(link, signed.delegation.cid, kv(P2), "tinycloud.kv/get")).status,
      put: (await invoke(link, signed.delegation.cid, kv(P1), "tinycloud.kv/put", "x")).status,
    };
    console.log("[share-root] bearer link", JSON.stringify(results));
    expect(results).toEqual({ delegate: 200, read: 200, readSibling: 401, put: 401 });
    expect(wallet.approvals).toBe(before);
  });

  test("the Node itself refuses children wider or longer than the root (ShareRoot's client checks bypassed)", async () => {
    const child = async (att: Record<string, Record<string, [{}]>>, expiresAt: number) => post("/delegate", (await signShareKeyDelegation({
      key: shareKey, audienceDid: linkKey().did, attenuation: att, proofs: [root.cid], notBefore: seconds(Date.now()) - 5, expiresAt,
    })).authorization);
    const week = seconds(Date.now() + 7 * DAY);
    const results = {
      put: (await child({ [kv(P1)]: { "tinycloud.kv/put": [{}] } }, week)).status,
      outsidePrefix: (await child({ [kv(OUT)]: { "tinycloud.kv/get": [{}] } }, week)).status,
      decryptShare: (await child({ [shareNetwork]: { "tinycloud.encryption/decrypt": [{}] } }, week)).status,
      beyondRoot: await child({ [kv(P1)]: { "tinycloud.kv/get": [{}] } }, seconds(root.expiresAt.getTime()) + 86_400),
    };
    console.log("[share-root] node-side child limits", JSON.stringify(results));
    expect(results.put).toBeGreaterThanOrEqual(400);
    expect(results.outsidePrefix).toBeGreaterThanOrEqual(400);
    expect(results.decryptShare).toBeGreaterThanOrEqual(400);
    expect(results.beyondRoot.status).toBe(401);
    expect(results.beyondRoot.text).toContain("expiry exceeds parent");
  });

  test("revoking the owner's login session leaves the root and its links working", async () => {
    const link = linkKey();
    const signed = await root.signBearerLink({ linkDid: link.did, path: P1, expiresAt: new Date(Date.now() + 7 * DAY) });
    expect((await post("/delegate", signed.delegation.authorization)).status).toBe(200);
    const revoked = await ownerRevoke(loginSessionCid);
    const results = {
      revokeLogin: revoked.status,
      linkRead: (await invoke(link, signed.delegation.cid, kv(P1), "tinycloud.kv/get")).status,
      rootRead: (await invoke(shareKey, root.cid, kv(P1), "tinycloud.kv/get")).status,
    };
    console.log("[share-root] after login-session revoke", JSON.stringify(results));
    expect(results).toEqual({ revokeLogin: 200, linkRead: 200, rootRead: 200 });
  });

  test("an owner SIWE revoke of the root kills the root, its links and new mints", async () => {
    const link = linkKey();
    const signed = await root.signBearerLink({ linkDid: link.did, path: P1, expiresAt: new Date(Date.now() + 7 * DAY) });
    expect((await post("/delegate", signed.delegation.authorization)).status).toBe(200);
    expect((await invoke(link, signed.delegation.cid, kv(P1), "tinycloud.kv/get")).status).toBe(200);

    const revoked = await ownerRevoke(root.cid);
    const linkRead = await invoke(link, signed.delegation.cid, kv(P1), "tinycloud.kv/get");
    const rootRead = await invoke(shareKey, root.cid, kv(P1), "tinycloud.kv/get");
    const late = await root.signBearerLink({ linkDid: linkKey().did, path: P1, expiresAt: new Date(Date.now() + DAY) });
    const lateDelegate = await post("/delegate", late.delegation.authorization);
    const results = {
      revoke: revoked.status,
      revokeBody: revoked.text,
      linkRead: [linkRead.status, linkRead.text.split(":")[0]],
      rootRead: [rootRead.status, rootRead.text.split(":")[0]],
      newLink: [lateDelegate.status, lateDelegate.text.split(":")[0]],
    };
    console.log("[share-root] after owner SIWE root revoke", JSON.stringify(results));
    expect(results.revoke).toBe(200);
    expect(results.revokeBody).toContain(`"revoked":true`);
    expect(results.linkRead[0]).toBe(401);
    expect(String(results.linkRead[1])).toContain("ancestor-revoked");
    expect(results.rootRead[0]).toBe(401);
    expect(results.newLink[0]).toBeGreaterThanOrEqual(400);
  });
});
