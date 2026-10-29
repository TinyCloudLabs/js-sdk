import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFeedAgent } from "./connection";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedSource } from "../../../sdk-services/src/feed";

const source: FeedSource = {
  sourceId: "same-owner-token", agentDid: "did:key:agent-A", label: "Agent A",
  output: { spaceId: "owner-space", database: "app/feed/feed_output_same-owner-token" },
  responses: { spaceId: "owner-space", database: "app/feed/feed_responses_same-owner-token" },
};

test("two independent connections cannot activate grants for different DIDs under one unused token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc2205-connect-race-"));
  const first = sqliteHandle(join(directory, "registry.sqlite"));
  const second = sqliteHandle(join(directory, "registry.sqlite"));
  const activated = sqliteHandle();
  try {
    unwrap(await activated.handle.execute("CREATE TABLE activated (cid TEXT PRIMARY KEY, agent_did TEXT NOT NULL)"));
    const activate = async (did: string, cid: string) => {
      // A real activation side effect, not a mock call counter or returned echo.
      unwrap(await activated.handle.execute("INSERT INTO activated VALUES (?, ?)", [cid, did]));
      return { cid };
    };
    const competing = { ...source, agentDid: "did:key:agent-B", label: "Agent B" };
    const results = await Promise.allSettled([
      connectFeedAgent(first.handle, source, () => activate(source.agentDid, "grant-A")),
      connectFeedAgent(second.handle, competing, () => activate(competing.agentDid, "grant-B")),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const grants = unwrap(await activated.handle.query<string>("SELECT cid, agent_did FROM activated")).rows;
    expect(grants).toHaveLength(1);
    const registered = unwrap(await first.handle.query<string>(
      "SELECT agent_did, output_resource, response_resource, authorization_json FROM feed_agents WHERE agent_id = ?",
      [source.sourceId],
    )).rows;
    expect(registered).toEqual([[
      grants[0][1], source.output.database, source.responses.database, JSON.stringify({ cid: grants[0][0] }),
    ]]);
  } finally {
    activated.close(); second.close(); first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed activation leaves no grant provenance, preserves binding, and allows the same DID to retry", async () => {
  const registry = sqliteHandle();
  const activated = sqliteHandle();
  try {
    unwrap(await activated.handle.execute("CREATE TABLE activated (agent_did TEXT NOT NULL)"));
    await expect(connectFeedAgent(registry.handle, source, async () => {
      throw new Error("node refused activation");
    })).rejects.toThrow("node refused activation");
    expect(unwrap(await registry.handle.query("SELECT agent_id FROM feed_agents")).rows).toEqual([]);
    await expect(connectFeedAgent(registry.handle, { ...source, agentDid: "did:key:agent-B" }, async () => {
      unwrap(await activated.handle.execute("INSERT INTO activated VALUES (?)", ["did:key:agent-B"]));
      return { cid: "must-not-activate" };
    })).rejects.toThrow();
    await connectFeedAgent(registry.handle, source, async () => {
      unwrap(await activated.handle.execute("INSERT INTO activated VALUES (?)", [source.agentDid]));
      return { cid: "grant-retry" };
    });
    expect(unwrap(await activated.handle.query("SELECT agent_did FROM activated")).rows).toEqual([[source.agentDid]]);
    expect(unwrap(await registry.handle.query("SELECT authorization_json FROM feed_agents")).rows)
      .toEqual([[JSON.stringify({ cid: "grant-retry" })]]);
  } finally { activated.close(); registry.close(); }
});
