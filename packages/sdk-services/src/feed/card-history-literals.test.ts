import { expect, test } from "bun:test";
import { initializeFeedDatabases, listFeedCardHistory, listFeedCards, publishFeedCard } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard } from "./types";

test("published history preserves literal own payload keys without prototype mutation", async () => {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  try {
    unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
    const payload: Record<string, unknown> = JSON.parse('{"__proto__":{"opaque":"retain"},"constructor":{"literal":true},"thread":{"entries":["immutable context"]}}');
    const card: FeedCard = {
      cardId: "literal-payload-card", revision: 1, issuanceId: "literal-payload-issuance",
      kind: "information", needsResponse: false, title: "Literal payload preservation",
      body: "Opaque output fields survive validated history reads.", urgency: 0,
      createdAt: "2026-10-29T12:00:00.000Z", payload,
    };
    expect(unwrap(await publishFeedCard(output.handle, card))).toEqual(card);
    expect(unwrap(await listFeedCards({ query: output.handle.query }))).toEqual([card]);
    const page = unwrap(await listFeedCardHistory({ query: output.handle.query }));
    expect(Object.getOwnPropertyDescriptor(page.cards[0]?.payload, "__proto__")).toEqual({
      value: { opaque: "retain" }, enumerable: true, configurable: true, writable: true,
    });
    expect(page.cards).toEqual([card]);
    expect(Object.getPrototypeOf(page.cards[0]?.payload)).toBe(Object.prototype);
    expect(page.nextIdentity).toEqual({ cardId: card.cardId, revision: 1, issuanceId: card.issuanceId });
    expect(page.hasMore).toBe(false);
  } finally {
    output.close();
    responses.close();
  }
});
