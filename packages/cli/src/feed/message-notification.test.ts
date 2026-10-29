import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as feed from "../../../sdk-services/src/feed";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedCard, FeedHandling, NewFeedMessage } from "../../../sdk-services/src/feed";
import { openFeedHandoff } from "./local";
import { runFeedRunner } from "./runner";

test("an information-card message travels through real stdin and retains independent historical handling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc2205-message-runner-"));
  const output = sqliteHandle();
  const responses = sqliteHandle();
  const local = await openFeedHandoff(join(directory, "handoff.sqlite"));
  const received = join(directory, "received.json");
  const marker = "SYNTHETIC-MESSAGE-RUNTIME-PRIVATE-CODE";
  const card: FeedCard = {
    cardId: "card-info-message-runtime", revision: 1, issuanceId: "issuance-info-message-runtime",
    kind: "information", needsResponse: false, title: "Draft report", body: "A report, not an unanswered decision.",
    urgency: 1, createdAt: "2026-10-29T12:00:00Z",
  };
  const message: NewFeedMessage = {
    cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    responseId: "response-info-message-runtime", kind: "message", text: "Please explain this report.", createdAt: card.createdAt,
  };
  const payload = { type: "test.private-message", version: 1, data: { code: marker } };
  try {
    unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
    unwrap(await feed.initializeFeedHandoff(local.handle));
    unwrap(await feed.publishFeedCard(output.handle, card));
    const saved = unwrap(await feed.appendFeedMessage(output.handle, responses.handle, message, payload));
    const code = `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],input));`;
    const delivered = unwrap(await feed.deliverFeedResponse({
      handoff: local.handle, recipient: "actual-message-runtime", response: saved,
      deliver: (item) => runFeedRunner([process.execPath, "-e", code, received], item),
    }));
    expect(delivered.state).toBe("delivered");
    const stdin = await readFile(received, "utf8");
    expect(JSON.parse(stdin)).toEqual({ ...message, sequence: saved.sequence, payloadType: payload.type, payloadVersion: 1 });
    expect(stdin).not.toContain(marker);
    const handoff = unwrap(await local.handle.query<string>("SELECT response_json FROM feed_handoffs")).rows;
    expect(handoff.map((row) => JSON.parse(row[0]))).toEqual([JSON.parse(stdin)]);
    expect(unwrap(await feed.readFeedResponsePayload(responses.handle, message))).toEqual(payload);

    const acknowledgement: FeedHandling = {
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      responseId: message.responseId, handlingId: "handling-info-message-runtime-ack", phase: "acknowledged", createdAt: card.createdAt,
    };
    const outcome: FeedHandling = { ...acknowledgement, handlingId: "handling-info-message-runtime-success", phase: "succeeded", detail: { explanation: "The report describes the saved draft." } };
    unwrap(await feed.recordFeedHandling(output.handle, acknowledgement));
    unwrap(await feed.recordFeedHandling(output.handle, outcome));
    unwrap(await feed.appendFeedMessage(output.handle, responses.handle, { ...message, responseId: "response-later-message", text: "A later question about the report." }));
    expect(unwrap(await feed.readFeedResponseHandling(output.handle, message))).toEqual({ acknowledgement, outcome });
    expect(unwrap(await feed.getFeedCardState(output.handle, responses.handle, card))).toEqual({
      card, response: null, acknowledgement: null, outcome: null,
    });
  } finally {
    local.close(); responses.close(); output.close();
    await rm(directory, { recursive: true, force: true });
  }
});
