import { afterEach, expect, test } from "bun:test";
import * as feed from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHandling, NewFeedResponse } from "./types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const reply = (n: number) => ({ id: `reply-${n}`, text: `Reply ${n}` });
const base: FeedCard = {
  cardId: "card-reply-only", revision: 1, issuanceId: "issuance-1",
  kind: "decision", needsResponse: true, title: "Create draft?", body: "A reversible draft only.",
  urgency: 1, createdAt: "2026-10-29T12:00:00Z",
};
const revision = (n: number, patch: Partial<FeedCard> = {}): FeedCard =>
  ({ ...base, revision: n, issuanceId: `issuance-${n}`, createdAt: `2026-10-29T12:0${n}:00Z`, ...patch });
const withReplies = (n: number, replies: unknown[], payload: Record<string, unknown> = {}): FeedCard =>
  revision(n, { payload: { ...payload, replies } });

test("a revision that only appends replies is reply-only; any other change is not", () => {
  const one = withReplies(2, [reply(1)]);
  expect(feed.isReplyOnlyRevision(base, one)).toBe(true);
  expect(feed.isReplyOnlyRevision(one, withReplies(3, [reply(1), reply(2)]))).toBe(true);
  // Not an append: same count, fewer, rewritten earlier reply, or a reorder.
  expect(feed.isReplyOnlyRevision(one, withReplies(3, [reply(1)]))).toBe(false);
  expect(feed.isReplyOnlyRevision(withReplies(2, [reply(1), reply(2)]), withReplies(3, [reply(1)]))).toBe(false);
  expect(feed.isReplyOnlyRevision(one, withReplies(3, [{ ...reply(1), text: "Edited" }, reply(2)]))).toBe(false);
  expect(feed.isReplyOnlyRevision(withReplies(2, [reply(1), reply(2)]), withReplies(3, [reply(2), reply(1), reply(3)]))).toBe(false);
  // The card itself changed, or a payload key other than replies did.
  expect(feed.isReplyOnlyRevision(base, { ...one, title: "Create two drafts?" })).toBe(false);
  expect(feed.isReplyOnlyRevision(base, { ...one, choices: [{ id: "yes", label: "Yes" }] })).toBe(false);
  expect(feed.isReplyOnlyRevision(withReplies(2, [], { note: "a" }), withReplies(3, [reply(1)], { note: "b" }))).toBe(false);
  // Not later, or another card.
  expect(feed.isReplyOnlyRevision(one, { ...one, revision: 2 })).toBe(false);
  expect(feed.isReplyOnlyRevision(base, { ...one, cardId: "other-card" })).toBe(false);
});

test("the first reply may turn a post into a thread, and nothing else may change render", () => {
  const post = revision(1, { payload: { render: "post" } });
  expect(feed.isReplyOnlyRevision(post, withReplies(2, [reply(1)], { render: "thread" }))).toBe(true);
  expect(feed.isReplyOnlyRevision(base, withReplies(2, [reply(1)], { render: "thread" }))).toBe(true);
  // Not at the first reply, and not in the other direction.
  expect(feed.isReplyOnlyRevision(withReplies(2, [reply(1)], { render: "post" }), withReplies(3, [reply(1), reply(2)], { render: "thread" }))).toBe(false);
  expect(feed.isReplyOnlyRevision(withReplies(2, [reply(1)], { render: "thread" }), withReplies(3, [reply(1), reply(2)], { render: "post" }))).toBe(false);
});

async function ownerFeed(cards: FeedCard[]) {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  for (const card of cards) unwrap(await feed.publishFeedCard(output.handle, card));
  const answerAt = async (card: FeedCard) => {
    const answer: NewFeedResponse = {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: `answer-${card.revision}`, kind: "answer", text: `Answer at ${card.revision}`, createdAt: card.createdAt,
    };
    unwrap(await feed.appendFeedResponse(output.handle, responses.handle, answer));
    const ack: FeedHandling = {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: answer.responseId, handlingId: `ack-${card.revision}`, phase: "acknowledged", createdAt: card.createdAt,
    };
    const outcome: FeedHandling = { ...ack, handlingId: `done-${card.revision}`, phase: "succeeded" };
    unwrap(await feed.recordFeedHandling(output.handle, ack));
    unwrap(await feed.recordFeedHandling(output.handle, outcome));
    return { answer, ack, outcome };
  };
  const state = async (card: FeedCard, carry?: boolean) =>
    unwrap(await feed.getFeedCardState(output.handle, responses.handle, card, carry === undefined ? undefined : { carryReplyOnlyAnswer: carry }));
  return { answerAt, state };
}

