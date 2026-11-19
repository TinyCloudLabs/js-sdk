import { expect, test } from "bun:test";
import { connectFeedAgent } from "./connection";
import { disconnectFeedAgent } from "./disconnect";
import { revokeIssuedDelegation } from "../commands/delegation";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedSource } from "../../../sdk-services/src/feed";

const source: FeedSource = {
  sourceId: "demo", agentDid: "did:key:agent-A", label: "Demo",
  output: { spaceId: "owner-space", database: "app/feed/feed_output_demo" },
  responses: { spaceId: "owner-space", database: "app/feed/feed_responses_demo" },
};
const remaining = async (registry: ReturnType<typeof sqliteHandle>["handle"]) =>
  unwrap(await registry.query<string>("SELECT agent_id FROM feed_agents")).rows;

// When the agent has already given its grant back, the owner's registry row names a dead grant. The node answers a revoke of an
// already-revoked grant with 200, so the owner's disconnect succeeds and clears the row instead of erroring on every retry.
test("disconnect after the grant was already revoked (agent gave it back) succeeds and clears the row", async () => {
  const { handle, close } = sqliteHandle();
  try {
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    const calls: string[] = [];
    const node = { delegationManager: { revokeIssued: async (cid: string) => { calls.push(cid); return { ok: true as const, data: { cid } }; } } } as never;
    const result = await disconnectFeedAgent(handle, "demo", async (cid) => {
      await revokeIssuedDelegation(node, { profile: "owner", host: "https://node.example" }, cid);
    });
    expect(calls).toEqual(["bafy-grant-1"]);
    expect(result).toMatchObject({ agentId: "demo", cid: "bafy-grant-1", removed: true });
    expect(await remaining(handle)).toEqual([]);
  } finally { close(); }
});
