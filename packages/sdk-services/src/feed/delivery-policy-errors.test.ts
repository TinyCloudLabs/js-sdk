import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { ErrorCodes } from "../types";
import type { FetchFunction } from "../types";
import {
  appendFeedResponse, initializeFeedDatabases, initializeFeedHandoff,
  listFeedResponseDeliveries, listenFeedResponses, publishFeedCard,
} from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHooks, FeedResponse } from "./types";

type Stage = "headers" | "metadata";
type ListenerStop = { state: "stopped" } | { state: "failed"; error: unknown };
const marker = "SYNTHETIC-PRIVATE-ERROR-ABORT-RACE-27";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function raceFixture(stage: Stage, failQuery: boolean) {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  const handoff = sqliteHandle();
  cleanup.push(output.close, responses.close, handoff.close);
  unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  unwrap(await initializeFeedHandoff(handoff.handle));
  const card: FeedCard = {
    cardId: "card-query-error-abort", revision: 1, issuanceId: "issuance-query-error-abort",
    kind: "decision", needsResponse: true, title: "Review the draft", body: "Keep the draft reversible.",
    urgency: 1, createdAt: "2026-10-29T12:00:00Z",
  };
  unwrap(await publishFeedCard(output.handle, card));
  unwrap(await appendFeedResponse(output.handle, responses.handle, {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-query-error-abort", kind: "answer", text: "Review the draft.", createdAt: card.createdAt,
  }, { type: "synthetic-approval", version: 1, data: { code: marker } }));
  if (failQuery) {
    // Header and metadata failures both come from the actual requested SQLite statement.
    unwrap(await responses.handle.execute(stage === "headers"
      ? "DROP TABLE feed_response_payloads" : "DROP TABLE feed_response_delivery_policies"));
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      try {
        const body = await request.json();
        return Response.json(unwrap(await responses.handle.query(body.sql, body.params)));
      } catch (error) {
        return Response.json({
          error: `${marker}: ${String(error)}`,
          cause: { privateValue: marker }, meta: { privatePayload: { code: marker } },
        }, { status: 400 });
      }
    },
  });
  cleanup.push(() => server.stop(true));
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const completedStatuses: number[] = [];
  const abortAt = stage === "headers" ? 1 : 2;
  const detachedFetch: FetchFunction = async (url, options) => {
    // Ignore cancellation only at this public transport seam. Read the real HTTP
    // body completely, then detach it before aborting, so SQLService can classify
    // a completed HTTP400 rather than encountering a body-stream AbortError.
    const wire = await globalThis.fetch(url, { ...options, signal: undefined });
    const body = await wire.arrayBuffer();
    const detached = new Response(body, {
      status: wire.status, statusText: wire.statusText, headers: wire.headers,
    });
    completedStatuses.push(wire.status);
    if (completedStatuses.length === abortAt) abort.abort();
    return detached;
  };
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "test-invocation" }), hosts: [server.url.href], fetch: detachedFetch,
    retryPolicy: { maxAttempts: 1 },
    session: {
      delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
      spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
      verificationMethod: "did:key:test", jwk: {},
    },
  });
  const ordinary: unknown[] = [];
  context.on("service.error", (event) => { ordinary.push(event); });
  const service = new SQLService();
  service.initialize(context);
  return {
    responses: service.db("feed_error_abort_race"), handoff: handoff.handle,
    abort, completedStatuses, ordinary, deliveries: [] as FeedResponse[],
  };
}

async function startListener(fixture: Awaited<ReturnType<typeof raceFixture>>) {
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
  const stopped: Promise<ListenerStop> = listenFeedResponses({
    responses: fixture.responses, handoff: fixture.handoff, recipient: "race-runtime",
    hooks, subscription: { space: "owner-space", service: "sql", pathPrefix: "app/feed_error_abort_race" },
    signal: fixture.abort.signal,
    deliver: async (response) => { fixture.deliveries.push(response); return "delivered"; },
  }).then(() => ({ state: "stopped" }), (error: unknown) => ({ state: "failed", error }));
  cleanup.push(async () => { fixture.abort.abort(); await stopped; });
  await opened.promise;
  ready?.();
  return { stopped };
}

for (const stage of ["headers", "metadata"] as const) {
  test(`${stage} HTTP400 coincident with abort remains SQL_ERROR in the delivery reader`, async () => {
    const fixture = await raceFixture(stage, true);
    const result = await listFeedResponseDeliveries(fixture.responses, {
      recipient: "race-runtime", signal: fixture.abort.signal,
    });
    expect(fixture.abort.signal.aborted).toBe(true);
    expect(fixture.completedStatuses).toEqual(stage === "headers" ? [400] : [200, 400]);
    // Independently establish SQLService's classification before asserting the feed boundary.
    expect(fixture.ordinary).toEqual([expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
    })]);
    expect(inspect({ result, ordinary: fixture.ordinary }, { depth: 20 })).not.toContain(marker);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
  });

  test(`${stage} HTTP400 coincident with abort fails the listener instead of stopping cleanly`, async () => {
    const fixture = await raceFixture(stage, true);
    const listener = await startListener(fixture);
    const result = await listener.stopped;
    expect(fixture.abort.signal.aborted).toBe(true);
    expect(fixture.completedStatuses).toEqual(stage === "headers" ? [400] : [200, 400]);
    expect(fixture.ordinary).toEqual([expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
    })]);
    expect(fixture.deliveries).toEqual([]);
    expect(unwrap(await fixture.handoff.query("SELECT response_id, state FROM feed_handoffs")).rows).toEqual([]);
    expect(inspect({ result, ordinary: fixture.ordinary, deliveries: fixture.deliveries }, { depth: 20 })).not.toContain(marker);
    expect(result).toMatchObject({ state: "failed", error: { code: ErrorCodes.SQL_ERROR } });
  });

  test(`${stage} successful real rows returned after abort remain an ABORTED delivery page`, async () => {
    const fixture = await raceFixture(stage, false);
    const result = await listFeedResponseDeliveries(fixture.responses, {
      recipient: "race-runtime", signal: fixture.abort.signal,
    });
    expect(fixture.abort.signal.aborted).toBe(true);
    expect(fixture.completedStatuses).toEqual(stage === "headers" ? [200] : [200, 200]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
    expect(fixture.ordinary).toEqual([]);
    expect(inspect(result, { depth: 20 })).not.toContain(marker);
  });

  test(`${stage} successful real rows returned after abort stop the listener without handoff`, async () => {
    const fixture = await raceFixture(stage, false);
    const listener = await startListener(fixture);
    const result = await listener.stopped;
    expect(fixture.abort.signal.aborted).toBe(true);
    expect(fixture.completedStatuses).toEqual(stage === "headers" ? [200] : [200, 200]);
    expect(result).toEqual({ state: "stopped" });
    expect(fixture.ordinary).toEqual([]);
    expect(fixture.deliveries).toEqual([]);
    expect(unwrap(await fixture.handoff.query("SELECT response_id, state FROM feed_handoffs")).rows).toEqual([]);
    expect(inspect({ result, deliveries: fixture.deliveries }, { depth: 20 })).not.toContain(marker);
  });
}