test("show follows a reply-only revision back to the answer, acknowledgement and outcome, and says which revision", async () => {
  const r1 = base; const r2 = withReplies(2, [reply(1)]); const r3 = withReplies(3, [reply(1), reply(2)]);
  const { answerAt, state } = await ownerFeed([r1, r2, r3]);
  const saved = await answerAt(r1);

  // Default is unchanged: exactly this revision, which has no answer of its own.
  expect(await state(r2)).toMatchObject({ card: { revision: 2 }, response: null, acknowledgement: null, outcome: null });
  expect((await state(r2)).answeredAtRevision).toBeUndefined();

  for (const card of [r2, r3]) {
    const carried = await state(card, true);
    expect(carried.card.revision).toBe(card.revision);
    expect(carried.response).toMatchObject({ responseId: saved.answer.responseId, revision: 1, text: "Answer at 1" });
    expect(carried.acknowledgement).toEqual(saved.ack);
    expect(carried.outcome).toEqual(saved.outcome);
    expect(carried.answeredAtRevision).toBe(1);
  }
  // The answered revision itself never reports a carried answer.
  expect((await state(r1, true)).answeredAtRevision).toBeUndefined();
});

test("a revision that changes anything but replies does not inherit the earlier answer, and neither does anything after it", async () => {
  const r1 = base; const r2 = revision(2, { title: "Create two drafts?" });
  const r3 = { ...r2, revision: 3, issuanceId: "issuance-3", payload: { replies: [reply(1)] } };
  const { answerAt, state } = await ownerFeed([r1, r2, r3]);
  await answerAt(r1);
  expect(await state(r2, true)).toMatchObject({ response: null, acknowledgement: null, outcome: null });
  // r3 only added a reply to r2, but r2 was not answered and is not reply-only to r1.
  expect(await state(r3, true)).toMatchObject({ response: null });
});

test("an answer on the newer revision wins over a carried one, and an unanswered card stays unanswered", async () => {
  const r1 = base; const r2 = withReplies(2, [reply(1)]);
  const { answerAt, state } = await ownerFeed([r1, r2]);
  expect(await state(r2, true)).toMatchObject({ response: null });
  await answerAt(r1);
  const own = await answerAt(r2);
  const carried = await state(r2, true);
  expect(carried.response).toMatchObject({ responseId: own.answer.responseId, revision: 2 });
  expect(carried.answeredAtRevision).toBeUndefined();
});

// The cases of Home's own tests for this rule (tinychat `frontend/src/feed/cardKit.test.ts`), on cards. The two Home cases about a
// different source or agent have no equivalent here: the rule takes the cards of one agent's output database.
const homeCard = (revisionNumber: number, replies?: string[], change: Partial<FeedCard> = {}, payload: Record<string, unknown> = { render: "thread", source: { label: "S" } }): FeedCard => ({
  cardId: "card", revision: revisionNumber, issuanceId: `i${revisionNumber}`, kind: "ask", needsResponse: true, title: "T", body: "B", urgency: 1,
  createdAt: `2026-11-0${revisionNumber}T00:00:00Z`, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], ...change,
  payload: { ...payload, ...(replies ? { replies: replies.map((text) => ({ text })) } : {}) },
});
const renderOf = (card: FeedCard, render: string | undefined, revisionNumber = 2): FeedCard => {
  const { render: _render, ...rest } = card.payload ?? {};
  return { ...card, revision: revisionNumber, payload: { ...rest, ...(render ? { render } : {}) } };
};

test("Home's reply-only cases: appends in any amount, even across skipped revisions", () => {
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"]))).toBe(true);
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one"]), homeCard(2, ["one", "two", "three"]))).toBe(true);
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one"]), homeCard(4, ["one", "two"]))).toBe(true);
});

