import { describe, expect, test } from "bun:test";
import type { AccountDelegationRecord } from "@tinycloud/node-sdk";
import { lookupOwnerSpaceOnNode, ownerSpaceFromNodeRecords } from "./revoke-node-record.js";

const ADDRESS = "0x03345826B0a0F6D8c7a3b54e7F5cFaD9b4cA4999";
const OWNER = `did:pkh:eip155:1:${ADDRESS}`;
const OTHER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const OTHER_SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
const OWNER_SESSION = "did:key:z6MkOwnerSession";
const AGENT = "did:key:z6MkAgent";
const STRANGER = "did:key:z6MkStranger";
const CID = "bafkr4iagrantcid";

function record(overrides: Partial<AccountDelegationRecord> = {}): AccountDelegationRecord {
  return {
    cid: CID, direction: "granted", delegatorDid: OWNER_SESSION, delegateDid: AGENT,
    resources: [{ resource: `${SPACE}/kv/xyz.test.health/`, actions: ["tinycloud.kv/get"], caveats: [{}] }],
    parents: ["bafkr4iaownersession"], issuedAt: null, notBefore: null, expiresAt: null, status: "active",
    ...overrides,
  };
}

/** The owner's session delegation: the wallet-signed root the agent's grant was derived from. */
function ownerSessionRecord(overrides: Partial<AccountDelegationRecord> = {}): AccountDelegationRecord {
  return record({
    cid: "bafkr4iaownersession", delegatorDid: OWNER, delegateDid: OWNER_SESSION, parents: [],
    resources: [{ resource: `${SPACE}/kv`, actions: ["tinycloud.kv/get"], caveats: [{}] }],
    ...overrides,
  });
}

const lookup = (records: AccountDelegationRecord[], sessionDid?: string, ownerDid = OWNER) =>
  ownerSpaceFromNodeRecords(records, CID, ownerDid, sessionDid);

describe("node record lookup: accepted", () => {
  test("a grant whose issuer chains to the owner resolves to the space it covers", () => {
    expect(lookup([record(), ownerSessionRecord()])).toBe(SPACE);
  });

  test("a grant issued by the owner's own DID needs no chain", () => {
    expect(lookup([record({ delegatorDid: OWNER, parents: [] })])).toBe(SPACE);
  });

  test("a grant issued by the signed-in session needs no chain, with or without a DID fragment", () => {
    const issuedBySession = record({ delegatorDid: OWNER_SESSION, parents: [] });
    expect(lookup([issuedBySession], `${OWNER_SESSION}#z6MkOwnerSession`)).toBe(SPACE);
  });

  test("a longer chain of session keys still reaches the owner", () => {
    const middle = ownerSessionRecord({ cid: "bafkr4iamiddle", delegatorDid: "did:key:z6MkMiddle", delegateDid: OWNER_SESSION, parents: ["bafkr4iatop"] });
    const top = ownerSessionRecord({ cid: "bafkr4iatop", delegatorDid: OWNER, delegateDid: "did:key:z6MkMiddle", parents: [] });
    expect(lookup([record({ parents: ["bafkr4iamiddle"] }), middle, top])).toBe(SPACE);
  });

  test("owner and space compare case-insensitively, and the same CID listed once per direction is one grant", () => {
    const received = record({ direction: "received", delegatorDid: OWNER.toLowerCase(), parents: [] });
    const granted = record({ direction: "granted", delegatorDid: OWNER.toLowerCase(), parents: [] });
    expect(lookup([received, granted], undefined, OWNER)).toBe(SPACE);
  });

  test("a delegation that is already revoked still resolves, so repeating a revoke stays idempotent", () => {
    expect(lookup([record({ status: "revoked" }), ownerSessionRecord()])).toBe(SPACE);
  });
});

