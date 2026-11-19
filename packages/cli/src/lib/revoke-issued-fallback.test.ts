import { describe, expect, test } from "bun:test";
import type { ProfileConfig } from "../config/types.js";
// Other test files replace "./revoke-delegation.js" with mock.module, and Bun shares that mock across files run in one process.
// The query string loads this file's own copy of the real module.
const { revokeDelegationOnNode } = await import("./revoke-delegation.js?tc3150-owner-revoke-issued") as typeof import("./revoke-delegation.js");

const CID = "bafkr4iissuedbyme";
const OTHER_CID = "bafkr4iissuedbysomeoneelse";
const ctx = { profile: "owner-fallback-test", host: "https://node.example" };
const profile = { ownerDid: "did:pkh:eip155:1:0x03345826B0a0F6D8c7a3b54e7F5cFaD9b4cA4999" } as ProfileConfig;

type Answer = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; meta?: Record<string, unknown> } };

/** An owner session the node refuses to query (403) and that holds no raw revoke authority. */
function ownerNode(options: { issued: Answer; revokeIssued?: Answer }) {
  const calls = { revokeIssued: [] as string[], ownerRevoke: 0, issuedQueries: 0 };
  const node = {
    accountSpaceId: "tinycloud:pkh:eip155:1:0x03345826B0a0F6D8c7a3b54e7F5cFaD9b4cA4999:default",
    sessionDid: "did:key:z6MkOwnerSession",
    hasRuntimePermissions: () => false,
    revokeDelegation: async () => { calls.ownerRevoke += 1; return { ok: true, data: {} }; },
    delegationManager: {
      query: async (query: { direction: string }) => {
        if (query.direction === "issued") { calls.issuedQueries += 1; return options.issued; }
        return { ok: false, error: { code: "PERMISSION_DENIED", message: "forbidden", meta: { status: 403 } } };
      },
      queryAllIssued: async () => { calls.issuedQueries += 1; return options.issued; },
      revoke: async () => { calls.ownerRevoke += 1; return { ok: true, data: {} }; },
      revokeIssued: async (cid: string) => { calls.revokeIssued.push(cid); return options.revokeIssued ?? { ok: true, data: { cid } }; },
    },
  };
  return { node: node as never, calls };
}
const listing = (...cids: string[]) => ({ ok: true as const, data: cids.map((cid) => ({ cid })) });
const revoke = (node: never, cid = CID) => revokeDelegationOnNode({ ctx, node, profile, cid });

describe("owner revoke falls back to what this key issued", () => {
  test("a CID the node lists as issued by this key is revoked with the key, with no owner authority", async () => {
    const { node, calls } = ownerNode({ issued: listing(CID) });
    expect(await revoke(node)).toMatchObject({ cid: CID, revoked: true, targetSpaceSource: "node-issued-list", authorityScopeSource: "own-session-key" });
    expect(calls).toMatchObject({ revokeIssued: [CID], ownerRevoke: 0 });
  });

  test("someone else's CID is refused with a message naming the issued-by-this-key check, and nothing is revoked", async () => {
    const { node, calls } = ownerNode({ issued: listing(OTHER_CID.replace("someoneelse", "another")) });
    const failure = await revoke(node).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect((failure as Error).message).toContain("doesn't list it among the delegations this profile's key issued");
    expect(calls).toMatchObject({ revokeIssued: [], ownerRevoke: 0 });
  });

  test("a node that refuses the issued revoke gives REVOKE_UNAUTHORIZED, not success", async () => {
    const { node } = ownerNode({
      issued: listing(CID),
      revokeIssued: { ok: false, error: { code: "PERMISSION_DENIED", message: "Unauthorized Revoker", meta: { status: 403 } } },
    });
    await expect(revoke(node)).rejects.toMatchObject({ code: "REVOKE_UNAUTHORIZED" });
  });

  test("a network failure while listing issued delegations is an error, never success or 'not found'", async () => {
    const { node, calls } = ownerNode({ issued: { ok: false, error: { code: "NETWORK_ERROR", message: "connection reset" } } });
    const failure = await revoke(node).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR" });
    expect(calls).toMatchObject({ revokeIssued: [], ownerRevoke: 0 });
  });

  test("a network failure on the revoke itself is an error, never success", async () => {
    const { node } = ownerNode({
      issued: listing(CID),
      revokeIssued: { ok: false, error: { code: "NETWORK_ERROR", message: "connection reset" } },
    });
    await expect(revoke(node)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  test("a node that cannot list issued delegations leaves the CID unknown", async () => {
    const { node } = ownerNode({ issued: { ok: false, error: { code: "UNSUPPORTED_OPERATION", message: "unsupported" } } });
    await expect(revoke(node)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });
});
