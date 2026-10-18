import { describe, expect, it } from "bun:test";
import { verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { APPLICATIONS, DEFAULT_SPACE, OWNER_DID, SHARE_NETWORK, fakeOwner, rejects, type Tamper } from "./support/fake-owner.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "../src/index.js";
import { ensureShareNetwork, shareNetworkIdFor } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const NODE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const NETWORK = shareNetworkIdFor(OWNER_DID);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const descriptor = (overrides: Record<string, unknown> = {}) => ({ networkId: NETWORK, ownerDid: OWNER_DID, name: "share", state: "active", ...overrides });

/** A fake Node: `/info`, network lookup and network creation, recording the create request. */
function fakeNode(options: { exists?: boolean; createStatus?: number; lookup?: () => Response } = {}) {
  let exists = options.exists ?? false;
  const creates: { authorization: string; body: string }[] = [];
  const fetch = async (input: URL, init?: RequestInit) => {
    if (input.pathname === "/info") return json({ protocol: 1, nodeId: NODE_DID, features: ["kv"] });
    if (input.pathname === "/encryption/networks" && init?.method === "POST") {
      creates.push({ authorization: new Headers(init.headers).get("authorization") ?? "", body: String(init.body) });
      exists = true;
      return options.createStatus === 409 ? json({ error: "exists" }, 409) : json({ descriptor: descriptor() }, 201);
    }
    if (input.pathname === `/encryption/networks/${encodeURIComponent(NETWORK)}`) return options.lookup?.() ?? (exists ? json({ descriptor: descriptor() }) : json({ error: "not found" }, 404));
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, creates };
}

async function ensure(options: { tamper?: Tamper; node?: ReturnType<typeof fakeNode>; spaceId?: string } = {}) {
  const owner = fakeOwner(options.tamper);
  const node = options.node ?? fakeNode();
  const keys: DelegatedShareKey[] = [];
  const promise = ensureShareNetwork({
    owner, spaceId: options.spaceId ?? APPLICATIONS, nodeOrigin: NODE, fetch: node.fetch,
    keyFactory: async () => { const key = await createDelegatedShareKey({ extractable: false }); keys.push(key); return key; },
  });
  return { owner, node, keys, promise };
}

describe("ensureShareNetwork", () => {
  it("is free when the owner's :share network exists", async () => {
    const { owner, node, promise } = await ensure({ node: fakeNode({ exists: true }) });
    expect(await promise).toEqual({ networkId: NETWORK, approvals: 0 });
    expect(owner.calls).toHaveLength(0);
    expect(node.creates).toHaveLength(0);
  });

  it("otherwise costs one approval for a 10-minute network.create grant, creates the network with the owner as owner, and clears the key", async () => {
    const { owner, node, keys, promise } = await ensure();
    expect(await promise).toEqual({ networkId: NETWORK, approvals: 1 });
    expect(owner.calls).toHaveLength(1);
    const call = owner.calls[0]!;
    expect(call.permissions).toEqual([{ service: "tinycloud.encryption", path: NETWORK, actions: ["tinycloud.encryption/network.create"] }]);
    expect(call.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(node.creates).toHaveLength(1);
    const invocation = verifyCompactUcanAuthorization(node.creates[0]!.authorization);
    expect(invocation.payload.iss.split("#")[0]).toBe(keys[0]!.did);
    expect(invocation.payload.aud).toBe(NODE_DID);
    expect(invocation.payload.att).toEqual({ [NETWORK]: { "tinycloud.encryption/network.create": [{}] } });
    expect(invocation.payload.prf).toHaveLength(1);
    expect(invocation.payload.fct[0]).toMatchObject({ type: "tinycloud.encryption.network-admin/v1", targetNode: NODE_DID, networkId: NETWORK, action: "tinycloud.encryption/network.create" });
    expect(JSON.parse(node.creates[0]!.body)).toEqual({ name: "share", ownerDid: OWNER_DID, threshold: { n: 1, t: 1 } });
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("treats a concurrent creator's 409 as created", async () => {
    const { promise } = await ensure({ node: fakeNode({ createStatus: 409 }) });
    expect(await promise).toEqual({ networkId: NETWORK, approvals: 1 });
  });

  it("refuses a revoked or foreign network, and a non-applications space, without prompting", async () => {
    for (const lookup of [() => json({ descriptor: descriptor({ state: "revoked" }) }), () => json({ descriptor: descriptor({ ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" }) })]) {
      const { owner, promise } = await ensure({ node: fakeNode({ lookup }) });
      await rejects(promise, "invalid-request");
      expect(owner.calls).toHaveLength(0);
    }
    const { owner, promise } = await ensure({ spaceId: DEFAULT_SPACE });
    await rejects(promise, "invalid-request");
    expect(owner.calls).toHaveLength(0);
  });

  it("rejects a signed grant wider than network.create on :share and creates nothing", async () => {
    const { node, keys, promise } = await ensure({ tamper: { att: (att) => { att[NETWORK]!["tinycloud.encryption/decrypt"] = [{}]; } } });
    expect((await rejects(promise, "ability-mismatch")).mustRevoke).toBe(true);
    expect(node.creates).toHaveLength(0);
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("names one :share network per owner, matching the root's decrypt resource in any address case", () => {
    expect(NETWORK).toBe(`urn:tinycloud:encryption:${OWNER_DID}:share`);
    expect(NETWORK.toLowerCase()).toBe(SHARE_NETWORK);
  });
});
