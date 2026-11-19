import { afterEach, expect, test } from "bun:test";
import { appendFeedResponse, initializeFeedDatabases, initializeFeedHandoff, listenFeedResponses, publishFeedCard } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHooks } from "./types";
import type { HookEvent } from "../hooks/types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const database = () => { const fixture = sqliteHandle(); cleanup.push(fixture.close); return fixture.handle; };

function transport() {
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
      try { for await (const event of stream) yield event; } finally { options?.signal?.removeEventListener("abort", close); }
    },
  };
  return {
    hooks, opened: opened.promise, ready: () => ready?.(),
    // The owner's write of card.md into the response database: a wake that carries no response.
    wake: () => controller.enqueue({
      type: "write", id: "card-md-write", space: "owner-space", service: "sql", ability: "tinycloud.sql/write",
      path: "app/feed_responses_agentone", actor: "owner", epoch: "epoch", eventIndex: 1, timestamp: "2026-11-19T01:00:00.000Z",
    }),
  };
}

const card: FeedCard = {
  cardId: "card-on-wake", revision: 1, issuanceId: "issuance-on-wake",
  kind: "decision", needsResponse: true, title: "Draft", body: "Create draft only", urgency: 1, createdAt: "2026-11-19T01:00:00.000Z",
};

test("a wake that carries no response runs onWake, delivers nothing, and a throwing onWake never stops the next delivery", async () => {
  const output = database();
  const responses = database();
  const handoff = database();
  unwrap(await initializeFeedDatabases({ output, responses }));
  unwrap(await initializeFeedHandoff(handoff));
  unwrap(await publishFeedCard(output, card));
  const hooks = transport();
  const abort = new AbortController();
  const delivered: string[] = [];
  const woken = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let wakes = 0;
  const delivery = Promise.withResolvers<void>();
  const listening = listenFeedResponses({
    responses, handoff, recipient: "runtime-one", hooks: hooks.hooks,
    subscription: { space: "owner-space", service: "sql", pathPrefix: "app/feed_responses_agentone" },
    onWake: async () => { woken[wakes++]?.resolve(); throw new Error("card.md could not be read"); },
    deliver: async (item) => { delivered.push(item.responseId); delivery.resolve(); return "delivered"; },
    signal: abort.signal,
  });
  try {
    await hooks.opened;
    hooks.ready();
    await woken[0].promise;
    hooks.wake();
    await woken[1].promise;
    expect(delivered).toEqual([]);
    unwrap(await appendFeedResponse(output, responses, {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: "after-card-md", kind: "followup", text: "after", createdAt: card.createdAt,
    }));
    hooks.wake();
    await delivery.promise;
    expect(delivered).toEqual(["after-card-md"]);
  } finally {
    abort.abort();
    await listening;
  }
});
