import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFeedResponse, getFeedCardState, initializeFeedDatabases, publishFeedCard, recordFeedHandling } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedHandling } from "./types";

test("independent handlers cannot persist contradictory terminal outcomes for one response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc2205-handling-race-"));
  const first = sqliteHandle(join(directory, "output.sqlite"));
  const second = sqliteHandle(join(directory, "output.sqlite"));
  const responses = sqliteHandle();
  const card: FeedCard = {
    cardId: "card-terminal-race", revision: 1, issuanceId: "issuance-terminal-race",
    kind: "decision", needsResponse: true, title: "Draft", body: "Draft only", urgency: 1,
    createdAt: "2026-10-29T00:00:00Z",
  };
  const success: FeedHandling = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-terminal-race", handlingId: "handling-success",
    phase: "succeeded", createdAt: card.createdAt, detail: { draftId: "draft-one" },
  };
  const failure: FeedHandling = { ...success, handlingId: "handling-failure", phase: "failed", detail: { error: "failed" } };
  try {
    unwrap(await initializeFeedDatabases({ output: first.handle, responses: responses.handle }));
    unwrap(await publishFeedCard(first.handle, card));
    unwrap(await appendFeedResponse(first.handle, responses.handle, {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: success.responseId, kind: "answer", text: "Create draft", createdAt: card.createdAt,
    }));
    const results = await Promise.all([
      recordFeedHandling(first.handle, success), recordFeedHandling(second.handle, failure),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    const terminalRows = unwrap(await first.handle.query(
      "SELECT handling_id, phase FROM feed_handling WHERE response_id = ? AND phase IN ('succeeded', 'failed')",
      [success.responseId],
    )).rows;
    const winner = results[0].ok ? success : failure;
    expect(terminalRows).toEqual([[winner.handlingId, winner.phase]]);
    expect(unwrap(await recordFeedHandling(second.handle, winner))).toEqual(winner);
    expect((await recordFeedHandling(first.handle, { ...winner, detail: { changed: true } })).ok).toBe(false);
    const acknowledgement: FeedHandling = { ...success, handlingId: "handling-ack", phase: "acknowledged", detail: undefined };
    unwrap(await recordFeedHandling(first.handle, acknowledgement));
    const state = unwrap(await getFeedCardState(second.handle, responses.handle, card));
    expect(state.outcome).toEqual(winner);
    expect(state.acknowledgement).toMatchObject({ handlingId: acknowledgement.handlingId, phase: "acknowledged" });
  } finally {
    responses.close(); second.close(); first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
