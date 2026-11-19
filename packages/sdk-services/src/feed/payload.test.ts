import { afterEach, expect, test } from "bun:test";
import * as feed from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, NewFeedResponse } from "./types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const marker = "SYNTHETIC-ONLY-00Ab-7Zx9";
const code = `${marker}\nkeep whitespace  `;
const payload = {
  type: "test.approval-code", version: 1,
  data: {
    code, nested: [null, false, 0, "", { exact: "\\literal\nline", unicode: "café" }],
    literalKeys: JSON.parse('{"__proto__":{"keep":"literal"},"constructor":{"prototype":"literal"}}'),
  },
};
const card: FeedCard = {
  cardId: "card-private-payload", revision: 2, issuanceId: "issuance-private-payload",
  kind: "decision", needsResponse: true, title: "Review synthetic action", body: "A synthetic payload is available.",
  urgency: 1, createdAt: "2026-10-29T12:00:00Z",
};
const response: NewFeedResponse = {
  cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
  responseId: "response-private-payload", kind: "answer", text: "Approved action; fetch the typed payload explicitly.",
  createdAt: "2026-10-29T12:01:00Z",
};

async function databases() {
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  unwrap(await feed.publishFeedCard(output.handle, card));
  return { output: output.handle, responses: responses.handle };
}

test("typed payload JSON is preserved exactly while default response surfaces contain only metadata", async () => {
  const { output, responses } = await databases();
  const saved = unwrap(await feed.appendFeedResponse(output, responses, response, payload));
  expect(saved).toMatchObject({ responseId: response.responseId, payloadType: payload.type, payloadVersion: payload.version });
  const page = unwrap(await feed.listFeedResponses(responses));
  const state = unwrap(await feed.getFeedCardState(output, responses, card));
  expect(page).toEqual([saved]);
  expect(state.response).toEqual(saved);
  expect(JSON.stringify({ saved, page, state })).not.toContain(marker);
  expect(unwrap(await feed.readFeedResponsePayload(responses, response))).toEqual(payload);
  const stored = unwrap(await responses.query<string>(
    "SELECT payload_type, payload_version, payload_json FROM feed_response_payloads WHERE response_id = ?",
    [response.responseId],
  )).rows[0];
  expect(stored[0]).toBe(payload.type);
  expect(Number(stored[1])).toBe(payload.version);
  expect(JSON.parse(stored[2])).toEqual(payload.data);
});

test("a full response ID replays only when both header and payload match", async () => {
  const { output, responses } = await databases();
  const first = unwrap(await feed.appendFeedResponse(output, responses, response, payload));
  expect(unwrap(await feed.appendFeedResponse(output, responses, response, payload))).toEqual(first);
  const attempts = [
    await feed.appendFeedResponse(output, responses, { ...response, text: "Changed header" }, payload),
    await feed.appendFeedResponse(output, responses, response, { ...payload, type: "test.changed-type" }),
    await feed.appendFeedResponse(output, responses, response, { ...payload, version: 2 }),
    await feed.appendFeedResponse(output, responses, response, { ...payload, data: { code: "DIFFERENT-SYNTHETIC" } }),
    await feed.appendFeedResponse(output, responses, response),
  ];
  expect(attempts.map((result) => result.ok)).toEqual([false, false, false, false, false]);
  expect(JSON.stringify(attempts)).not.toContain(marker);
  expect(JSON.stringify(attempts)).not.toContain("DIFFERENT-SYNTHETIC");
  expect(unwrap(await feed.readFeedResponsePayload(responses, response))).toEqual(payload);
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([first]);
});

test("a header saved without a payload cannot acquire one later under the same response ID", async () => {
  const { output, responses } = await databases();
  const plain = { ...response, responseId: "response-without-payload" };
  const saved = unwrap(await feed.appendFeedResponse(output, responses, plain));
  expect((await feed.appendFeedResponse(output, responses, plain, payload)).ok).toBe(false);
  expect(unwrap(await feed.readFeedResponsePayload(responses, plain))).toBeUndefined();
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([saved]);
});

test("explicit payload reads require the full response and exact card revision/issuance identity", async () => {
  const { output, responses } = await databases();
  unwrap(await feed.appendFeedResponse(output, responses, response, payload));
  for (const identity of [
    { ...response, responseId: "unknown-response-id" },
    { ...response, cardId: "another-card" },
    { ...response, revision: response.revision + 1 },
    { ...response, issuanceId: "another-issuance" },
  ]) {
    const result = await feed.readFeedResponsePayload(responses, identity);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  }
  expect(unwrap(await feed.readFeedResponsePayload(responses, response))).toEqual(payload);
});

test("payload-write failure rolls back its response header and leaves the response ID retryable", async () => {
  const { output, responses } = await databases();
  unwrap(await responses.execute(`CREATE TRIGGER fail_private_payload BEFORE INSERT ON feed_response_payloads
    BEGIN SELECT RAISE(ABORT, '${marker}'); END`));
  const failed = await feed.appendFeedResponse(output, responses, response, payload);
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(marker);
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([]);
  unwrap(await responses.execute("DROP TRIGGER fail_private_payload"));
  const retried = unwrap(await feed.appendFeedResponse(output, responses, response, payload));
  expect(unwrap(await feed.listFeedResponses(responses))).toEqual([retried]);
  expect(unwrap(await feed.readFeedResponsePayload(responses, response))).toEqual(payload);
});

test("competing payload contents cannot attach to the winner's response identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc2205-payload-race-"));
  const output = sqliteHandle();
  const first = sqliteHandle(join(directory, "responses.sqlite"));
  const second = sqliteHandle(join(directory, "responses.sqlite"));
  const changed = { ...payload, data: { code: "OTHER-SYNTHETIC-CONTENDER" } };
  try {
    unwrap(await feed.initializeFeedDatabases({ output: output.handle, responses: first.handle }));
    unwrap(await feed.publishFeedCard(output.handle, card));
    const results = await Promise.all([
      feed.appendFeedResponse(output.handle, first.handle, response, payload),
      feed.appendFeedResponse(output.handle, second.handle, response, changed),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    const winner = results[0].ok ? payload : changed;
    expect(unwrap(await feed.readFeedResponsePayload(first.handle, response))).toEqual(winner);
    expect(unwrap(await feed.listFeedResponses(first.handle))).toHaveLength(1);
  } finally {
    second.close(); first.close(); output.close();
    await rm(directory, { recursive: true, force: true });
  }
});
