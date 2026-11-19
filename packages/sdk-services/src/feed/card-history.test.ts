import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { ErrorCodes } from "../types";
import type { FetchFunction, Result } from "../types";
import * as feed from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedCardIdentity, FeedReadDatabase } from "./types";
import type { FeedCardHistoryPage } from "./history-types";

// The public export is intentionally absent at this test-only checkpoint.
// The cast defines its agreed contract without supplying a fake implementation.
const { listFeedCardHistory } = feed as typeof feed & {
  listFeedCardHistory(
    output: FeedReadDatabase,
    options?: { afterIdentity?: FeedCardIdentity; limit?: number; signal?: AbortSignal },
  ): Promise<Result<FeedCardHistoryPage>>;
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const marker = "SYNTHETIC-CARD-HISTORY-DIAGNOSTIC-36";

function card(cardId: string, revision = 1, issuanceId = "issuance"): FeedCard {
  return {
    cardId, revision, issuanceId, kind: "information", needsResponse: false,
    title: `Thread ${cardId}`, body: `Issuance ${issuanceId}`, urgency: 1,
    createdAt: "2026-10-29T12:00:00Z",
  };
}
function identity(value: FeedCard): FeedCardIdentity {
  return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId };
}
async function fixture(cards: FeedCard[] = []) {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  for (const value of cards) unwrap(await feed.publishFeedCard(output.handle, value));
  // Consumers only need the existing read capability, not schema or write methods.
  const reader: FeedReadDatabase = { query: output.handle.query };
  return { output: output.handle, reader };
}

test("latest-card listing still returns only the last published issuance for each card", async () => {
  const old = { ...card("thread-one", 1, "original"), payload: { thread: { version: 1, entries: ["original entry"] } } };
  const firstReissue = card("thread-one", 2, "reissue-A");
  const lastReissue = card("thread-one", 2, "reissue-B");
  const other = card("thread-two");
  const f = await fixture([old, firstReissue, other, lastReissue]);
  expect(unwrap(await feed.listFeedCards(f.reader))).toEqual([lastReissue, other]);
});

test("history retains the complete original thread envelope after revision and same-revision reissuance", async () => {
  const old: FeedCard = {
    ...card("thread-one", 1, "original"),
    payload: {
      thread: { version: 1, threadId: "thread-full-id", entries: [{ eventId: "event-original", text: "Original thread context" }] },
      opaque: { nested: [null, true, { value: "unchanged" }] },
    },
  };
  const firstReissue = { ...card("thread-one", 2, "reissue-A"), payload: { thread: { version: 2, entries: ["revised context"] } } };
  const lastReissue = { ...card("thread-one", 2, "reissue-B"), payload: { thread: { version: 2, entries: ["later context"] } } };
  const f = await fixture([old, firstReissue, lastReissue]);
  expect(unwrap(await listFeedCardHistory(f.reader))).toEqual({
    cards: [old, firstReissue, lastReissue], nextIdentity: identity(lastReissue), hasMore: false,
  });
});

test("BINARY full-tuple keyset pages preserve opaque Unicode keys and every issuance exactly once", async () => {
  // Explicit UTF-8/BINARY order: U+E000 precedes U+10000, unlike JS UTF-16 sorting.
  const expected = [
    card("A"), card("a"), card("e\u0301"),
    card("same", 1, "A"), card("same", 1, "a"), card("same", 1, "é"),
    card("same", 1, "\uE000"), card("same", 1, "\u{10000}"),
    card("same", 2), card("same", 10), card("é"), card("\uE000"), card("\u{10000}"),
  ];
  const f = await fixture([...expected].reverse());
  const collected: FeedCard[] = [];
  let afterIdentity: FeedCardIdentity | undefined;
  for (let offset = 0; offset < expected.length; offset += 3) {
    const cards = expected.slice(offset, offset + 3);
    const page = unwrap(await listFeedCardHistory(f.reader, { afterIdentity, limit: 3 }));
    expect(page).toEqual({
      cards, nextIdentity: identity(cards[cards.length - 1]), hasMore: offset + 3 < expected.length,
    });
    collected.push(...page.cards);
    afterIdentity = page.nextIdentity!;
  }
  expect(collected).toEqual(expected);
  expect(unwrap(await listFeedCardHistory(f.reader, { afterIdentity, limit: 3 }))).toEqual({
    cards: [], nextIdentity: null, hasMore: false,
  });
});

