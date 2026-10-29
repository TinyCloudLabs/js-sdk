import { afterEach, expect, test } from "bun:test";
import {
  appendFeedResponse, getFeedHandoff, initializeFeedDatabases,
  initializeFeedHandoff, listenFeedResponses, publishFeedCard,
} from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHooks, FeedReadDatabase, FeedResponse } from "./types";
import type { HookEvent } from "../hooks/types";
import type { SqlValue, QueryOptions } from "../sql/types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function database() {
  const fixture = sqliteHandle();
  cleanup.push(fixture.close);
  return fixture.handle;
}

// Hooks transport lifecycle is independently owned/tested by the shared hooks slice.
// This controllable stream models the exact public lifecycle boundary, not a replay queue.
function hooksFixture() {
  const opened = Promise.withResolvers<void>();
  let ready: (() => void) | undefined;
  let controller!: ReadableStreamDefaultController<HookEvent>;
  const stream = new ReadableStream<HookEvent>({ start(value) { controller = value; } });
  const hooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      opened.resolve();
      ready = options?.onReady;
      const close = () => controller.close();
      options?.signal?.addEventListener("abort", close, { once: true });
      try {
        for await (const event of stream) yield event;
      } finally {
        options?.signal?.removeEventListener("abort", close);
      }
    },
  };
  return {
    hooks, opened: opened.promise, ready: () => ready?.(),
    wake: () => controller.enqueue({
      type: "write", id: "wake-only-not-response-identity", space: "owner-space", service: "sql",
      ability: "tinycloud.sql/write", path: "app/feed_responses_agentone", actor: "owner",
      epoch: "epoch", eventIndex: 1, timestamp: "2026-10-28T12:00:00.000Z",
    }),
  };
}

const card: FeedCard = {
  cardId: "card-listener-full-id", revision: 1, issuanceId: "issuance-listener-full-id",
  kind: "decision", needsResponse: true, title: "Draft", body: "Create draft only",
  urgency: 1, createdAt: "2026-10-28T12:00:00.000Z",
};

test("subscribe readiness precedes drain; a wake during drain and reconnect both reconcile stored responses", async () => {
  const output = database();
  const responses = database();
  const handoff = database();
  const effects = database();
  unwrap(await initializeFeedDatabases({ output, responses }));
  unwrap(await initializeFeedHandoff(handoff));
  unwrap(await effects.execute("CREATE TABLE drafts (response_id TEXT NOT NULL)"));
  unwrap(await publishFeedCard(output, card));
  const answer = (responseId: string) => ({
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId, kind: "followup" as const, text: responseId, createdAt: card.createdAt,
  });
  unwrap(await appendFeedResponse(output, responses, answer("response-before-ready")));
  const transport = hooksFixture();
  const abort = new AbortController();
  let queries = 0;
  const reader: FeedReadDatabase = {
    query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
      queries += 1;
      return responses.query<T>(sql, params, options);
    },
  };
  const duringDrain = Promise.withResolvers<void>();
  const afterReconnect = Promise.withResolvers<void>();
  const deliver = async (item: FeedResponse): Promise<"delivered"> => {
    unwrap(await effects.execute("INSERT INTO drafts VALUES (?)", [item.responseId]));
    if (item.responseId === "response-before-ready") {
      unwrap(await appendFeedResponse(output, responses, answer("response-during-drain")));
      transport.wake();
    }
    if (item.responseId === "response-during-drain") duringDrain.resolve();
    if (item.responseId === "response-missed-wakeup") afterReconnect.resolve();
    return "delivered";
  };
  const listening = listenFeedResponses({
    responses: reader, handoff, recipient: "runtime-one", hooks: transport.hooks,
    subscription: { space: "owner-space", service: "sql", pathPrefix: "app/feed_responses_agentone" },
    deliver, signal: abort.signal,
  });
  try {
    await transport.opened;
    expect(queries).toBe(0);
    transport.ready();
    await duringDrain.promise;
    expect(unwrap(await effects.query("SELECT response_id FROM drafts ORDER BY rowid")).rows).toEqual([
      ["response-before-ready"], ["response-during-drain"],
    ]);

    unwrap(await appendFeedResponse(output, responses, answer("response-missed-wakeup")));
    transport.ready(); // Same callback on reconnected/renewed subscription.
    await afterReconnect.promise;
    expect(unwrap(await effects.query("SELECT response_id FROM drafts ORDER BY rowid")).rows).toEqual([
      ["response-before-ready"], ["response-during-drain"], ["response-missed-wakeup"],
    ]);
  } finally {
    abort.abort();
    await listening;
  }
  expect(unwrap(await getFeedHandoff(handoff, "response-missed-wakeup", "runtime-one"))?.state)
    .toBe("delivered");
});
