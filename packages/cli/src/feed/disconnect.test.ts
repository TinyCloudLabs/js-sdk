import { expect, test } from "bun:test";
import { connectFeedAgent } from "./connection";
import { disconnectFeedAgent } from "./disconnect";
import { ExitCode } from "../config/constants";
import { CLIError } from "../output/errors";
import { revokeIssuedDelegation } from "../commands/delegation";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedSource } from "../../../sdk-services/src/feed";

const source: FeedSource = {
  sourceId: "demo", agentDid: "did:key:agent-A", label: "Demo",
  output: { spaceId: "owner-space", database: "app/feed/feed_output_demo" },
  responses: { spaceId: "owner-space", database: "app/feed/feed_responses_demo" },
};
const rows = async (registry: ReturnType<typeof sqliteHandle>["handle"], table: string) =>
  unwrap(await registry.query<string>(`SELECT agent_id FROM ${table}`)).rows;

test("disconnect revokes the grant recorded at connect, then removes the registry row", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    const revoked: string[] = [];
    const result = await disconnectFeedAgent(handle, "demo", async (cid) => {
      // The row still exists while the revoke runs: revoke first, delete after.
      expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
      revoked.push(cid);
    });
    expect(revoked).toEqual(["bafy-grant-1"]);
    expect(result).toEqual({ agentId: "demo", cid: "bafy-grant-1", revoked: true, removed: true });
    expect(await rows(handle, "feed_agents")).toEqual([]);
  } finally { close(); }
});

test("a failed revoke leaves the row, so the owner can retry", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    await expect(disconnectFeedAgent(handle, "demo", async () => { throw new Error("node refused"); })).rejects.toThrow("node refused");
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
    const retried: string[] = [];
    await disconnectFeedAgent(handle, "demo", async (cid) => { retried.push(cid); });
    expect(retried).toEqual(["bafy-grant-1"]);
    expect(await rows(handle, "feed_agents")).toEqual([]);
  } finally { close(); }
});

test("the token stays reserved for the same agent after disconnect: the same DID reconnects, another DID cannot take it", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    await disconnectFeedAgent(handle, "demo", async () => undefined);
    await expect(connectFeedAgent(handle, { ...source, agentDid: "did:key:agent-B" }, async () => ({ cid: "bafy-grant-B" })))
      .rejects.toThrow("already bound to another agent identity");
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-2" }));
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
  } finally { close(); }
});

test("an unknown token changes nothing and revokes nothing", async () => {
  const { handle, close } = sqliteHandle();
  const never = async () => { throw new Error("revoke must not run"); };
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    await expect(disconnectFeedAgent(handle, "other", never)).rejects.toMatchObject({ code: "FEED_AGENT_NOT_FOUND" });
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
  } finally { close(); }
});

test("a registry that was never created reads as not connected, not as a database failure", async () => {
  const { handle, close } = sqliteHandle();
  // The SQL service reports a missing table as an error result.
  const neverCreated = { ...handle, query: async () => ({ ok: false as const, error: { code: "SQL_ERROR", message: "no such table: feed_agents", service: "sql" } }) };
  try {
    await expect(disconnectFeedAgent(neverCreated, "demo", async () => { throw new Error("revoke must not run"); }))
      .rejects.toMatchObject({ code: "FEED_AGENT_NOT_FOUND" });
  } finally { close(); }
});

test("a registry row with no readable grant ID is reported and left alone", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    unwrap(await handle.execute("UPDATE feed_agents SET authorization_json = ? WHERE agent_id = ?", ["not json", "demo"]));
    await expect(disconnectFeedAgent(handle, "demo", async () => { throw new Error("revoke must not run"); }))
      .rejects.toMatchObject({ code: "FEED_GRANT_UNREADABLE" });
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
  } finally { close(); }
});

test("a node that has no such delegation means there is nothing left to revoke: the row is removed and the result says so", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    const result = await disconnectFeedAgent(handle, "demo", async (cid) => {
      throw new CLIError("TARGET_NOT_FOUND", `The node has no delegation "${cid}".`, ExitCode.NOT_FOUND);
    });
    expect(result).toEqual({ agentId: "demo", cid: "bafy-grant-1", revoked: false, nodeHadNoGrant: true, removed: true });
    expect(await rows(handle, "feed_agents")).toEqual([]);
  } finally { close(); }
});

test("any other node refusal, including an unauthorized revoke, still leaves the row", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    await expect(disconnectFeedAgent(handle, "demo", async () => {
      throw new CLIError("REVOKE_UNAUTHORIZED", "The node refused this revocation.", ExitCode.PERMISSION_DENIED);
    })).rejects.toMatchObject({ code: "REVOKE_UNAUTHORIZED" });
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
  } finally { close(); }
});

// The node's own answer to a revocation it cannot place is `404 Space not found`; the SDK reports it as NOT_FOUND. A 404 from anything
// else (a proxy, an older node's route) comes back as a failed request: it must never be read as "the grant is gone".
const nodeAnswering = (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
  ({ delegationManager: { revokeIssued: async () => ({ ok: false as const, error }) } }) as never;
const revokeVia = (node: never) => (cid: string) => revokeIssuedDelegation(node, { profile: "owner", host: "https://node.example" }, cid).then(() => undefined);

test("the node's `Space not found` answer to the revoke removes the row", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    const node = nodeAnswering({ code: "NOT_FOUND", message: "Delegation not found: bafy-grant-1", meta: { cid: "bafy-grant-1", status: 404 } });
    expect(await disconnectFeedAgent(handle, "demo", revokeVia(node))).toMatchObject({ revoked: false, nodeHadNoGrant: true, removed: true });
    expect(await rows(handle, "feed_agents")).toEqual([]);
  } finally { close(); }
});

test("a bare 404 (a proxy or an older node) keeps the row and reports a failure", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    const node = nodeAnswering({ code: "NETWORK_ERROR", message: "Failed to revoke delegation: 404 - <html>Not Found</html>", meta: { cid: "bafy-grant-1", status: 404 } });
    const failure = await disconnectFeedAgent(handle, "demo", revokeVia(node)).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure).not.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(await rows(handle, "feed_agents")).toEqual([["demo"]]);
  } finally { close(); }
});
