import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey, fromBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { APPLICATIONS, DAY, fakeOwner, rejects } from "./support/fake-owner.js";
import { parseNativeShareUrl } from "../src/index.js";
import { ShareRoot, publishRootBearerLink, revokeRootBearerLink } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const NODE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const VIEWER = "https://share.example";
const PATH = "xyz.tinycloud.share/shares/s1/a.md";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake Node recording `/delegate` and `/revoke` requests. */
function fakeNode(options: { delegateStatus?: number; receipt?: (cid: string) => unknown } = {}) {
  const delegated: string[] = [];
  const revocations: string[] = [];
  const fetch = async (input: URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (input.pathname === "/info") return json({ protocol: 1, nodeId: NODE_DID, features: ["kv"] });
    if (input.pathname === "/delegate") { delegated.push(authorization); return options.delegateStatus === undefined ? new Response("", { status: 200 }) : new Response("Child delegation expiry exceeds parent expiry", { status: options.delegateStatus }); }
    if (input.pathname === "/revoke") {
      revocations.push(authorization);
      const cid = Object.keys(verifyCompactUcanAuthorization(authorization).payload.att)[0]!.slice("urn:cid:".length);
      return json(options.receipt?.(cid) ?? { revoked: true, cid });
    }
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, delegated, revocations };
}

async function kvRoot(days = 37) {
  const owner = fakeOwner();
  const root = await ShareRoot.create({ owner, spaceId: APPLICATIONS, nodeOrigin: NODE, expiresAt: new Date(Date.now() + days * DAY) });
  return { owner, root };
}

describe("publishRootBearerLink", () => {
  it("mints a /viewer#tc1= link carrying the link key and a kv/get delegation under the root, with no approval", async () => {
    const { owner, root } = await kvRoot();
    const node = fakeNode();
    const link = await publishRootBearerLink({ root, path: PATH, expiresAt: new Date(Date.now() + 7 * DAY), viewerOrigin: VIEWER, fetch: node.fetch });
    expect(owner.calls).toHaveLength(1);
    expect(new URL(link.url).origin + new URL(link.url).pathname).toBe(`${VIEWER}/viewer`);
    const token = parseNativeShareUrl(link.url);
    expect(token.startsWith("tc1:")).toBe(true);
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(token.slice(4))));
    expect(Object.keys(data).sort()).toEqual(["delegation", "host", "key", "keyDid", "path", "spaceId", "version"]);
    expect(data).toMatchObject({ host: NODE, spaceId: APPLICATIONS, path: PATH, version: 1 });
    const linkDid = didKeyFromEd25519PublicKey(ed25519.getPublicKey(fromBase64Url(data.key.d)));
    expect(didKeyFromEd25519PublicKey(fromBase64Url(data.key.x))).toBe(linkDid);
    expect(data.keyDid.split("#")[0]).toBe(linkDid);
    expect(data.delegation).toMatchObject({ cid: link.delegationCid, delegateDID: linkDid, delegatorDID: root.keyDid, parentCid: root.cid, actions: ["tinycloud.kv/get"], path: PATH, isRevoked: false });
    const ucan = verifyCompactUcanAuthorization(data.delegation.authHeader, link.delegationCid);
    expect(ucan.payload.aud).toBe(linkDid);
    expect(ucan.payload.prf).toEqual([root.cid]);
    expect(ucan.payload.att).toEqual({ [`${APPLICATIONS}/kv/${PATH}`]: { "tinycloud.kv/get": [{}] } });
    expect(new Date(data.delegation.expiry).getTime()).toBe(link.expiresAt.getTime());
    expect(node.delegated).toEqual([data.delegation.authHeader]);
  });

  it("refuses broader paths, longer expiries and bad viewer origins before touching the Node or the wallet", async () => {
    const { owner, root } = await kvRoot(20);
    const node = fakeNode();
    const week = new Date(Date.now() + 7 * DAY);
    for (const path of ["xyz.tinycloud.share/shares/", "xyz.tinycloud.share/shares/s1/", "xyz.tinycloud.share/shares/*", "xyz.tinycloud.share/shares/../secrets/x", "xyz.tinycloud.other/a.md"]) {
      await rejects(publishRootBearerLink({ root, path, expiresAt: week, viewerOrigin: VIEWER, fetch: node.fetch }), "link-out-of-scope");
    }
    await rejects(publishRootBearerLink({ root, path: PATH, expiresAt: new Date(Date.now() + 21 * DAY), viewerOrigin: VIEWER, fetch: node.fetch }), "lifetime-exceeds-cap");
    const long = (await kvRoot()).root;
    await rejects(publishRootBearerLink({ root: long, path: PATH, expiresAt: new Date(Date.now() + 31 * DAY), viewerOrigin: VIEWER, fetch: node.fetch }), "lifetime-exceeds-cap");
    await expect(publishRootBearerLink({ root, path: PATH, expiresAt: week, viewerOrigin: "http://share.example", fetch: node.fetch })).rejects.toThrow("canonical HTTPS origin");
    expect(node.delegated).toHaveLength(0);
    expect(owner.calls).toHaveLength(1);
  });

  it("reports a Node refusal (e.g. a revoked root) as node-refused", async () => {
    const { root } = await kvRoot();
    await rejects(publishRootBearerLink({ root, path: PATH, expiresAt: new Date(Date.now() + DAY), viewerOrigin: VIEWER, fetch: fakeNode({ delegateStatus: 401 }).fetch }), "node-refused");
  });
});

describe("revokeRootBearerLink", () => {
  it("revokes a link with the share key and requires a matching receipt", async () => {
    const { root } = await kvRoot();
    const node = fakeNode();
    const link = await publishRootBearerLink({ root, path: PATH, expiresAt: new Date(Date.now() + DAY), viewerOrigin: VIEWER, fetch: node.fetch });
    expect(await revokeRootBearerLink({ root, delegationCid: link.delegationCid, fetch: node.fetch })).toEqual({ revoked: true, cid: link.delegationCid });
    const revocation = verifyCompactUcanAuthorization(node.revocations[0]!);
    expect(revocation.payload.iss.split("#")[0]).toBe(root.keyDid);
    expect(revocation.payload.aud).toBe(NODE_DID);
    expect(revocation.payload.att).toEqual({ [`urn:cid:${link.delegationCid}`]: { "tinycloud.delegation/revoke": [{}] } });
    expect(revocation.payload.exp - revocation.payload.nbf).toBe(60);

    await rejects(revokeRootBearerLink({ root, delegationCid: link.delegationCid, fetch: fakeNode({ receipt: () => ({ revoked: true, cid: "bafyother" }) }).fetch }), "invalid-request");
    await rejects(revokeRootBearerLink({ root, delegationCid: link.delegationCid, fetch: fakeNode({ receipt: (cid) => ({ revoked: false, cid }) }).fetch }), "invalid-request");
    await rejects(revokeRootBearerLink({ root, delegationCid: root.cid, fetch: node.fetch }), "invalid-request");
    for (const delegationCid of ["not-a-cid", `${link.delegationCid}\n`, link.delegationCid.toUpperCase()]) {
      await rejects(root.signLinkRevocation({ delegationCid, nodeDid: NODE_DID }), "invalid-request");
    }
  });
});
