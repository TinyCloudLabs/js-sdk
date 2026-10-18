/**
 * TC-1423 D3 slice 2: the owner's `:share` network and per-share grants
 * against a real local Node.
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test share-grant-live.test.ts
 *
 * Proves, with approvals counted on the owner wallet:
 * - `ensureShareNetwork` creates the owner-owned `:share` network with one
 *   approval, then costs nothing;
 * - a view grant (one approval) lets its fresh per-share key read and decrypt
 *   exactly its key and nothing else, and refuses put; an edit grant adds put
 *   on its own key only;
 * - the per-share key registers its share's Policy/v3 policy through
 *   `publishAuthority` (no further approval);
 * - a `kv+share-decrypt` share root decrypts on the same network;
 * - an owner revoke of one grant (one approval) cuts that share's key only.
 * No key material is logged.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { base64Decode, base64Encode, canonicalHashHex, canonicalizeEncryptionJson, hexEncode, type InlineEncryptedEnvelope } from "@tinycloud/sdk-services";
import { canonicalize, signCompactUcanAuthorization, toBase64Url } from "@tinycloud/share-envelope";
import { createDelegatedShareKey, prepareAddressedShare, publishAddressedShare, type DelegatedShareKey } from "@tinycloud/share-sdk";
import { ShareGrant, ShareRoot, ensureShareNetwork, type PolicyOwnerModeProbe, type ShareKeySigner } from "@tinycloud/share-sdk/share-root";
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

const wallet = new CountingSigner(Wallet.createRandom().privateKey.slice(2));
const owner = new TinyCloudNode({
  host: SERVER_URL, autoBootstrapAccount: false, tinycloudFallbackHosts: [SERVER_URL], autoDiscoverLocalNode: false,
  enablePublicSpace: false, domain: "share.test", signer: wallet, prefix: "applications", autoCreateSpace: true,
} satisfies Partial<TinyCloudNodeConfig>);
const enforcingStub: PolicyOwnerModeProbe = { isEnforced: async () => true, observe: () => {} };
const id = crypto.randomUUID();
const VIEW_PATH = `${PREFIX}${id}/view.md`;
const EDIT_PATH = `${PREFIX}${id}/edit.md`;
const SIBLING = `${PREFIX}${id}/other.md`;
let spaceId: string;
let ownerDid: string;
let nodeDid: string;
let shareNetwork: string;
let defaultNetwork: string;
let envShare: InlineEncryptedEnvelope;
let envDefault: InlineEncryptedEnvelope;
let viewGrant: ShareGrant;
let viewKey: DelegatedShareKey;
let editGrant: ShareGrant;
let editKey: DelegatedShareKey;
const approvalsUsed: Record<string, number> = {};

async function counted<T>(label: string, run: () => Promise<T>): Promise<T> {
  const before = wallet.approvals;
  const result = await run();
  approvalsUsed[label] = (approvalsUsed[label] ?? 0) + wallet.approvals - before;
  return result;
}

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

beforeAll(async () => {
  await checkServerHealth();
  nodeDid = (await (await fetch(`${SERVER_URL}/info`)).json() as { nodeId: string }).nodeId;
  await owner.signIn();
  const session = owner.restorableSession!;
  spaceId = session.spaceId;
  ownerDid = `did:pkh:eip155:${session.chainId}:${session.address}`;
  defaultNetwork = `urn:tinycloud:encryption:${ownerDid}:default`;
  await owner.ensureEncryptionNetwork("default");
  for (const path of [VIEW_PATH, EDIT_PATH, SIBLING]) await owner.kv.put(path, `# ${path}`);
}, 120_000);

describe("the owner's :share network", () => {
  test("is created once by the owner (one approval), then reused for free", async () => {
    const first = await counted("network-create", () => ensureShareNetwork({ owner: authority(), spaceId, nodeOrigin: SERVER_URL }));
    const second = await counted("network-reuse", () => ensureShareNetwork({ owner: authority(), spaceId, nodeOrigin: SERVER_URL }));
    shareNetwork = first.networkId;
    const descriptor = await (await fetch(`${SERVER_URL}/encryption/networks/${encodeURIComponent(shareNetwork)}`)).json() as { descriptor?: { ownerDid: string; state: string } };
    console.log("[share-grant] network", JSON.stringify({ first: first.approvals, second: second.approvals, owner: descriptor.descriptor?.ownerDid === ownerDid, state: descriptor.descriptor?.state }));
    expect([first.approvals, second.approvals]).toEqual([1, 0]);
    expect(approvalsUsed).toMatchObject({ "network-create": 1, "network-reuse": 0 });
    expect(descriptor.descriptor?.ownerDid.toLowerCase()).toBe(ownerDid.toLowerCase());
    const encrypt = async (network: string) => {
      const result = await owner.encryption.encryptToNetwork(network, new TextEncoder().encode(`secret on ${network.split(":").pop()}`));
      if (!result.ok) throw new Error(`encrypt failed on ${network.split(":").pop()}`);
      return result.data;
    };
    envShare = await encrypt(shareNetwork);
    envDefault = await encrypt(defaultNetwork);
  });
});

describe("per-share grants", () => {
  test("each grant costs one approval and goes to a fresh non-extractable key", async () => {
    viewGrant = await counted("view-grant", () => ShareGrant.create({
      owner: authority(), spaceId, nodeOrigin: SERVER_URL, path: VIEW_PATH, access: "view", expiresAt: new Date(Date.now() + 7 * DAY),
      keyFactory: async () => (viewKey = await createDelegatedShareKey({ extractable: false })),
    }));
    editGrant = await counted("edit-grant", () => ShareGrant.create({
      owner: authority(), spaceId, nodeOrigin: SERVER_URL, path: EDIT_PATH, access: "edit", expiresAt: new Date(Date.now() + 7 * DAY),
      keyFactory: async () => (editKey = await createDelegatedShareKey({ extractable: false })),
    }));
    expect(approvalsUsed).toMatchObject({ "view-grant": 1, "edit-grant": 1 });
    expect(viewKey.cryptoKey.extractable).toBe(false);
    expect(viewGrant.keyDid).not.toBe(editGrant.keyDid);
  });

  test("the Node holds each per-share key to its exact key and access", async () => {
    const results = {
      view: {
        get: (await invoke(viewKey, viewGrant.cid, VIEW_PATH, "tinycloud.kv/get")).status,
        metadata: (await invoke(viewKey, viewGrant.cid, VIEW_PATH, "tinycloud.kv/metadata")).status,
        put: (await invoke(viewKey, viewGrant.cid, VIEW_PATH, "tinycloud.kv/put", "# overwritten")).status,
        getSibling: (await invoke(viewKey, viewGrant.cid, SIBLING, "tinycloud.kv/get")).status,
        getEditShare: (await invoke(viewKey, viewGrant.cid, EDIT_PATH, "tinycloud.kv/get")).status,
        list: (await invoke(viewKey, viewGrant.cid, `${PREFIX}${id}`, "tinycloud.kv/list")).status,
        decryptShare: await decryptWith(viewKey, viewGrant.cid, envShare),
        decryptDefault: await decryptWith(viewKey, viewGrant.cid, envDefault),
      },
      edit: {
        put: (await invoke(editKey, editGrant.cid, EDIT_PATH, "tinycloud.kv/put", "# edited")).status,
        get: (await invoke(editKey, editGrant.cid, EDIT_PATH, "tinycloud.kv/get")).status,
        putViewShare: (await invoke(editKey, editGrant.cid, VIEW_PATH, "tinycloud.kv/put", "# overwritten")).status,
        putSibling: (await invoke(editKey, editGrant.cid, SIBLING, "tinycloud.kv/put", "# overwritten")).status,
      },
    };
    console.log("[share-grant] node scope", JSON.stringify(results));
    expect(results).toEqual({
      view: { get: 200, metadata: 200, put: 401, getSibling: 401, getEditShare: 401, list: 401, decryptShare: "secret on share", decryptDefault: expect.any(Number) },
      edit: { put: 200, get: 200, putViewShare: 401, putSibling: 401 },
    });
    expect(results.view.decryptDefault).toBeGreaterThanOrEqual(400);
  });

  test("the per-share key registers its share's policy without another approval", async () => {
    const before = wallet.approvals;
    const plaintext = new TextEncoder().encode("# addressed");
    const encrypted = await owner.encryption.encryptToNetwork(shareNetwork, plaintext, { metadata: { contentType: "text/markdown" } });
    if (!encrypted.ok) throw new Error("source encryption failed");
    const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data));
    await owner.kv.put(VIEW_PATH, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
    const shareId = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
    const policyActions = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as ("tinycloud.kv/get" | "tinycloud.kv/metadata")[];
    const prepared = prepareAddressedShare({ target: { kind: "email", address: "alice@example.com" }, actions: ["read"], policyActions, filename: "view.md" });
    let registered: string | undefined;
    let error: string | undefined;
    try {
      await publishAddressedShare({
        shareId, shareOrigin: "https://share.test", nodeOrigin: SERVER_URL, nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId,
        target: prepared.target, resource: { kind: "exact", path: VIEW_PATH }, actions: ["read"], policyActions,
        contentSource: {
          shareId, kvResource: viewGrant.resource, selector: "exact", encryptionNetwork: encrypted.data.networkId,
          encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash, keyVersion: encrypted.data.keyVersion, mode: "immutable",
          initialCiphertextDigestHex: hexEncode(sha256(storedBytes)),
        },
        ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
        filename: "view.md", mediaType: "text/markdown", byteLength: plaintext.byteLength, expiresAt: new Date(Date.now() + 5 * DAY),
        authority: viewGrant.publishAuthority(async (request) => { const receipt = await owner.registerPolicy(request); registered = receipt.policyCid; return receipt; }),
      });
    } catch (caught) {
      // A local Node is http, and the v3 envelope requires an https node origin; registration happens before that step.
      error = String(caught instanceof Error ? caught.message : caught).slice(0, 120);
    }
    console.log("[share-grant] policy registration", JSON.stringify({ registered: registered !== undefined, laterStep: error }));
    expect(registered).toBeString();
    expect(wallet.approvals).toBe(before);
  });

  test("a kv+share-decrypt share root decrypts on the same owner network", async () => {
    let rootKey: DelegatedShareKey | undefined;
    const root = await ShareRoot.create({
      owner: authority(), spaceId, nodeOrigin: SERVER_URL, expiresAt: new Date(Date.now() + 7 * DAY),
      keyFactory: async () => (rootKey = await createDelegatedShareKey({ extractable: false })),
      options: { shareRootPolicyRoots: true, policyOwnerModeProbe: enforcingStub },
    });
    const decrypted = await decryptWith(rootKey!, root.cid, envShare);
    console.log("[share-grant] share root on :share", JSON.stringify({ scope: root.scope, decrypted }));
    expect(root.scope).toBe("kv+share-decrypt");
    expect(decrypted).toBe("secret on share");
  });

  test("an owner revoke of one grant (one approval) cuts that share's key only", async () => {
    const revoked = await counted("grant-revoke", async () => post("/revoke", await owner.signOwnerRevocation(viewGrant.cid)));
    const view = await invoke(viewKey, viewGrant.cid, VIEW_PATH, "tinycloud.kv/get");
    const results = {
      revoke: revoked.status,
      viewGet: [view.status, view.text.split(":")[0]],
      viewDecrypt: await decryptWith(viewKey, viewGrant.cid, envShare),
      editGet: (await invoke(editKey, editGrant.cid, EDIT_PATH, "tinycloud.kv/get")).status,
      editDecrypt: await decryptWith(editKey, editGrant.cid, envShare),
    };
    console.log("[share-grant] after revoking the view grant", JSON.stringify(results), "approvals", JSON.stringify(approvalsUsed));
    expect(results.revoke).toBe(200);
    expect(results.viewGet[0]).toBe(401);
    expect(String(results.viewGet[1])).toContain("delegation-revoked");
    expect(results.viewDecrypt).toBeGreaterThanOrEqual(400);
    expect(results.editGet).toBe(200);
    expect(results.editDecrypt).toBe("secret on share");
    expect(approvalsUsed["grant-revoke"]).toBe(1);
  });
});
