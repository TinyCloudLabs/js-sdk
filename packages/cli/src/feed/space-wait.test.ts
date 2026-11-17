import { expect, test } from "bun:test";
import { connectFeedAgent } from "./connection";
import { FEED_SPACE_WAIT_DELAYS_MS, retryWhileSpaceNotHosted } from "./space-wait";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedDatabase, FeedSource } from "../../../sdk-services/src/feed";

const source: FeedSource = {
  sourceId: "demo", agentDid: "did:key:agent-A", label: "Demo",
  output: { spaceId: "owner-space", database: "app/feed/feed_output_demo" },
  responses: { spaceId: "owner-space", database: "app/feed/feed_responses_demo" },
};
const notHosted = { ok: false as const, error: { code: "NOT_FOUND", message: "404 - Space not found", service: "sql", meta: { status: 404 } } };

/** A node that answers "Space not found" to the first `failures` registry writes, as a brand-new account's does while OpenKey hosts it. */
function newAccount(inner: FeedDatabase, failures: number) {
  let calls = 0;
  const handle: FeedDatabase = { ...inner, execute: async (...args) => (++calls <= failures ? notHosted : inner.execute(...args)) };
  return { handle, calls: () => calls };
}
const run = (handle: FeedDatabase, activate: () => Promise<object>, slept: number[], lines: string[]) =>
  retryWhileSpaceNotHosted(() => connectFeedAgent(handle, source, activate), { sleep: async (ms) => { slept.push(ms); }, write: (line) => { lines.push(line); } });

test("the first connect on a brand-new account waits out `Space not found` and then succeeds", async () => {
  const { handle, close } = sqliteHandle();
  try {
    const account = newAccount(handle, 2);
    const slept: number[] = []; const lines: string[] = []; let activated = 0;
    const grant = await run(account.handle, async () => { activated += 1; return { cid: "bafy-grant-1" }; }, slept, lines);
    expect(grant).toEqual({ cid: "bafy-grant-1" });
    expect(slept).toEqual(FEED_SPACE_WAIT_DELAYS_MS.slice(0, 2));
    expect(lines).toHaveLength(1);
    expect(activated).toBe(1);
    expect(unwrap(await handle.query<string>("SELECT agent_id FROM feed_agents")).rows).toEqual([["demo"]]);
  } finally { close(); }
});

test("a space that never appears ends as SPACE_SETUP_PENDING after the bounded wait, with nothing reserved", async () => {
  const { handle, close } = sqliteHandle();
  try {
    const account = newAccount(handle, 1_000);
    const slept: number[] = []; let activated = 0;
    await expect(run(account.handle, async () => { activated += 1; return {}; }, slept, [])).rejects.toMatchObject({
      code: "SPACE_SETUP_PENDING", exitCode: 1, message: expect.stringContaining("run the same command again in a minute"),
    });
    expect(slept).toEqual([...FEED_SPACE_WAIT_DELAYS_MS]);
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(30_000);
    expect(activated).toBe(0);
    // Nothing was written, so the same token connects once the space is hosted.
    await connectFeedAgent(handle, source, async () => ({ cid: "bafy-grant-1" }));
    expect(unwrap(await handle.query<string>("SELECT agent_id FROM feed_agents")).rows).toEqual([["demo"]]);
  } finally { close(); }
});

test("only `Space not found` is waited on: any other failure is thrown at once", async () => {
  const { handle, close } = sqliteHandle();
  try {
    const refused = { ...handle, execute: async () => ({ ok: false as const, error: { code: "PERMISSION_DENIED", message: "not allowed", service: "sql", meta: { status: 403 } } }) };
    const slept: number[] = [];
    await expect(run(refused, async () => ({}), slept, [])).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(slept).toEqual([]);
  } finally { close(); }
});

test("a `Space not found` that arrives while the grant is being issued is retried with the same reservation", async () => {
  const { handle, close } = sqliteHandle();
  try {
    const slept: number[] = []; let activations = 0;
    const grant = await run(handle, async () => {
      activations += 1;
      if (activations === 1) throw Object.assign(new Error("404 - Space not found"), { meta: { status: 404 } });
      return { cid: "bafy-grant-1" };
    }, slept, []);
    expect(grant).toEqual({ cid: "bafy-grant-1" });
    expect(slept).toEqual([2_000]);
    expect(unwrap(await handle.query<string>("SELECT agent_id, agent_did FROM feed_agent_bindings")).rows).toEqual([["demo", "did:key:agent-A"]]);
  } finally { close(); }
});
