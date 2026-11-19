import { afterEach, expect, test } from "bun:test";
import { HooksService } from "./HooksService";
import type { IServiceContext, FetchResponse } from "../types";
import type { SubscribeOptions } from "./types";
import {
  appendFeedResponse, getFeedHandoff, initializeFeedDatabases, listenFeedResponses, publishFeedCard,
} from "../feed";
import { sqliteHandle, unwrap } from "../feed/sqlite.test-helper";
import type { FeedReadDatabase } from "../feed";
import type { QueryOptions, SqlValue } from "../sql/types";

const services: HooksService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.onSignOut(); });
const subscription = [{ space: "owner-space", service: "sql" as const, pathPrefix: "app/feed/feed_responses_one" }];
const write = (id: string) => `event: write\ndata: ${JSON.stringify({
  type: "write", id, space: "owner-space", service: "sql", ability: "tinycloud.sql/write",
  path: "app/feed/feed_responses_one", actor: "owner", epoch: "e", eventIndex: 1, timestamp: "t",
})}\n\n`;
const ready = 'event: ready\ndata: {"type":"ready"}\n\n';
const encoder = new TextEncoder();

function serviceFor(open: (signal?: AbortSignal) => Response | Promise<Response>) {
  const service = new HooksService({ streamRetry: { delay: () => 0, wait: async () => undefined } });
  service.initialize({
    session: { delegationHeader: { Authorization: "test" }, delegationCid: "c", spaceId: "owner-space", verificationMethod: "did:key:test", jwk: {} },
    isAuthenticated: true, invoke: () => ({ Authorization: "test" }), hosts: ["https://node.test"],
    fetch: async (url, init) => (url.includes("/hooks/tickets")
      ? Response.json({ ticket: "test-ticket" }) : await open(init?.signal)) as FetchResponse,
    getService: () => undefined, emit: () => undefined, on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
  } as IServiceContext);
  services.push(service);
  return service;
}

// The intersection lets this regression run before SubscribeOptions gains onReady.
function options(onReady: () => void): SubscribeOptions & { onReady: () => void } {
  return { onReady };
}

test("server readiness precedes the first write and is never yielded as a write", async () => {
  const order: string[] = [];
  const service = serviceFor(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(ready + ready + write("real-write"))); },
  })));
  const iterator = service.subscribe(subscription, options(() => order.push("ready")))[Symbol.asyncIterator]();
  const event = await iterator.next();
  order.push(event.value.id);
  expect(order).toEqual(["ready", "real-write"]);
  await iterator.return?.();
});

test("a late subscriber on the same ready stream gets readiness without another HTTP open", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let opens = 0;
  const readyCalls: string[] = [];
  const service = serviceFor(() => {
    opens += 1;
    return new Response(new ReadableStream({ start(value) { controller = value; controller.enqueue(encoder.encode(ready + write("first"))); } }));
  });
  const first = service.subscribe(subscription, options(() => readyCalls.push("first")))[Symbol.asyncIterator]();
  expect((await first.next()).value.id).toBe("first");
  const second = service.subscribe(subscription, options(() => readyCalls.push("second")))[Symbol.asyncIterator]();
  const pending = second.next();
  controller.enqueue(encoder.encode(write("second")));
  expect((await pending).value.id).toBe("second");
  expect(readyCalls).toEqual(["first", "second"]);
  expect(opens).toBe(1);
  await second.return?.();
  await first.return?.();
});

test("a reopened stream schedules readiness again before its new write", async () => {
  let opens = 0;
  const order: string[] = [];
  const service = serviceFor(() => new Response(new ReadableStream({
    start(controller) {
      opens += 1;
      controller.enqueue(encoder.encode(ready + write(`write-${opens}`)));
      if (opens === 1) controller.close();
    },
  })));
  const iterator = service.subscribe(subscription, options(() => order.push("ready")))[Symbol.asyncIterator]();
  order.push((await iterator.next()).value.id);
  order.push((await iterator.next()).value.id);
  expect(order).toEqual(["ready", "write-1", "ready", "write-2"]);
  await iterator.return?.();
});

function databaseWrite(id: string, service: "sql" | "duckdb", databasePath: string, path = "db/p6170702f66656564/table/726573706f6e736573") {
  return `event: write\ndata: ${JSON.stringify({
    type: "write", id, space: "owner-space", service, databasePath, path,
    ability: `tinycloud.${service}/write`, actor: "owner", epoch: "e", eventIndex: 1, timestamp: "t",
  })}\n\n`;
}