test("Home's not-reply-only cases", () => {
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one", "two"]), homeCard(2, ["one!", "two", "three"]))).toBe(false); // edited earlier reply
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one", "two"]), homeCard(2, ["two", "three"]))).toBe(false); // removed reply
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one", "two"]), homeCard(2, ["two", "one", "three"]))).toBe(false); // reordered
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one"]), homeCard(2))).toBe(false); // replies missing from the next one
  expect(feed.isReplyOnlyRevision(homeCard(1, ["one"]), homeCard(2, ["one"]))).toBe(false); // nothing appended
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"], { body: "Changed" }))).toBe(false); // body change
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"], { choices: [{ id: "a", label: "A2" }, { id: "b", label: "B" }] }))).toBe(false); // choice label
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"], { choices: [{ id: "b", label: "B" }, { id: "a", label: "A" }] }))).toBe(false); // choice order
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"], { cardId: "other" }))).toBe(false); // different card
  expect(feed.isReplyOnlyRevision(homeCard(2), homeCard(2, ["one"]))).toBe(false); // same revision
  expect(feed.isReplyOnlyRevision(homeCard(3), homeCard(2, ["one"]))).toBe(false); // older revision
  expect(feed.isReplyOnlyRevision(homeCard(1), homeCard(2, ["one"], {}, { render: "post", source: { label: "S" } }))).toBe(false); // thread → post with a reply
});

test("Home's first-reply exception: a post may become a thread with its first reply and nothing else", () => {
  const post = (replies?: string[], body?: string) => homeCard(1, replies, body ? { body } : {}, { render: "post", source: { label: "S" } });
  expect(feed.isReplyOnlyRevision(post(), homeCard(2, ["one"]))).toBe(true); // absent → 1
  expect(feed.isReplyOnlyRevision(post([]), homeCard(2, ["one"]))).toBe(true); // [] → 1
  expect(feed.isReplyOnlyRevision(homeCard(1), renderOf(homeCard(1, ["one"]), "post"))).toBe(false); // thread → post
  expect(feed.isReplyOnlyRevision(post(), homeCard(2))).toBe(false); // post → thread, no reply
  expect(feed.isReplyOnlyRevision(post(), homeCard(2, ["one"], { body: "Changed" }))).toBe(false); // plus a body change
  expect(feed.isReplyOnlyRevision(post(["one"]), homeCard(2, ["one", "two"]))).toBe(false); // previous already had replies
  expect(feed.isReplyOnlyRevision(post(), renderOf(homeCard(1, ["one"]), "link"))).toBe(false); // post → link
  expect(feed.isReplyOnlyRevision(homeCard(1), renderOf(homeCard(1, ["one"]), "link"))).toBe(false); // thread → link
});

test("Home's absent render or payload counts as a post for the first-reply exception only", () => {
  const noRender = () => renderOf(homeCard(1), undefined, 1);
  const noPayload = (): FeedCard => { const { payload: _payload, ...rest } = homeCard(1); return rest; };
  const thread = (card: FeedCard, replies?: string[]): FeedCard => ({ ...card, revision: 2, payload: { ...(card.payload ?? {}), render: "thread", ...(replies ? { replies: replies.map((text) => ({ text })) } : {}) } });
  expect(feed.isReplyOnlyRevision(noRender(), thread(noRender(), ["one"]))).toBe(true); // absent render key → thread with a first reply
  expect(feed.isReplyOnlyRevision(noPayload(), { ...noPayload(), revision: 2, payload: { render: "thread", replies: [{ text: "one" }] } })).toBe(true); // absent payload
  expect(feed.isReplyOnlyRevision(noRender(), renderOf({ ...noRender(), payload: { replies: [{ text: "one" }] } }, "link"))).toBe(false); // absent → link
  expect(feed.isReplyOnlyRevision(noRender(), renderOf({ ...noRender(), payload: {} }, "post"))).toBe(false); // absent ↔ post with no reply: a stray render difference
  expect(feed.isReplyOnlyRevision(renderOf({ ...noRender(), payload: {} }, "post", 1), { ...noRender(), revision: 2, payload: {} })).toBe(false);
  expect(feed.isReplyOnlyRevision(noRender(), renderOf({ ...noRender(), payload: { replies: [{ text: "one" }] } }, "post"))).toBe(false); // absent → post with a reply
});
