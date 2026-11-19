import { afterEach, expect, test } from "bun:test";
import * as feed from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHandling, NewFeedResponse } from "./types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const card: FeedCard = {
  cardId: "card-handling-history", revision: 4, issuanceId: "issuance-handling-history",
  kind: "decision", needsResponse: true, title: "Create draft?", body: "A reversible draft only.",
  urgency: 1, createdAt: "2026-10-29T12:00:00Z",
};
const answer: NewFeedResponse = {
  cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
  responseId: "response-handling-history-first", kind: "answer", text: "Create the draft.", createdAt: card.createdAt,
};
async function databases() {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  unwrap(await feed.publishFeedCard(output.handle, card));
  return { output: output.handle, responses: responses.handle };
}

test("the full response identity retrieves its original handling after later answers and notes", async () => {
  const { output, responses } = await databases();
  unwrap(await feed.appendFeedResponse(output, responses, answer));
  const acknowledgement: FeedHandling = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: answer.responseId, handlingId: "handling-history-ack-first",
    phase: "acknowledged", createdAt: card.createdAt,
  };
  const outcome: FeedHandling = {
    ...acknowledgement, handlingId: "handling-history-success-first", phase: "succeeded", detail: { draftId: "original-draft" },
  };
  unwrap(await feed.recordFeedHandling(output, acknowledgement));
  unwrap(await feed.recordFeedHandling(output, outcome));
  const later = { ...answer, responseId: "response-handling-history-later", kind: "followup" as const, text: "A later answer." };
  unwrap(await feed.appendFeedResponse(output, responses, later));
  const laterAck: FeedHandling = { ...acknowledgement, responseId: later.responseId, handlingId: "handling-history-ack-later" };
  unwrap(await feed.recordFeedHandling(output, laterAck));
  const note = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-handling-history-message", kind: "message",
    text: "What happened to the first draft?", createdAt: card.createdAt,
  };
  // A stored message fixture exercises history independently of the not-yet-added message API.
  unwrap(await responses.execute(
    "INSERT INTO feed_responses (response_id, card_id, revision, issuance_id, response_json) VALUES (?, ?, ?, ?, ?)",
    [note.responseId, card.cardId, card.revision, card.issuanceId, JSON.stringify(note)],
  ));
  expect(unwrap(await feed.readFeedResponseHandling(output, answer))).toEqual({ acknowledgement, outcome });
  expect(unwrap(await feed.readFeedResponseHandling(output, later))).toEqual({ acknowledgement: laterAck, outcome: null });
});

test("handling reads distinguish unknown or mismatched identity from a known partial history", async () => {
  const { output, responses } = await databases();
  unwrap(await feed.appendFeedResponse(output, responses, answer));
  const outcome: FeedHandling = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: answer.responseId, handlingId: "handling-history-outcome-only", phase: "failed",
    createdAt: card.createdAt, detail: { reason: "Runtime refused the draft." },
  };
  unwrap(await feed.recordFeedHandling(output, outcome));
  expect(unwrap(await feed.readFeedResponseHandling(output, answer))).toEqual({ acknowledgement: null, outcome });
  for (const identity of [
    { ...answer, responseId: "response-without-known-history" },
    { ...answer, cardId: "different-card" },
    { ...answer, revision: card.revision + 1 },
    { ...answer, issuanceId: "different-issuance" },
  ]) {
    expect((await feed.readFeedResponseHandling(output, identity)).ok).toBe(false);
  }
  expect(unwrap(await feed.getFeedCardState(output, responses, card))).toMatchObject({
    response: { responseId: answer.responseId }, acknowledgement: null, outcome,
  });
});