test("default 100 and maximum 1000 pages expose the exact boundary and continuation cards", async () => {
  const expected = Array.from({ length: 1001 }, (_, index) => card(`card-${String(index).padStart(4, "0")}`));
  const f = await fixture([...expected].reverse());
  expect(unwrap(await listFeedCardHistory(f.reader))).toEqual({
    cards: expected.slice(0, 100), nextIdentity: identity(expected[99]), hasMore: true,
  });
  const maximum = unwrap(await listFeedCardHistory(f.reader, { limit: 1000 }));
  expect(maximum).toEqual({
    cards: expected.slice(0, 1000), nextIdentity: identity(expected[999]), hasMore: true,
  });
  expect(unwrap(await listFeedCardHistory(f.reader, { afterIdentity: maximum.nextIdentity!, limit: 1000 }))).toEqual({
    cards: [expected[1000]], nextIdentity: identity(expected[1000]), hasMore: false,
  });
});

test("an empty snapshot has no continuation identity", async () => {
  const f = await fixture();
  expect(unwrap(await listFeedCardHistory(f.reader))).toEqual({ cards: [], nextIdentity: null, hasMore: false });
});

test("a valid cursor need not name a currently stored row to define an exclusive tuple boundary", async () => {
  const before = card("thread", 1, "A");
  const after = card("thread", 1, "Z");
  const nextRevision = card("thread", 2, "A");
  const f = await fixture([nextRevision, after, before]);
  expect(unwrap(await listFeedCardHistory(f.reader, {
    afterIdentity: { cardId: "thread", revision: 1, issuanceId: "M" }, limit: 2,
  }))).toEqual({ cards: [after, nextRevision], nextIdentity: identity(nextRevision), hasMore: false });
});

test("a keyset cursor is not a durable tail and full reconciliation recovers lexically earlier arrivals", async () => {
  const middle = card("middle");
  const last = card("z-last");
  const f = await fixture([last, middle]);
  const first = unwrap(await listFeedCardHistory(f.reader, { limit: 1 }));
  expect(first).toEqual({ cards: [middle], nextIdentity: identity(middle), hasMore: true });
  const earlier = card("a-new-arrival");
  unwrap(await feed.publishFeedCard(f.output, earlier));
  expect(unwrap(await listFeedCardHistory(f.reader, { afterIdentity: first.nextIdentity!, limit: 1 }))).toEqual({
    cards: [last], nextIdentity: identity(last), hasMore: false,
  });
  expect(unwrap(await listFeedCardHistory(f.reader))).toEqual({
    cards: [earlier, middle, last], nextIdentity: identity(last), hasMore: false,
  });
});

test("invalid page limits fail as caller input rather than silently truncating or coercing", async () => {
  const f = await fixture([card("valid")]);
  for (const limit of [0, -1, 1.5, 1001, NaN, Infinity]) {
    expect(await listFeedCardHistory(f.reader, { limit })).toMatchObject({ ok: false, error: { code: ErrorCodes.INVALID_INPUT } });
  }
});

test("a cursor requires nonempty full IDs and a positive safe integer revision", async () => {
  const f = await fixture([card("valid")]);
  const cursors: unknown[] = [
    null, {}, { cardId: "valid", revision: 1 },
    { cardId: "", revision: 1, issuanceId: "issuance" },
    { cardId: "valid", revision: 1, issuanceId: "" },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map((revision) => ({ cardId: "valid", revision, issuanceId: "issuance" })),
  ];
  for (const afterIdentity of cursors) {
    expect(await listFeedCardHistory(f.reader, { afterIdentity: afterIdentity as FeedCardIdentity })).toMatchObject({
      ok: false, error: { code: ErrorCodes.INVALID_INPUT },
    });
  }
});

