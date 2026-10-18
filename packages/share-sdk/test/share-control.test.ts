import { describe, expect, it } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { fromBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { parseSignedSiweCacao } from "../../sdk-core/src/delegations/cacao.js";
import { ADDRESS, APPLICATIONS, DEFAULT_SPACE, OWNER_DID, rejects } from "./support/fake-owner.js";
import { fakeNode, type FakeNodeRequest } from "./support/fake-node.js";
import { decodeOwnerRootCacao, perShareNetworkIdFor, planShareControlBatches, runShareControlBatch, SHARE_CONTROL_HEADER_BUDGET_BYTES, type ShareControlBatch, type ShareControlOwner, type ShareControlTarget } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const LOWER = ADDRESS.toLowerCase();
// ADDRESS is the address of secp256k1 private key 1.
const PRIVATE_KEY = new Uint8Array(32);
PRIVATE_KEY[31] = 1;

function wallet(): ShareControlOwner & { messages: string[] } {
  const messages: string[] = [];
  return {
    ownerDid: OWNER_DID,
    domain: "share.tinycloud.xyz",
    messages,
    async signMessage(message) {
      messages.push(message);
      const bytes = new TextEncoder().encode(message);
      const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`), ...bytes]));
      const signature = secp256k1.sign(digest, PRIVATE_KEY);
      return `0x${signature.toCompactHex()}${(27 + signature.recovery).toString(16)}`;
    },
  };
}

const shareId = (index: number) => `share${String(index).padStart(11, "0")}abcdef0123456789`;
const grantCid = (index: number) => `bafkr4i${String(index).padStart(52, "0").replace(/[0-9]/g, (digit) => "abcdefghij"[Number(digit)]!)}`;
const targets = (count: number, withGrant = true): ShareControlTarget[] => Array.from({ length: count }, (_, index) => ({
  networkId: perShareNetworkIdFor(OWNER_DID, shareId(index)),
  ...(withGrant ? { grantCid: grantCid(index) } : {}),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The CID a revoke invocation names (control path: compact UCAN; owner fallback: `owner:<cid>`). */
const revokedCid = (entry: FakeNodeRequest) => entry.authorization!.startsWith("owner:")
  ? entry.authorization!.slice("owner:".length)
  : Object.keys(verifyCompactUcanAuthorization(entry.authorization!).payload.att)[0]!.slice("urn:cid:".length);

const FORBIDDEN_NETWORKS = [
  ["`:default` (vault and secrets)", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:default`],
  ["`:share`", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share`],
  ["`:vault`", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:vault`],
  ["a near name (`share` + short id)", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share-abc`],
  ["a path-ish name", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share-${shareId(1)}/../default`],
  ["a unicode name", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share-${shareId(1).slice(0, -1)}é`],
  ["an uppercase name", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share-${shareId(1).toUpperCase()}`],
  ["a mixed-case owner", `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:share-${shareId(1)}`],
  ["a newline", `urn:tinycloud:encryption:did:pkh:eip155:1:${LOWER}:share-${shareId(1)}\nResources:`],
  ["another owner's per-share network", perShareNetworkIdFor("did:pkh:eip155:1:0x0000000000000000000000000000000000000001", shareId(1))],
] as const;

describe("planShareControlBatches", () => {
  it("sizes every control by its exact Authorization bytes, within 30,000, and puts the space rows in every control", () => {
    const owner = wallet();
    const planned = planShareControlBatches({ owner, targets: targets(100), spaceIds: [APPLICATIONS, DEFAULT_SPACE] });
    expect(planned.flatMap((batch) => batch.targets)).toEqual(targets(100));
    expect(planned.every((batch) => batch.headerBytes <= SHARE_CONTROL_HEADER_BUDGET_BYTES)).toBe(true);
    expect(planned.every((batch) => batch.spaceDelegationResources.join() === [`${APPLICATIONS}/delegation`, `${DEFAULT_SPACE}/delegation`].join())).toBe(true);
    // Measured: 34 shares fit with both space rows (~845 B per share).
    expect(planned.map((batch) => batch.targets.length)).toEqual([34, 34, 32]);
    // Each control is full: one more share would cross the budget.
    expect(planShareControlBatches({ owner, targets: targets(35), spaceIds: [APPLICATIONS, DEFAULT_SPACE] })).toHaveLength(2);
    // Roots and links only: one control with the rows and no networks.
    expect(planShareControlBatches({ owner, targets: [], spaceIds: [APPLICATIONS] })).toEqual([{ targets: [], spaceDelegationResources: [`${APPLICATIONS}/delegation`], headerBytes: expect.any(Number) }]);
  });

  it("honours a smaller budget and refuses a larger one, repeats, foreign spaces and bad domains", () => {
    const owner = wallet();
    const small = planShareControlBatches({ owner, targets: targets(10), budgetBytes: 4_000 });
    expect(small.length).toBeGreaterThan(2);
    expect(small.every((batch) => batch.headerBytes <= 4_000)).toBe(true);
    expect(() => planShareControlBatches({ owner, targets: targets(1), budgetBytes: 30_001 })).toThrow("control budget");
    expect(() => planShareControlBatches({ owner, targets: [...targets(1), ...targets(1)] })).toThrow("repeat");
    expect(() => planShareControlBatches({ owner, targets: targets(1), spaceIds: ["tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications"] })).toThrow("space rows");
    expect(() => planShareControlBatches({ owner, targets: targets(1), budgetBytes: 500 })).toThrow("exceed the control budget");
    for (const domain of ["share.example\nURI: did:key:evil", "share example", "", "share.example/path", "-share.example"]) {
      expect(() => planShareControlBatches({ owner: { ...owner, domain }, targets: targets(1) })).toThrow("control domain");
    }
    expect(() => planShareControlBatches({ owner, targets: [{ networkId: targets(1)[0]!.networkId, grantCid: "bafy\nnope" }] })).toThrow("grant CID");
  });

  it.each(FORBIDDEN_NETWORKS)("refuses %s as a target before anything is signed", (_case, networkId) => {
    const error = (() => { try { planShareControlBatches({ owner: wallet(), targets: [{ networkId }] }); } catch (caught) { return caught; } return undefined; })();
    expect(error).toMatchObject({ code: "control-target-invalid" });
  });
});

describe("runShareControlBatch", () => {
  it("signs one SIWE control the CACAO verifier accepts, at the planned size, then retires every network before revoking grants", async () => {
    const owner = wallet();
    const [batch] = planShareControlBatches({ owner, targets: targets(3), spaceIds: [APPLICATIONS] });
    const node = fakeNode({ override: (entry) => entry.method === "POST" ? (entry.path === "/delegate" ? json({}) : entry.path === "/revoke" ? json({ revoked: true, cid: revokedCid(entry) }) : undefined) : undefined });
    for (const target of batch!.targets.slice(0, 2)) node.networks.set(target.networkId, { networkId: target.networkId, name: target.networkId.slice(target.networkId.lastIndexOf(":") + 1), ownerDid: OWNER_DID, alg: "x25519-aes256gcm/v1", keyVersion: 1, threshold: { n: 1, t: 1 }, state: "active" });

    const result = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch });
    expect(owner.messages).toHaveLength(1);
    const imported = node.requests.find((entry) => entry.path === "/delegate")!;
    expect(imported.authorization!.length).toBe(batch!.headerBytes);
    // Released Nodes refuse an unpadded CACAO header whose length is not a multiple of 4.
    expect(imported.authorization!.length % 4).toBe(0);

    const verified = await parseSignedSiweCacao(imported.authorization!, result.controlCid);
    expect(verified.issuer.toLowerCase()).toBe(OWNER_DID.toLowerCase());
    const decoded = decodeOwnerRootCacao(fromBase64Url(imported.authorization!.replace(/=+$/, "")));
    expect(Object.keys(decoded.attenuation).sort()).toEqual([`${APPLICATIONS}/delegation`, ...batch!.targets.map((target) => target.networkId)].sort());
    expect(decoded.attenuation[batch!.targets[0]!.networkId]).toEqual({ "tinycloud.delegation/revoke": [{}], "tinycloud.encryption/network.revoke": [{}] });
    expect(decoded.attenuation[`${APPLICATIONS}/delegation`]).toEqual({ "tinycloud.delegation/revoke": [{}] });
    expect(owner.messages[0]).toStartWith(`share.tinycloud.xyz wants you to sign in with your Ethereum account:\n${ADDRESS}\n`);

    expect(result.networks.map((entry) => entry.result)).toEqual(["retired", "retired", "absent"]);
    expect(result.grants.map((entry) => entry.result)).toEqual(["revoked", "revoked", "revoked"]);
    const posts = node.requests.filter((entry) => entry.method === "POST").map((entry) => entry.path);
    expect(posts.indexOf("/revoke")).toBeGreaterThan(posts.findLastIndex((path) => path.startsWith("/encryption/networks/")));
    const revoke = node.requests.find((entry) => entry.path === "/revoke")!;
    const { payload } = verifyCompactUcanAuthorization(revoke.authorization!);
    expect(payload.prf).toEqual([result.controlCid]);
    expect(payload.att).toEqual({ [`urn:cid:${batch!.targets[0]!.grantCid}`]: { "tinycloud.delegation/revoke": [{}] } });
  });

  it("falls back to one owner revoke per grant the Node refuses through the control", async () => {
    const owner = wallet();
    const [batch] = planShareControlBatches({ owner, targets: targets(2) });
    let ownerRevokes = 0;
    const node = fakeNode({
      override: (entry) => {
        if (entry.path === "/delegate") return json({});
        if (entry.path !== "/revoke") return undefined;
        if (entry.authorization!.startsWith("owner:")) { ownerRevokes++; return json({ revoked: true, cid: revokedCid(entry) }); }
        return new Response("Unauthorized Revoker", { status: 403 });
      },
    });
    const refused = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch });
    expect(refused.grants.map((entry) => [entry.result, entry.status])).toEqual([["refused", 403], ["refused", 403]]);
    const fallback = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch, revokeFallback: { signOwnerRevocation: async (cid) => `owner:${cid}` } });
    expect(fallback.grants.map((entry) => entry.result)).toEqual(["revoked-by-owner", "revoked-by-owner"]);
    expect(ownerRevokes).toBe(2);
  });

  it("counts a revoke only with a receipt for that grant, through the control and through the fallback", async () => {
    const owner = wallet();
    const [batch] = planShareControlBatches({ owner, targets: targets(1) });
    const node = fakeNode({ override: (entry) => entry.path === "/delegate" ? json({}) : entry.path === "/revoke" ? json({ revoked: true, cid: "bafkr4iotherotherotherotherother" }) : undefined });
    const result = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch, revokeFallback: { signOwnerRevocation: async (cid) => `owner:${cid}` } });
    expect(result.grants).toEqual([{ grantCid: grantCid(0), result: "refused", status: 200 }]);
    const empty = fakeNode({ override: (entry) => entry.path === "/delegate" ? json({}) : entry.path === "/revoke" ? new Response("", { status: 200 }) : undefined });
    expect((await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: empty.fetch })).grants[0]!.result).toBe("refused");
  });

  it.each(FORBIDDEN_NETWORKS)("refuses a hand-built batch naming %s, before any prompt or request", async (_case, networkId) => {
    const owner = wallet();
    const node = fakeNode();
    const batch: ShareControlBatch = { targets: [{ networkId }], spaceDelegationResources: [], headerBytes: 1_000 };
    await rejects(runShareControlBatch({ owner, nodeOrigin: NODE, batch, fetch: node.fetch }), "control-target-invalid");
    expect(owner.messages).toHaveLength(0);
    expect(node.requests).toHaveLength(0);
  });

  it("re-checks a hand-built batch: domain, space rows and the byte budget on the real values, before any prompt", async () => {
    const owner = wallet();
    const node = fakeNode();
    const [full] = planShareControlBatches({ owner, targets: targets(40), spaceIds: [APPLICATIONS, DEFAULT_SPACE] });
    const overBudget: ShareControlBatch = { ...full!, targets: [...full!.targets, ...targets(40).slice(full!.targets.length, full!.targets.length + 2)] };
    await rejects(runShareControlBatch({ owner, nodeOrigin: NODE, batch: overBudget, fetch: node.fetch }), "invalid-request");
    await rejects(runShareControlBatch({ owner: { ...owner, domain: "share.example\nURI: did:key:evil" }, nodeOrigin: NODE, batch: full!, fetch: node.fetch }), "invalid-request");
    await rejects(runShareControlBatch({ owner, nodeOrigin: NODE, batch: { ...full!, spaceDelegationResources: [`${APPLICATIONS}/kv/`] }, fetch: node.fetch }), "control-target-invalid");
    await rejects(runShareControlBatch({ owner, nodeOrigin: NODE, batch: { targets: [], spaceDelegationResources: [], headerBytes: 0 }, fetch: node.fetch }), "invalid-request");
    expect(owner.messages).toHaveLength(0);
    expect(node.requests).toHaveLength(0);
  });

  it("stops when the Node refuses the control, and rejects a malformed wallet signature", async () => {
    const owner = wallet();
    const [batch] = planShareControlBatches({ owner, targets: targets(1) });
    const node = fakeNode({ override: (entry) => entry.path === "/delegate" ? new Response("bad", { status: 401 }) : undefined });
    await rejects(runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch }), "node-refused");
    expect(node.requests.some((entry) => entry.path.startsWith("/encryption/"))).toBe(false);
    await rejects(runShareControlBatch({ owner: { ...owner, signMessage: async () => "0x1234" }, nodeOrigin: NODE, batch: batch!, fetch: node.fetch }), "invalid-request");
  });
});
