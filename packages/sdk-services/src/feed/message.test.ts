import { afterEach, expect, test } from "bun:test";
import * as feed from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedDatabase, FeedHandling, NewFeedMessage, NewFeedResponse } from "./types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const card: FeedCard = {
  cardId: "card-message-isolation", revision: 2, issuanceId: "issuance-message-isolation",
  kind: "decision", needsResponse: true, title: "Create draft?", body: "Create only a reversible draft.",
  choices: [{ id: "create", label: "Create draft" }], urgency: 1, createdAt: "2026-10-29T12:00:00Z",
};
const message: NewFeedMessage = {
  cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
  responseId: "response-message-only", kind: "message", text: "Please explain the draft before I answer.",
  createdAt: "2026-10-29T12:01:00Z",
};
async function databases(overrides: Partial<FeedCard> = {}) {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  const published = { ...card, ...overrides };
  unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  unwrap(await feed.publishFeedCard(output.handle, published));
  return { output: output.handle, responses: responses.handle, published };
}
async function seedMessage(responses: FeedDatabase) {
  // Stored protocol fixture makes the existing answer projection fail behaviorally
  // before the separate append-message API exists; no production fallback is supplied.
  unwrap(await responses.execute(
    "INSERT INTO feed_responses (response_id, card_id, revision, issuance_id, response_json) VALUES (?, ?, ?, ?, ?)",
    [message.responseId, message.cardId, message.revision, message.issuanceId, JSON.stringify(message)],
  ));
}

test("a message on an unanswered actionable card cannot become its answer or clear Needs action", async () => {
  const { output, responses, published } = await databases();
  await seedMessage(responses);
  expect(await feed.getFeedCardState(output, responses, card)).toEqual({
    ok: true, data: { card: published, response: null, acknowledgement: null, outcome: null },
  });
  expect(published.needsResponse).toBe(true);
});

test("a newer message cannot replace an existing answer, acknowledgement, or terminal outcome", async () => {
  const { output, responses } = await databases();
  const answer: NewFeedResponse = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-real-answer", kind: "answer", choiceId: "create", createdAt: card.createdAt,
  };
  const saved = unwrap(await feed.appendFeedResponse(output, responses, answer));
  const acknowledgement: FeedHandling = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: answer.responseId, handlingId: "handling-real-answer-ack", phase: "acknowledged", createdAt: card.createdAt,
  };
  const outcome: FeedHandling = { ...acknowledgement, handlingId: "handling-real-answer-success", phase: "succeeded", detail: { draftId: "draft-one" } };
  unwrap(await feed.recordFeedHandling(output, acknowledgement));
  unwrap(await feed.recordFeedHandling(output, outcome));
  await seedMessage(responses);
  expect(await feed.getFeedCardState(output, responses, card)).toEqual({
    ok: true, data: { card, response: saved, acknowledgement, outcome },
  });
  expect(unwrap(await feed.listFeedResponses(responses)).map((item) => [item.responseId, item.kind]))
    .toEqual([[answer.responseId, "answer"], [message.responseId, "message"]]);
});

test("messages can be sent for information cards without changing their needsResponse flag", async () => {
  const { output, responses, published } = await databases({ kind: "information", needsResponse: false });
  const saved = unwrap(await feed.appendFeedMessage(output, responses, message));
  expect(saved).toMatchObject({ ...message, kind: "message" });
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([saved]);
  expect(unwrap(await feed.getFeedCardState(output, responses, card))).toEqual({
    card: published, response: null, acknowledgement: null, outcome: null,
  });
});

test("message identity replays require the same header and private payload, without answering the card", async () => {
  const { output, responses } = await databases();
  const marker = "SYNTHETIC-MESSAGE-PRIVATE-CODE-99";
  const payload = { type: "test.private-message", version: 1, data: { code: marker } };
  const first = unwrap(await feed.appendFeedMessage(output, responses, message, payload));
  expect(unwrap(await feed.appendFeedMessage(output, responses, message, payload))).toEqual(first);
  for (const result of [
    await feed.appendFeedMessage(output, responses, { ...message, text: "Changed message" }, payload),
    await feed.appendFeedMessage(output, responses, message, { ...payload, data: { code: "OTHER-SYNTHETIC" } }),
    await feed.appendFeedMessage(output, responses, message),
    await feed.appendFeedResponse(output, responses, { ...message, kind: "answer" }),
  ]) expect(result.ok).toBe(false);
  expect(unwrap(await feed.readFeedResponsePayload(responses, message))).toEqual(payload);
  expect(JSON.stringify(unwrap(await feed.listFeedResponses(responses)))).not.toContain(marker);
  expect(unwrap(await feed.getFeedCardState(output, responses, card)).response).toBeNull();
  const plain = { ...message, responseId: "response-message-plain" };
  unwrap(await feed.appendFeedMessage(output, responses, plain));
  expect((await feed.appendFeedMessage(output, responses, plain, payload)).ok).toBe(false);
});

test("message admission rejects decision choices, answer supersession, unknown issuances, and the answer API", async () => {
  const { output, responses } = await databases();
  const withChoice = { ...message, choiceId: "create" };
  const withSupersedes = { ...message, supersedesResponseId: "some-answer" };
  for (const input of [
    withChoice, withSupersedes,
    { ...message, cardId: "unknown-card" },
    { ...message, revision: card.revision + 1 },
    { ...message, issuanceId: "unknown-issuance" },
  ]) expect((await feed.appendFeedMessage(output, responses, input)).ok).toBe(false);
  // Deliberately invalid untyped-JS admission: the answer API must not broaden to messages.
  expect((await feed.appendFeedResponse(output, responses, message as unknown as NewFeedResponse)).ok).toBe(false);
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([]);
});

test("a message payload write failure rolls back its header and preserves retry identity", async () => {
  const { output, responses } = await databases({ kind: "information", needsResponse: false });
  const marker = "SYNTHETIC-MESSAGE-ROLLBACK-CODE";
  const payload = { type: "test.private-message", version: 1, data: { code: marker } };
  unwrap(await responses.execute(`CREATE TRIGGER fail_message_payload BEFORE INSERT ON feed_response_payloads
    BEGIN SELECT RAISE(ABORT, '${marker}'); END`));
  const failed = await feed.appendFeedMessage(output, responses, message, payload);
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(marker);
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([]);
  unwrap(await responses.execute("DROP TRIGGER fail_message_payload"));
  const retried = unwrap(await feed.appendFeedMessage(output, responses, message, payload));
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([retried]);
  expect(unwrap(await feed.readFeedResponsePayload(responses, message))).toEqual(payload);
});

test("message notifications cannot acquire decision fields or private payload fields", () => {
  const notification = { ...message, sequence: 7, payloadType: "test.private-message", payloadVersion: 1 };
  const polluted = {
    ...notification, choiceId: "create", supersedesResponseId: "response-answer",
    payload: { data: { code: "SYNTHETIC-MESSAGE-PROJECTION-CODE" } },
  };
  expect(feed.projectFeedResponseNotification(polluted)).toEqual(notification);
});
