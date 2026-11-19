import { expect, test } from "bun:test";
import { initializeFeedDatabases, listFeedCards, restoreFeedRecords } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard } from "./types";

test("structural restore accepts and preserves literal own canonical payload keys", async () => {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  try {
    const pair = { output: output.handle, responses: responses.handle };
    unwrap(await initializeFeedDatabases(pair));
    const payload: Record<string, unknown> = JSON.parse('{"__proto__":{"opaque":"restore exactly"},"thread":{"entries":["original context"]}}');
    const card: FeedCard = {
      cardId: "restore-literal-card", revision: 1, issuanceId: "restore-literal-issuance",
      kind: "information", needsResponse: false, title: "Lossless canonical restore",
      body: "A valid literal key is not an extra header field.", urgency: 0,
      createdAt: "2026-10-29T12:00:00.000Z", payload,
    };
    expect(await restoreFeedRecords(pair, { cards: [card], responses: [] })).toEqual({ ok: true, data: undefined });
    expect(unwrap(await listFeedCards(pair.output))).toEqual([card]);
    expect(Object.getOwnPropertyDescriptor(unwrap(await listFeedCards(pair.output))[0]?.payload, "__proto__")?.value).toEqual({ opaque: "restore exactly" });
    expect(await restoreFeedRecords(pair, { cards: [card], responses: [] })).toEqual({ ok: true, data: undefined });
    expect(unwrap(await listFeedCards(pair.output))).toEqual([card]);
  } finally {
    output.close();
    responses.close();
  }
});

test("restoring a valid literal payload does not admit extra owner-only card envelope fields", async () => {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  try {
    const pair = { output: output.handle, responses: responses.handle };
    unwrap(await initializeFeedDatabases(pair));
    const card = {
      cardId: "private-extra-card", revision: 1, issuanceId: "private-extra-issuance",
      kind: "information", needsResponse: false, title: "Strict canonical envelope",
      body: "Extra owner-only fields must not reach the output.", urgency: 0,
      createdAt: "2026-10-29T12:00:00.000Z",
      payload: JSON.parse('{"__proto__":{"opaque":"retain"}}') as Record<string, unknown>,
      ownerOnlyState: { note: "SYNTHETIC-OWNER-ONLY-NOT-AN-OUTPUT-FIELD" },
    };
    expect((await restoreFeedRecords(pair, { cards: [card], responses: [] })).ok).toBe(false);
    expect(unwrap(await listFeedCards(pair.output))).toEqual([]);
  } finally {
    output.close();
    responses.close();
  }
});