describe("node record lookup: refused", () => {
  test("a CID the node does not list", () => {
    expect(lookup([ownerSessionRecord()])).toBeUndefined();
    expect(lookup([])).toBeUndefined();
  });

  test("a delegator that is neither the owner nor the signed-in session, with no chain to the owner", () => {
    expect(lookup([record({ delegatorDid: STRANGER, parents: [] })], OWNER_SESSION)).toBeUndefined();
  });

  test("a chain whose root is issued by someone else", () => {
    expect(lookup([record(), ownerSessionRecord({ delegatorDid: OTHER })])).toBeUndefined();
  });

  test("a parent that was not delegated to this grant's issuer does not link the chain", () => {
    expect(lookup([record(), ownerSessionRecord({ delegateDid: STRANGER })])).toBeUndefined();
  });

  test("a parent CID the record does not name does not link the chain", () => {
    expect(lookup([record({ parents: ["bafkr4iaunrelated"] }), ownerSessionRecord()])).toBeUndefined();
  });

  test("a chain that loops back on itself ends instead of hanging", () => {
    const loop = ownerSessionRecord({ delegatorDid: STRANGER, delegateDid: OWNER_SESSION, parents: [CID] });
    expect(lookup([record({ parents: ["bafkr4iaownersession"] }), loop])).toBeUndefined();
  });

  test("a space owned by someone else, even with the owner's issuer", () => {
    const foreign = record({ delegatorDid: OWNER, parents: [], resources: [{ resource: `${OTHER_SPACE}/kv/x/`, actions: [], caveats: [] }] });
    expect(lookup([foreign])).toBeUndefined();
  });

  test("one owned space plus one foreign space", () => {
    const mixed = record({ delegatorDid: OWNER, parents: [], resources: [
      { resource: `${SPACE}/kv/x/`, actions: [], caveats: [] },
      { resource: `${OTHER_SPACE}/kv/x/`, actions: [], caveats: [] },
    ] });
    expect(lookup([mixed])).toBeUndefined();
  });

  test("two spaces the owner holds are ambiguous", () => {
    const two = record({ delegatorDid: OWNER, parents: [], resources: [
      { resource: `${SPACE}/kv/x/`, actions: [], caveats: [] },
      { resource: `tinycloud:pkh:eip155:1:${ADDRESS}:default/kv/x/`, actions: [], caveats: [] },
    ] });
    expect(lookup([two])).toBeUndefined();
  });

  test("a resource that names no TinyCloud space, or no resource at all", () => {
    expect(lookup([record({ delegatorDid: OWNER, parents: [], resources: [{ resource: "urn:tinycloud:encryption:did:pkh:eip155:1:x", actions: [], caveats: [] }] })])).toBeUndefined();
    expect(lookup([record({ delegatorDid: OWNER, parents: [], resources: [] })])).toBeUndefined();
  });

  test("the same CID listed twice with different issuers or scopes is ambiguous", () => {
    const first = record({ delegatorDid: OWNER, parents: [] });
    const second = record({ delegatorDid: OWNER, parents: [], delegateDid: STRANGER });
    const wider = record({ delegatorDid: OWNER, parents: [], resources: [{ resource: `${SPACE}/kv/`, actions: [], caveats: [] }] });
    expect(lookup([first, second])).toBeUndefined();
    expect(lookup([first, wider])).toBeUndefined();
  });

  test.each([
    ["a control character in the name", `${SPACE}\nx`],
    ["a newline-separated second space", `${SPACE}\ntinycloud:pkh:eip155:1:${ADDRESS}:secrets`],
    ["an inner did: prefix", `tinycloud:did:pkh:eip155:1:${ADDRESS}:applications`],
    ["an extra segment after the name", `${SPACE}:extra`],
    ["no name at all", `tinycloud:pkh:eip155:1:${ADDRESS}`],
    ["an empty name", `tinycloud:pkh:eip155:1:${ADDRESS}:`],
    ["a name over 64 characters", `${SPACE}${"x".repeat(64)}`],
    ["a non-ASCII name", `tinycloud:pkh:eip155:1:${ADDRESS}:applicati\u043ens`],
    ["a zero-width character in the name", `${SPACE}\u200b`],
    ["an upper-cased scheme", `TINYCLOUD:PKH:EIP155:1:${ADDRESS}:applications`],
    ["a name that starts with a dot", `tinycloud:pkh:eip155:1:${ADDRESS}:.applications`],
    ["an address that is not 40 hex digits", `tinycloud:pkh:eip155:1:${ADDRESS.slice(0, -1)}:applications`],
    ["chain id zero", `tinycloud:pkh:eip155:0:${ADDRESS}:applications`],
  ])("a node-supplied space with %s is refused even when the owner and issuer match", (_why, space) => {
    const odd = record({ delegatorDid: OWNER, parents: [], resources: [{ resource: `${space}/kv/x/`, actions: [], caveats: [] }] });
    expect(lookup([odd])).toBeUndefined();
  });

  test("a CID that differs only in case, or only after a shared prefix, is a different grant", () => {
    const issuedByOwner = { delegatorDid: OWNER, parents: [] };
    expect(lookup([record({ ...issuedByOwner, cid: CID.toUpperCase() })])).toBeUndefined();
    expect(lookup([record({ ...issuedByOwner, cid: `${CID}x` })])).toBeUndefined();
    expect(lookup([record({ ...issuedByOwner, cid: CID.slice(0, 12) })])).toBeUndefined();
    expect(lookup([record({ ...issuedByOwner, cid: `${CID.slice(0, 12)}${"z".repeat(CID.length - 12)}` })])).toBeUndefined();
    expect(lookup([record({ ...issuedByOwner, cid: CID })])).toBe(SPACE);
  });

  test("a different signed-in owner never matches", () => {
    expect(lookup([record(), ownerSessionRecord()], undefined, OTHER)).toBeUndefined();
  });
});

