/**
 * TC-1423 D3 slice 3: bearer links via the share root, against a real local
 * Node.
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test share-root-link-live.test.ts
 *
 * Set TC_EXPECT_HOLDER_REVOKE=refused on a Node with tinycloud-node #353
 * (TC-1436), where a link holder may no longer revoke the link; released
 * Nodes (1.21.0, v1.20.6) still accept it.
 *
 * Proves, with owner approvals counted: the kv-only root costs one approval
 * and each link none; links keep today's `/viewer#tc1=` shape and open
 * through the unchanged SharingService receive path; the link key reads only
 * its exact key; the Node refuses wider or longer children; expiry is
 * honoured; a re-root costs one approval; the share key (0 approvals) and the
 * owner (1) can revoke a link per CID. No key material is logged.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { fromBase64Url, signCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { createDelegatedShareKey, parseNativeShareUrl, type DelegatedShareKey } from "@tinycloud/share-sdk";
import { ShareRoot, ensureShareRoot, publishRootBearerLink, revokeRootBearerLink, signShareKeyDelegation, type RootBearerLink, type ShareKeySigner } from "@tinycloud/share-sdk/share-root";
import { Wallet } from "ethers";
import { checkServerHealth, SERVER_URL } from "./setup";

const DAY = 86_400_000;
const PREFIX = "xyz.tinycloud.share/shares/";
const VIEWER = "https://share.test";
const seconds = (ms: number) => Math.floor(ms / 1000);
const holderRevokeExpectation = process.env.TC_EXPECT_HOLDER_REVOKE === "refused" ? "refused" : "released";

class CountingSigner extends PrivateKeySigner {
  approvals = 0;
  override async signMessage(message: string): Promise<string> {
    this.approvals++;
    return super.signMessage(message);
  }
}

const wallet = new CountingSigner(Wallet.createRandom().privateKey.slice(2));
const nodeConfig = { host: SERVER_URL, autoBootstrapAccount: false, tinycloudFallbackHosts: [SERVER_URL], autoDiscoverLocalNode: false, enablePublicSpace: false, domain: "share.test" } satisfies Partial<TinyCloudNodeConfig>;
const owner = new TinyCloudNode({ ...nodeConfig, signer: wallet, prefix: "applications", autoCreateSpace: true });
const notEnforcing = { isEnforced: async () => false, observe: () => {} };
const id = crypto.randomUUID();
const P1 = `${PREFIX}${id}/a.md`;
const P2 = `${PREFIX}${id}/b.md`;
const P3 = `${PREFIX}${id}/c.md`;
let spaceId: string;
let ownerDid: string;
let nodeDid: string;
let root: ShareRoot;
let rootKey: DelegatedShareKey;
const approvalsUsed: Record<string, number> = {};

async function counted<T>(label: string, run: () => Promise<T>): Promise<T> {
  const before = wallet.approvals;
  const result = await run();
  approvalsUsed[label] = (approvalsUsed[label] ?? 0) + wallet.approvals - before;
  return result;
}

async function post(path: string, authorization: string) {
  const response = await fetch(`${SERVER_URL}${path}`, { method: "POST", headers: { Authorization: authorization } });
  return { status: response.status, text: (await response.text()).slice(0, 200) };
}

/** The link key and delegation carried in a link's tc1 token (bearer material by design). */
function linkMaterial(link: RootBearerLink): { signer: ShareKeySigner; cid: string } {
  const data = JSON.parse(new TextDecoder().decode(fromBase64Url(parseNativeShareUrl(link.url).slice("tc1:".length)))) as { key: { d: string }; keyDid: string; delegation: { cid: string } };
  const secret = fromBase64Url(data.key.d);
  return { signer: { did: data.keyDid.split("#")[0]!, sign: async (bytes) => ed25519.sign(bytes, secret) }, cid: data.delegation.cid };
}

async function invoke(signer: ShareKeySigner, proof: string, resource: string, action: string) {
  const now = seconds(Date.now());
  const invocation = await signCompactUcanAuthorization({
    issuerDid: signer.did, audienceDid: nodeDid, attenuation: { [resource]: { [action]: [{}] } }, facts: [{}], proofs: [proof],
    notBefore: now, expiresAt: now + 60, nonce: `urn:uuid:${crypto.randomUUID()}`, sign: signer.sign,
  });
  return post("/invoke", invocation.authorization);
}

/** Open a link the way the viewer does: the unchanged SharingService receive path, then read. */
async function openLink(link: RootBearerLink): Promise<string> {
  const holder = new TinyCloudNode(nodeConfig);
  const received = await holder.sharing.receive(parseNativeShareUrl(link.url), { autoSubdelegate: false, useSessionKey: false });
  if (!received.ok) return `receive: ${received.error.code}`;
  const read = await received.data.kv.get<string>("");
  return read.ok ? `ok:${String(read.data.data)}` : `${read.error.code}: ${String(read.error.message).split(" - ")[1]?.split(":")[0] ?? ""}`;
}

