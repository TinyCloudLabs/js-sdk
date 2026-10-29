import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { ErrorCodes } from "../types";
import type { FetchFunction } from "../types";
import {
  appendFeedResponse, initializeFeedDatabases, listenFeedResponses, publishFeedCard,
} from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHooks, FeedResponse } from "./types";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

function readyHooks() {
  const opened = Promise.withResolvers<void>();
  let ready: (() => void) | undefined;
  const hooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      ready = options?.onReady;
      options?.signal?.addEventListener("abort", stop, { once: true });
      opened.resolve();
      try {
        if (!options?.signal?.aborted) await stopped.promise;
      } finally { options?.signal?.removeEventListener("abort", stop); }
    },
  };
  return { hooks, opened: opened.promise, ready: () => ready?.() };
}

type ListenerStop = { state: "stopped" } | { state: "failed"; error: unknown };

async function listenerFixture(fetch?: FetchFunction) {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  const handoff = sqliteHandle();
  cleanup.push(output.close, responses.close, handoff.close);
  unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  const card: FeedCard = {
    cardId: "card-listener-cancel", revision: 1, issuanceId: "issuance-listener-cancel",
    kind: "decision", needsResponse: true, title: "Draft", body: "Create only a reversible draft.",
    urgency: 1, createdAt: "2026-10-29T12:00:00Z",
  };
  unwrap(await publishFeedCard(output.handle, card));
  unwrap(await appendFeedResponse(output.handle, responses.handle, {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-listener-cancel", kind: "answer", text: "Create the draft.", createdAt: card.createdAt,
  }));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<boolean>();
  // Execute the actual SQL received over HTTP against the real stored response,
  // rather than echoing a query option or manufacturing a successful query result.
  const server = createServer(async (request, response) => {
    response.once("close", () => closed.resolve(response.writableEnded));
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      arrived.resolve();
      const query = JSON.parse(body);
      const page = unwrap(await responses.handle.query(query.sql, query.params));
      await release.promise;
      if (response.destroyed) return;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(page));
      sent.resolve();
    } catch (error) {
      arrived.resolve();
      if (!response.destroyed) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback SQL did not bind a TCP port");
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "test-invocation" }), hosts: [`http://127.0.0.1:${address.port}`], fetch,
    retryPolicy: { maxAttempts: 1 },
    session: {
      delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
      spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
      verificationMethod: "did:key:test", jwk: {},
    },
  });
  const sql = new SQLService();
  sql.initialize(context);
  const transport = readyHooks();
  const abort = new AbortController();
  const deliveries: FeedResponse[] = [];
  const stopped: Promise<ListenerStop> = listenFeedResponses({
    responses: sql.db("feed_responses_cancel"), handoff: handoff.handle, recipient: "cancel-runtime",
    hooks: transport.hooks, subscription: { space: "owner-space", service: "sql", pathPrefix: "app/feed_responses_cancel" },
    signal: abort.signal, deliver: async (item) => { deliveries.push(item); return "delivered"; },
  }).then(() => ({ state: "stopped" }), (error: unknown) => ({ state: "failed", error }));
  cleanup.push(async () => {
    abort.abort();
    const shut = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    // Also release a deliberately signal-ignoring transport when a regression times out.
    release.resolve();
    await shut;
    await stopped;
  });
  return {
    ...transport, abort, stopped, deliveries, handoff: handoff.handle, responses: responses.handle,
    arrived: arrived.promise, closed: closed.promise, sent: sent.promise, release: () => release.resolve(),
  };
}

test("aborting a ready listener cancels its pending real SQL request and settles without delivery", async () => {
  const fixture = await listenerFixture();
  await fixture.opened;
  fixture.ready();
  await fixture.arrived;
  fixture.abort.abort();
  // The test runner's normal liveness deadline detects a missing abort; no polling,
  // sleeps, runtime timeout policy, or test-generated completion response is involved.
  const [stopped, completedResponse] = await Promise.all([fixture.stopped, fixture.closed]);
  expect(stopped).toEqual({ state: "stopped" });
  expect(completedResponse).toBe(false);
  expect(fixture.deliveries).toEqual([]);
  expect(unwrap(await fixture.handoff.query("SELECT response_id, state FROM feed_handoffs")).rows).toEqual([]);
});

test("real rows returned after abort by a signal-ignoring transport create no new handoff or callback", async () => {
  const ignoreAbort: FetchFunction = (url, options) => globalThis.fetch(url, { ...options, signal: undefined });
  const fixture = await listenerFixture(ignoreAbort);
  await fixture.opened;
  fixture.ready();
  await fixture.arrived;
  fixture.abort.abort();
  fixture.release();
  await fixture.sent;
  expect(await fixture.stopped).toEqual({ state: "stopped" });
  expect(fixture.deliveries).toEqual([]);
  expect(unwrap(await fixture.handoff.query("SELECT response_id, state FROM feed_handoffs")).rows).toEqual([]);
});

test("a real SQL failure is still a listener failure rather than a successful cancellation", async () => {
  const fixture = await listenerFixture();
  unwrap(await fixture.responses.execute("DROP TABLE feed_response_payloads"));
  await fixture.opened;
  fixture.ready();
  await fixture.arrived;
  expect(await fixture.stopped).toMatchObject({ state: "failed", error: { code: ErrorCodes.SQL_ERROR } });
  expect(fixture.deliveries).toEqual([]);
});
