import { expect, test } from "bun:test";
import { connectFeedAgent } from "./connection";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedSource } from "../../../sdk-services/src/feed";

const source: FeedSource = {
  sourceId: "demo", agentDid: "did:key:agent-A", label: "Demo",
  output: { spaceId: "owner-space", database: "app/feed/feed_output_demo" },
  responses: { spaceId: "owner-space", database: "app/feed/feed_responses_demo" },
};

async function bindings(registry: ReturnType<typeof sqliteHandle>) {
  const result = unwrap(await registry.handle.query<string>("SELECT agent_id, agent_did FROM feed_agent_bindings"));
  return result.rows;
}

// TC-3149: one bad call by an agent must not make its token unusable.
test("an empty or malformed --to is refused before the token is reserved", async () => {
  const registry = sqliteHandle();
  try {
    let activated = 0;
    for (const agentDid of ["", "agent-A", "did:key:", "did: key:a"]) {
      await expect(connectFeedAgent(registry.handle, { ...source, agentDid }, async () => { activated += 1; return {}; }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT", exitCode: 2, message: expect.stringMatching(/Invalid agent DID/) });
    }
    expect(activated).toBe(0);
    // Nothing was written, not even the table, so the same token connects with the right DID.
    unwrap(await registry.handle.execute("CREATE TABLE IF NOT EXISTS feed_agent_bindings (agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE)"));
    expect(await bindings(registry)).toEqual([]);
    await connectFeedAgent(registry.handle, source, async () => ({ cid: "grant-A" }));
    expect(await bindings(registry)).toEqual([["demo", "did:key:agent-A"]]);
  } finally {
    registry.close();
  }
});

test("a reservation an older CLI left for an empty DID is released; a reservation for another DID still holds", async () => {
  const registry = sqliteHandle();
  try {
    await connectFeedAgent(registry.handle, { ...source, sourceId: "held", agentDid: "did:key:agent-B",
      output: { spaceId: "owner-space", database: "app/feed/feed_output_held" },
      responses: { spaceId: "owner-space", database: "app/feed/feed_responses_held" } }, async () => ({ cid: "grant-B" }));
    unwrap(await registry.handle.execute(
      "INSERT INTO feed_agent_bindings (agent_id, agent_did, output_resource, response_resource) VALUES (?, '', ?, ?)",
      ["demo", source.output.database, source.responses.database]));

    await connectFeedAgent(registry.handle, source, async () => ({ cid: "grant-A" }));
    expect((await bindings(registry)).sort()).toEqual([["demo", "did:key:agent-A"], ["held", "did:key:agent-B"]]);

    // The healing is limited to the empty identity: a real binding is never replaced.
    await expect(connectFeedAgent(registry.handle, { ...source, sourceId: "held", agentDid: "did:key:agent-C",
      output: { spaceId: "owner-space", database: "app/feed/feed_output_held" },
      responses: { spaceId: "owner-space", database: "app/feed/feed_responses_held" } }, async () => ({ cid: "grant-C" })))
      .rejects.toThrow(/already bound to another agent identity/);
  } finally {
    registry.close();
  }
});