const publish = (path: string, expiresAt: Date, onRoot: ShareRoot = root) => publishRootBearerLink({ root: onRoot, path, expiresAt, viewerOrigin: VIEWER });

beforeAll(async () => {
  await checkServerHealth();
  nodeDid = (await (await fetch(`${SERVER_URL}/info`)).json() as { nodeId: string }).nodeId;
  await owner.signIn();
  const session = owner.restorableSession!;
  spaceId = session.spaceId;
  ownerDid = `did:pkh:eip155:${session.chainId}:${session.address}`;
  for (const path of [P1, P2, P3]) await owner.kv.put(path, `# ${path.split("/").pop()}`);
  const ensured = await counted("root", () => ensureShareRoot({
    expiresAt: new Date(Date.now() + 7 * DAY), owner: { ownerDid, createOwnerDelegation: (params) => owner.createOwnerDelegation(params) }, spaceId, nodeOrigin: SERVER_URL,
    keyFactory: async () => (rootKey = await createDelegatedShareKey({ extractable: false })),
    options: { policyOwnerModeProbe: notEnforcing },
  }));
  root = ensured.root;
}, 120_000);

describe("bearer links via the share root", () => {
  test("the kv-only root costs one approval; each link none, in today's /viewer#tc1= shape, opened by the unchanged receive path", async () => {
    const a = await counted("links", () => publish(P1, new Date(Date.now() + 7 * DAY)));
    const b = await counted("links", () => publish(P2, new Date(Date.now() + 30 * DAY)));
    const results = { scope: root.scope, url: new URL(a.url).pathname + new URL(a.url).hash.slice(0, 8), a: await openLink(a), b: await openLink(b), approvals: { ...approvalsUsed } };
    console.log("[root-link] publish", JSON.stringify(results));
    expect(results).toMatchObject({ scope: "kv", url: "/viewer#tc1=tc1", a: "ok:# a.md", b: "ok:# b.md", approvals: { root: 1, links: 0 } });
  });

  test("the link key reads only its exact key; the Node refuses wider or longer children of the root", async () => {
    const link = await publish(P1, new Date(Date.now() + DAY));
    const { signer, cid } = linkMaterial(link);
    const child = async (att: Record<string, Record<string, [{}]>>, expiresAt: number) => (await post("/delegate", (await signShareKeyDelegation({
      key: rootKey, audienceDid: signer.did, attenuation: att, proofs: [root.cid], notBefore: seconds(Date.now()) - 5, expiresAt,
    })).authorization)).status;
    const day = seconds(Date.now() + DAY);
    const defaultSpace = spaceId.replace(/:applications$/, ":default");
    const results = {
      own: (await invoke(signer, cid, `${spaceId}/kv/${P1}`, "tinycloud.kv/get")).status,
      sibling: (await invoke(signer, cid, `${spaceId}/kv/${P2}`, "tinycloud.kv/get")).status,
      put: (await invoke(signer, cid, `${spaceId}/kv/${P1}`, "tinycloud.kv/put")).status,
      list: (await invoke(signer, cid, `${spaceId}/kv/${PREFIX}${id}`, "tinycloud.kv/list")).status,
      childPut: await child({ [`${spaceId}/kv/${P1}`]: { "tinycloud.kv/put": [{}] } }, day),
      childOtherSpace: await child({ [`${defaultSpace}/kv/${P1}`]: { "tinycloud.kv/get": [{}] } }, day),
      childOutsidePrefix: await child({ [`${spaceId}/kv/xyz.tinycloud.other/x`]: { "tinycloud.kv/get": [{}] } }, day),
      childBeyondRoot: await child({ [`${spaceId}/kv/${P1}`]: { "tinycloud.kv/get": [{}] } }, seconds(root.expiresAt.getTime()) + 3600),
    };
    console.log("[root-link] scope", JSON.stringify(results));
    expect(results).toEqual({ own: 200, sibling: 401, put: 401, list: 401, childPut: 401, childOtherSpace: 401, childOutsidePrefix: 401, childBeyondRoot: 401 });
  });

  test("expiry is honoured: the link reads until it expires, then the receive path and the Node refuse it", async () => {
    const link = await publish(P3, new Date(Date.now() + 6_000));
    const { signer, cid } = linkMaterial(link);
    const before = { open: await openLink(link), node: (await invoke(signer, cid, `${spaceId}/kv/${P3}`, "tinycloud.kv/get")).status };
    // The Node checks `exp` against its own clock, so this needs real time: a fake client clock cannot expire a link at the Node.
    await Bun.sleep(Math.max(0, link.expiresAt.getTime() - Date.now()) + 2_000);
    const nodeAfter = await invoke(signer, cid, `${spaceId}/kv/${P3}`, "tinycloud.kv/get");
    const after = { open: await openLink(link), node: nodeAfter.status, nodeBody: nodeAfter.text.slice(0, 40) };
    console.log("[root-link] expiry", JSON.stringify({ before, after }));
    expect(before).toEqual({ open: "ok:# c.md", node: 200 });
    expect(after.open.startsWith("ok:")).toBe(false);
    expect(after.node).toBe(401);
  }, 30_000);

  test("a re-root costs one approval, only when the link needs more time than the root has left; old links keep working", async () => {
    const short = await counted("short-root", () => ShareRoot.create({
      owner: { ownerDid, createOwnerDelegation: (params) => owner.createOwnerDelegation(params) }, spaceId, nodeOrigin: SERVER_URL,
      expiresAt: new Date(Date.now() + 2 * DAY), options: { policyOwnerModeProbe: notEnforcing },
    }));
    const oldLink = await counted("links", () => publish(P1, new Date(Date.now() + DAY), short));
    const kept = await counted("reroot", () => ensureShareRoot({ current: short, expiresAt: new Date(Date.now() + DAY), owner: { ownerDid, createOwnerDelegation: (params) => owner.createOwnerDelegation(params) }, spaceId, nodeOrigin: SERVER_URL, options: { policyOwnerModeProbe: notEnforcing } }));
    const rerooted = await counted("reroot", () => ensureShareRoot({ current: short, expiresAt: new Date(Date.now() + 7 * DAY), owner: { ownerDid, createOwnerDelegation: (params) => owner.createOwnerDelegation(params) }, spaceId, nodeOrigin: SERVER_URL, options: { policyOwnerModeProbe: notEnforcing } }));
    const newLink = await counted("links", () => publish(P2, new Date(Date.now() + 7 * DAY), rerooted.root));
    const results = { kept: kept.rerooted, rerooted: rerooted.rerooted, newKey: rerooted.root.keyDid !== short.keyDid, oldLink: await openLink(oldLink), newLink: await openLink(newLink), approvals: { ...approvalsUsed } };
    console.log("[root-link] re-root", JSON.stringify(results));
    expect(results).toMatchObject({ kept: false, rerooted: true, newKey: true, oldLink: "ok:# a.md", newLink: "ok:# b.md", approvals: { "short-root": 1, reroot: 1, links: 0 } });
  });

  test("per-CID revoke: the share key (0 approvals) and the owner (1) revoke a link; the holder's own revoke depends on the Node", async () => {
    const byKey = await publish(P1, new Date(Date.now() + DAY));
    const byOwner = await publish(P2, new Date(Date.now() + DAY));
    const byHolder = await publish(P3, new Date(Date.now() + DAY));
    const keyReceipt = await counted("revoke-by-key", () => revokeRootBearerLink({ root, delegationCid: byKey.delegationCid }));
    const ownerRevoke = await counted("revoke-by-owner", async () => post("/revoke", await owner.signOwnerRevocation(byOwner.delegationCid)));
    const holder = linkMaterial(byHolder);
    const now = seconds(Date.now());
    const holderRevocation = await signCompactUcanAuthorization({
      issuerDid: holder.signer.did, audienceDid: nodeDid, attenuation: { [`urn:cid:${holder.cid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}], proofs: [], notBefore: now, expiresAt: now + 60, nonce: `urn:uuid:${crypto.randomUUID()}`, sign: holder.signer.sign,
    });
    const holderRevoke = await post("/revoke", holderRevocation.authorization);
    const results = {
      byKey: { receipt: keyReceipt.revoked, read: await openLink(byKey) },
      byOwner: { status: ownerRevoke.status, read: await openLink(byOwner) },
      byHolder: { status: holderRevoke.status, body: holderRevoke.text.slice(0, 60), read: await openLink(byHolder) },
      rootStillMints: await openLink(await publish(P1, new Date(Date.now() + DAY))),
      approvals: { key: approvalsUsed["revoke-by-key"], owner: approvalsUsed["revoke-by-owner"] },
      expectation: holderRevokeExpectation,
    };
    console.log("[root-link] revoke", JSON.stringify(results));
    expect(results.byKey.receipt).toBe(true);
    expect(results.byKey.read).toContain("delegation-revoked");
    expect(results.byOwner.status).toBe(200);
    expect(results.byOwner.read).toContain("delegation-revoked");
    expect(results.rootStillMints).toBe("ok:# a.md");
    expect(results.approvals).toEqual({ key: 0, owner: 1 });
    if (holderRevokeExpectation === "refused") {
      expect(results.byHolder.status).toBe(403);
      expect(results.byHolder.read).toBe("ok:# c.md");
    } else {
      expect(results.byHolder.status).toBe(200);
      expect(results.byHolder.read).toContain("delegation-revoked");
    }
  });
});