test("stored JSON must match every full primary-key identity field without leaking corrupt content", async () => {
  const original = card("stored-card", 2, "stored-issuance");
  for (const patch of [{ cardId: "different-card" }, { revision: 3 }, { issuanceId: "different-issuance" }]) {
    const f = await fixture([original]);
    unwrap(await f.output.execute("UPDATE feed_cards SET card_json = ?", [JSON.stringify({ ...original, ...patch, body: marker })]));
    const result = await listFeedCardHistory(f.reader);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
    expect(inspect(result, { depth: 20 })).not.toContain(marker);
  }
});

test("malformed JSON and invalid card envelopes reject the whole page with safe errors", async () => {
  for (const encoded of [`{\"body\":\"${marker}\"`, JSON.stringify({ ...card("bad"), payload: marker })]) {
    const f = await fixture([card("a-good"), card("bad")]);
    unwrap(await f.output.execute("UPDATE feed_cards SET card_json = ? WHERE card_id = ?", [encoded, "bad"]));
    const result = await listFeedCardHistory(f.reader);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
    expect(inspect(result, { depth: 20 })).not.toContain(marker);
  }
});

type HttpMode = "pending" | "late-success" | "error" | "late-error";
async function httpFixture(mode: HttpMode) {
  const f = await fixture([card("network-card")]);
  if (mode === "error" || mode === "late-error") unwrap(await f.output.execute("DROP TABLE feed_cards"));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      try {
        const body = await request.json();
        const result = unwrap(await f.output.query(body.sql, body.params));
        arrived.resolve();
        if (mode === "pending") await release.promise;
        return Response.json(result);
      } catch (error) {
        arrived.resolve();
        return Response.json({ error: `${marker}: ${String(error)}`, cause: { secret: marker } }, { status: 400 });
      }
    },
  });
  cleanup.push(async () => { abort.abort(); release.resolve(); await server.stop(true); });
  const detachedFetch: FetchFunction = async (url, options) => {
    const wire = await globalThis.fetch(url, { ...options, signal: undefined });
    const detached = new Response(await wire.arrayBuffer(), { status: wire.status, statusText: wire.statusText, headers: wire.headers });
    abort.abort();
    return detached;
  };
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "test-invocation" }), hosts: [server.url.href],
    fetch: mode.startsWith("late-") ? detachedFetch : undefined, retryPolicy: { maxAttempts: 1 },
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
  return { reader: service.db("feed_card_history"), abort, arrived: arrived.promise, ordinary };
}

test("aborting an actual pending history HTTP query settles without waiting for the server result", async () => {
  const f = await httpFixture("pending");
  const pending = listFeedCardHistory(f.reader, { signal: f.abort.signal });
  await f.arrived;
  f.abort.abort();
  expect(await pending).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
});

test("completed real history rows returned after caller abort do not become a successful page", async () => {
  const f = await httpFixture("late-success");
  const result = await listFeedCardHistory(f.reader, { signal: f.abort.signal });
  expect(f.abort.signal.aborted).toBe(true);
  expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
  expect(f.ordinary).toEqual([]);
});

for (const mode of ["error", "late-error"] as const) {
  test(`real history SQL failures preserve SQL_ERROR and private telemetry (${mode})`, async () => {
    const f = await httpFixture(mode);
    const result = await listFeedCardHistory(f.reader, { signal: f.abort.signal });
    expect(f.abort.signal.aborted).toBe(mode === "late-error");
    expect(f.ordinary).toEqual([expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
    })]);
    expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(marker);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
  });
}
