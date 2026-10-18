import { describe, expect, it } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { fromBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { parseSignedSiweCacao } from "../../sdk-core/src/delegations/cacao.js";
import { ADDRESS, APPLICATIONS, DEFAULT_SPACE, OWNER_DID, rejects } from "./support/fake-owner.js";
import { fakeNode } from "./support/fake-node.js";
import { decodeOwnerRootCacao, perShareNetworkIdFor, planShareControlBatches, runShareControlBatch, SHARE_CONTROL_HEADER_BUDGET_BYTES, type ShareControlOwner, type ShareControlTarget } from "../src/share-root-entry.js";

const NODE = "https://node.example";
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
const targets = (count: number, withGrant = true): ShareControlTarget[] => Array.from({ length: count }, (_, index) => ({
  networkId: perShareNetworkIdFor(OWNER_DID, shareId(index)),
  ...(withGrant ? { grantCid: `bafkr4i${String(index).padStart(52, "a")}` } : {}),
}));

describe("planShareControlBatches", () => {
  it("sizes every control by its exact Authorization bytes, within 30,000, with the space rows in the first only", () => {
    const owner = wallet();
    const planned = planShareControlBatches({ owner, targets: targets(100), spaceIds: [APPLICATIONS, DEFAULT_SPACE] });
    expect(planned.flatMap((batch) => batch.targets)).toEqual(targets(100));
    expect(planned.every((batch) => batch.headerBytes <= SHARE_CONTROL_HEADER_BUDGET_BYTES)).toBe(true);
    expect(planned[0]!.spaceDelegationResources).toEqual([`${APPLICATIONS}/delegation`, `${DEFAULT_SPACE}/delegation`]);
    expect(planned.slice(1).every((batch) => batch.spaceDelegationResources.length === 0)).toBe(true);
    // Measured: 34 shares fit with both space rows, 35 without (~845 B per share).
    expect(planned.map((batch) => batch.targets.length)).toEqual([34, 35, 31]);
    // Each control is full: one more share would cross the budget.
    expect(planShareControlBatches({ owner, targets: targets(35), spaceIds: [APPLICATIONS, DEFAULT_SPACE] })).toHaveLength(2);
  });

  it("honours a smaller budget and refuses a larger one, foreign networks and repeats", async () => {
    const owner = wallet();
    const small = planShareControlBatches({ owner, targets: targets(10), budgetBytes: 4_000 });
    expect(small.length).toBeGreaterThan(2);
    expect(small.every((batch) => batch.headerBytes <= 4_000)).toBe(true);
    expect(() => planShareControlBatches({ owner, targets: targets(1), budgetBytes: 30_001 })).toThrow("control budget");
    expect(() => planShareControlBatches({ owner, targets: [{ networkId: perShareNetworkIdFor("did:pkh:eip155:1:0x0000000000000000000000000000000000000001", shareId(1)) }] })).toThrow("owner's networks");
    expect(() => planShareControlBatches({ owner, targets: [...targets(1), ...targets(1)] })).toThrow("repeat");
    expect(() => planShareControlBatches({ owner, targets: targets(1), spaceIds: ["tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications"] })).toThrow("owner's");
    expect(() => planShareControlBatches({ owner, targets: targets(1), budgetBytes: 500 })).toThrow("exceeds the control budget");
  });
});

describe("runShareControlBatch", () => {
  it("signs one SIWE control the CACAO verifier accepts, at the planned size, then retires every network before revoking grants", async () => {
    const owner = wallet();
    const [batch] = planShareControlBatches({ owner, targets: targets(3), spaceIds: [APPLICATIONS] });
    const node = fakeNode({ override: (entry) => entry.method === "POST" && (entry.path === "/delegate" || entry.path === "/revoke") ? new Response("{}", { headers: { "content-type": "application/json" } }) : undefined });
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
        if (entry.path === "/delegate") return new Response("{}", { status: 200 });
        if (entry.path !== "/revoke") return undefined;
        if (entry.authorization!.startsWith("owner:")) { ownerRevokes++; return new Response("{}", { status: 200 }); }
        return new Response("Unauthorized Revoker", { status: 403 });
      },
    });
    const refused = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch });
    expect(refused.grants.map((entry) => [entry.result, entry.status])).toEqual([["refused", 403], ["refused", 403]]);
    const fallback = await runShareControlBatch({ owner, nodeOrigin: NODE, batch: batch!, fetch: node.fetch, revokeFallback: { signOwnerRevocation: async (cid) => `owner:${cid}` } });
    expect(fallback.grants.map((entry) => entry.result)).toEqual(["revoked-by-owner", "revoked-by-owner"]);
    expect(ownerRevokes).toBe(2);
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