describe("the chain walk is bounded", () => {
  /** Records held by one key that each name every other one as a parent, none rooted at the owner: the worst case for a naive walk. */
  function web(size: number): AccountDelegationRecord[] {
    const cids = Array.from({ length: size }, (_, index) => (index === 0 ? CID : `bafkr4iaweb${index}`));
    return cids.map((own) => record({
      cid: own, delegatorDid: "did:key:z6MkShared", delegateDid: "did:key:z6MkShared",
      parents: cids.filter((other) => other !== own),
    }));
  }

  test("a web of mutual parents with no owner root is refused quickly", () => {
    const records = web(9);
    const started = performance.now();
    expect(lookup(records, undefined)).toBeUndefined();
    // Without one visit per record this is 8^8 walks (seconds); 11 crafted records took about 2 s before the fix.
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the same web still resolves when one record in it is the owner's", () => {
    const records = web(9);
    records[5] = { ...records[5]!, delegatorDid: OWNER, parents: [] };
    const started = performance.now();
    expect(lookup(records, undefined)).toBe(SPACE);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a chain longer than the hop limit is refused", () => {
    const hops = 12;
    const chain = Array.from({ length: hops }, (_, index) => record({
      cid: index === 0 ? CID : `bafkr4iahop${index}`,
      delegatorDid: index === hops - 1 ? OWNER : `did:key:z6MkHop${index + 1}`,
      delegateDid: index === 0 ? AGENT : `did:key:z6MkHop${index}`,
      parents: index === hops - 1 ? [] : [`bafkr4iahop${index + 1}`],
    }));
    expect(lookup(chain)).toBeUndefined();
    expect(lookup(chain.slice(0, 5).map((entry, index) => index === 4 ? { ...entry, delegatorDid: OWNER, parents: [] } : entry))).toBe(SPACE);
  });
});

describe("lookupOwnerSpaceOnNode", () => {
  function nodeWith(pages: AccountDelegationRecord[][], failAt?: number) {
    const cursors: Array<string | undefined> = [];
    return {
      cursors,
      node: {
        sessionDid: `${OWNER_SESSION}#z6MkOwnerSession`,
        delegationManager: {
          query: async (options: { cursor?: string }) => {
            cursors.push(options.cursor);
            const index = options.cursor === undefined ? 0 : Number(options.cursor);
            if (index === failAt) return { ok: false as const, error: { code: "NETWORK_ERROR", message: "refused", service: "delegation" } };
            const nextCursor = index + 1 < pages.length ? String(index + 1) : undefined;
            return { ok: true as const, data: { schemaVersion: 2 as const, items: pages[index]!, ...(nextCursor === undefined ? {} : { nextCursor }) } };
          },
        },
      },
    };
  }

  test("reads every page, so a grant and its chain on different pages still resolve", async () => {
    const { node, cursors } = nodeWith([[record()], [ownerSessionRecord()]]);
    expect(await lookupOwnerSpaceOnNode(node as never, CID, OWNER)).toBe(SPACE);
    expect(cursors).toEqual([undefined, "1"]);
  });

  test("a grant found before the page limit is still refused when more pages remain unread", async () => {
    const full = { sessionDid: OWNER_SESSION, delegationManager: { query: async () => ({
      ok: true as const,
      data: { schemaVersion: 2 as const, items: [record({ delegatorDid: OWNER, parents: [] })], nextCursor: "more" },
    }) } };
    expect(await lookupOwnerSpaceOnNode(full as never, CID, OWNER)).toBeUndefined();
  });

  test("a refused query yields nothing instead of throwing", async () => {
    const { node } = nodeWith([[record()], [ownerSessionRecord()]], 1);
    expect(await lookupOwnerSpaceOnNode(node as never, CID, OWNER)).toBeUndefined();
  });

  test("stops after a bounded number of pages", async () => {
    const forever = { sessionDid: OWNER_SESSION, delegationManager: { query: async () => ({ ok: true as const, data: { schemaVersion: 2 as const, items: [], nextCursor: "again" } }) } };
    let calls = 0;
    const counted = { ...forever, delegationManager: { query: async () => { calls += 1; return forever.delegationManager.query(); } } };
    expect(await lookupOwnerSpaceOnNode(counted as never, CID, OWNER)).toBeUndefined();
    expect(calls).toBe(50);
  });

  test("the node's current session is what makes a session-issued grant the owner's", async () => {
    const { node } = nodeWith([[record({ parents: [] })]]);
    expect(await lookupOwnerSpaceOnNode(node as never, CID, OWNER)).toBe(SPACE);
  });
});
