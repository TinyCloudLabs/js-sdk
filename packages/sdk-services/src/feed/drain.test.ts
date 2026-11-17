import { afterEach, expect, test } from "bun:test";
import {
  appendFeedMessage, appendFeedResponse, drainFeedResponses, initializeFeedDatabases, publishFeedCard,
} from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedResponse } from "./types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function database() {
  const fixture = sqliteHandle();
  cleanup.push(fixture.close);
  return fixture.handle;
}

const card: FeedCard = {
  cardId: "card-drain-full-id", revision: 1, issuanceId: "issuance-drain-full-id",
  kind: "decision", needsResponse: true, title: "Draft", body: "Create draft only",
  urgency: 1, createdAt: "2026-11-17T12:00:00.000Z",
};
const identity = { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, createdAt: card.createdAt };

async function fixture() {
  const output = database();
  const responses = database();
  const handoff = database();
  unwrap(await initializeFeedDatabases({ output, responses }));
  unwrap(await publishFeedCard(output, card));
  return { output, responses, handoff };
}

test("one drain hands off every pending answer and owner comment, with their card and response ids, in order", async () => {
  const { output, responses, handoff } = await fixture();
  unwrap(await appendFeedResponse(output, responses, { ...identity, responseId: "response-1", kind: "followup", text: "go" }));
  unwrap(await appendFeedMessage(output, responses, { ...identity, responseId: "message-1", kind: "message", text: "why?" }));
  const seen: FeedResponse[] = [];
  await drainFeedResponses({
    responses, handoff, recipient: "agent-one", signal: new AbortController().signal,
    deliver: async (response) => { seen.push(response); return "delivered"; },
  });
  expect(seen.map(({ kind, responseId, cardId, sequence }) => ({ kind, responseId, cardId, sequence }))).toEqual([
    { kind: "followup", responseId: "response-1", cardId: card.cardId, sequence: 1 },
    { kind: "message", responseId: "message-1", cardId: card.cardId, sequence: 2 },
  ]);
});

test("a repeat wake delivers nothing twice, and a response saved since is delivered once", async () => {
  const { output, responses, handoff } = await fixture();
  unwrap(await appendFeedResponse(output, responses, { ...identity, responseId: "response-1", kind: "followup", text: "go" }));
  const seen: string[] = [];
  const drain = () => drainFeedResponses({
    responses, handoff, recipient: "agent-one", signal: new AbortController().signal,
    deliver: async (response) => { seen.push(response.responseId); return "delivered"; },
  });
  await drain();
  await drain();
  expect(seen).toEqual(["response-1"]);
  unwrap(await appendFeedMessage(output, responses, { ...identity, responseId: "message-2", kind: "message", text: "also" }));
  await drain();
  expect(seen).toEqual(["response-1", "message-2"]);
});

test("a handoff the runner did not confirm is never resent (at most once)", async () => {
  const { output, responses, handoff } = await fixture();
  unwrap(await appendFeedResponse(output, responses, { ...identity, responseId: "response-1", kind: "followup", text: "go" }));
  const attempts: string[] = [];
  await drainFeedResponses({
    responses, handoff, recipient: "agent-one", signal: new AbortController().signal,
    deliver: async (response) => { attempts.push(response.responseId); return "unconfirmed"; },
  });
  await drainFeedResponses({
    responses, handoff, recipient: "agent-one", signal: new AbortController().signal,
    deliver: async (response) => { attempts.push(response.responseId); return "delivered"; },
  });
  expect(attempts).toEqual(["response-1"]);
});
