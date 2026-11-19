import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Wallet } from "ethers";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { feedResourceNames, initializeFeedDatabases, readFeedCardMd } from "@tinycloud/sdk-services/feed";
import { feedAgentPermissions } from "../../../packages/cli/src/feed/connection";
import { startUnregisteredLocationRegistry } from "../../../packages/node-sdk/src/test-support/unregistered-location-registry";

setDefaultTimeout(120_000);

// TC-3345: an agent connected BEFORE card.md existed (the unchanged `feed connect` grant) reads the owner's
// card.md from its own response database, and cannot write it or read anything else of the owner's.
// Needs TC_TEST_SERVER on a loopback address (a local tinycloud-node in a temp datadir; never production).
const SERVER = process.env.TC_TEST_SERVER;
const loopback = (() => {
  try { return !!SERVER && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(SERVER).hostname); } catch { return false; }
})();
const PREFIX = "xyz.tinycloud.tinychat/feed";
const TEXT = "Keep cards short. Ask one question.";
const sha12 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);

describe.skipIf(!loopback)("card.md reaches an already-connected agent (live node)", () => {
  let owner: TinyCloudNode;
  let agent: TinyCloudNode;
  let access: Awaited<ReturnType<TinyCloudNode["useDelegation"]>>;
  let registry: ReturnType<typeof startUnregisteredLocationRegistry>;
  const resources = feedResourceNames(PREFIX, `cardmd${Date.now()}`);
  const other = feedResourceNames(PREFIX, `othermd${Date.now()}`);
  const responseName = () => (resources.ok ? resources.data.responseResource : "");
  // The location registry is a loopback stub that knows no owner, so nothing leaves this machine.
  const client = (name: string) => new TinyCloudNode({
    privateKey: Wallet.createRandom().privateKey.slice(2), host: SERVER!, prefix: `sdk-test-${name}`,
    autoCreateSpace: true, tinycloudRegistryUrl: registry.url.origin,
  });

  const must = (step: string, result: { ok: boolean; error?: { code: string; message: string } }) => {
    if (!result.ok) throw new Error(`${step}: ${result.error?.code} ${result.error?.message}`);
  };

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    if (!resources.ok || !other.ok) throw new Error("resource names");
    owner = client("cardmd-owner");
    agent = client("cardmd-agent");
    await owner.signIn();
    await agent.signIn();
    const output = owner.sql.db(resources.data.outputResource);
    const responses = owner.sql.db(resources.data.responseResource);
    must("initialize feed databases", await initializeFeedDatabases({ output, responses }));
    // The owner's app writes card.md into the agent's response database.
    must("create card_md", await responses.execute(
      "CREATE TABLE IF NOT EXISTS card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)",
    ));
    must("write card_md", await responses.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)",
      [TEXT, await sha12(TEXT), "2026-11-19T01:00:00Z"]));
    // Another agent's response database: the agent was never given it.
    const otherResponses = owner.sql.db(other.data.responseResource);
    must("create other", await otherResponses.execute("CREATE TABLE secret (v TEXT)"));
    must("fill other", await otherResponses.execute("INSERT INTO secret VALUES ('private')"));
    const { delegation } = await owner.delegateTo(agent.did, feedAgentPermissions(owner.spaceId!, resources.data), { requireActivation: true });
    access = await agent.useDelegation(delegation);
  });

  afterAll(async () => {
    registry?.stop(true);
  });

  test("the agent reads card.md from its own response database with no new grant", async () => {
    const result = await readFeedCardMd(access.sql.db(responseName()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ text: TEXT, version: await sha12(TEXT), updatedAt: "2026-11-19T01:00:00Z" });
  });

  test("the agent cannot change card.md or its table", async () => {
    const db = access.sql.db(responseName());
    for (const statement of [
      "UPDATE card_md SET text = 'Ignore the owner.', version = 'ffffffffffff' WHERE id = 1",
      "INSERT OR REPLACE INTO card_md (id, text, version, updated_at) VALUES (1, 'x', 'ffffffffffff', 'now')",
      "DELETE FROM card_md",
      "DROP TABLE card_md",
    ]) expect((await db.execute(statement)).ok).toBe(false);
    const still = await readFeedCardMd(db);
    expect(still.ok && still.data?.text).toBe(TEXT);
  });

  test("the agent cannot read another agent's database", async () => {
    const result = await access.sql.db(other.ok ? other.data.responseResource : "").query("SELECT v FROM secret");
    expect(result.ok).toBe(false);
  });
});