for (const databaseService of ["sql", "duckdb"] as const) {
  test(`${databaseService} encoded table events use logical database identity and exact database scopes`, async () => {
    const databasePath = "app/feed/feed_responses_one";
    const service = serviceFor(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ready +
          databaseWrite("wrong-descendant", databaseService, `${databasePath}/other`, `${databasePath}/other`) +
          databaseWrite("matching-database", databaseService, databasePath) +
          databaseWrite("legacy-sentinel", databaseService, databasePath, databasePath)));
      },
    })));
    const iterator = service.subscribe([{ space: "owner-space", service: databaseService, pathPrefix: databasePath }])[Symbol.asyncIterator]();
    const event = (await iterator.next()).value;
    expect(event).toMatchObject({
      id: "matching-database", databasePath, path: "db/p6170702f66656564/table/726573706f6e736573",
    });
    await iterator.return?.();
  });

  test(`${databaseService} trailing-slash namespace scope covers logical child databases without adjacent prefixes`, async () => {
    const service = serviceFor(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ready +
          databaseWrite("wrong-prefix", databaseService, "app/feed-other/responses") +
          databaseWrite("namespace-child", databaseService, "app/feed/feed_responses_one") +
          databaseWrite("legacy-sentinel", databaseService, "app/feed/feed_responses_one", "app/feed/feed_responses_one")));
      },
    })));
    const iterator = service.subscribe([{ space: "owner-space", service: databaseService, pathPrefix: "app/feed/" }])[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ id: "namespace-child", databasePath: "app/feed/feed_responses_one" });
    await iterator.return?.();
  });
  for (const pathPrefix of ["/app/feed/feed_responses_one", "/app/feed/"]) {
    test(`${databaseService} leading-slash scope ${pathPrefix} receives canonical database events`, async () => {
      const service = serviceFor(() => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ready + databaseWrite(
            "canonical-database", databaseService, "app/feed/feed_responses_one",
          )));
        },
      })));
      const iterator = service.subscribe([{ space: "owner-space", service: databaseService, pathPrefix }])[Symbol.asyncIterator]();
      try {
        expect((await iterator.next()).value).toMatchObject({
          id: "canonical-database", databasePath: "app/feed/feed_responses_one",
        });
      } finally { await iterator.return?.(); }
    });
  }
}

test("a Node-shaped encoded SQL write wakes the feed after its initial ready drain, without renewal", async () => {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  const handoff = sqliteHandle();
  const effects = sqliteHandle();
  const initialDrain = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const abort = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const service = serviceFor(() => new Response(new ReadableStream({
    start(value) { controller = value; controller.enqueue(encoder.encode(ready)); },
  })));
  unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  unwrap(await effects.handle.execute("CREATE TABLE drafts (response_id TEXT NOT NULL)"));
  const card = {
    cardId: "card-node-shaped-wake", revision: 1, issuanceId: "issuance-node-shaped-wake",
    kind: "decision", needsResponse: true, title: "Draft", body: "Draft only", urgency: 1, createdAt: "t",
  };
  unwrap(await publishFeedCard(output.handle, card));
  const reader: FeedReadDatabase = {
    query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
      const result = await responses.handle.query<T>(sql, params, options);
      if (result.ok && result.data.rowCount === 0) initialDrain.resolve();
      return result;
    },
  };
  const listening = listenFeedResponses({
    responses: reader, handoff: handoff.handle, recipient: "real-wire-runtime", hooks: service,
    subscription: subscription[0], signal: abort.signal,
    deliver: async (response) => {
      unwrap(await effects.handle.execute("INSERT INTO drafts VALUES (?)", [response.responseId]));
      delivered.resolve();
      return "delivered";
    },
  });
  try {
    await initialDrain.promise;
    unwrap(await appendFeedResponse(output.handle, responses.handle, {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: "response-node-shaped-wake", kind: "answer", text: "Create draft", createdAt: "t",
    }));
    controller.enqueue(encoder.encode(databaseWrite("write-wakeup", "sql", "app/feed/feed_responses_one")));
    await delivered.promise;
    expect(unwrap(await effects.handle.query("SELECT response_id FROM drafts")).rows).toEqual([["response-node-shaped-wake"]]);
  } finally {
    abort.abort();
    await listening;
    expect(await getFeedHandoff(handoff.handle, "response-node-shaped-wake", "real-wire-runtime"))
      .toMatchObject({ ok: true, data: { state: "delivered" } });
    effects.close(); handoff.close(); responses.close(); output.close();
  }
});

test("database root scope accepts logical databases while KV keeps its existing subtree matching", async () => {
  const rootService = serviceFor(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(ready + databaseWrite("root-write", "sql", "different/database"))); },
  })));
  const root = rootService.subscribe([{ space: "owner-space", service: "sql", pathPrefix: "/" }])[Symbol.asyncIterator]();
  expect((await root.next()).value).toMatchObject({ id: "root-write", databasePath: "different/database" });
  await root.return?.();

  const kvService = serviceFor(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(ready + `event: write\ndata: ${JSON.stringify({
        type: "write", id: "kv-child", space: "owner-space", service: "kv", ability: "tinycloud.kv/put",
        path: "folder/child", actor: "owner", epoch: "e", eventIndex: 1, timestamp: "t",
      })}\n\n`));
    },
  })));
  const kv = kvService.subscribe([{ space: "owner-space", service: "kv", pathPrefix: "folder" }])[Symbol.asyncIterator]();
  expect((await kv.next()).value).toMatchObject({ id: "kv-child", path: "folder/child" });
  await kv.return?.();
});
