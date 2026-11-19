import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";
import * as feed from "./index";
import { unwrap } from "./sqlite.test-helper";
import {
  origin, pendingPolicy, privateMarker, restoredCard, restoredHeader, restoredPayload, restoredRecord, restoreFixture,
} from "./restore.test-helper";
import type { FeedRestoreDeliveryPolicy, FeedRestoreResponse } from "./restore-types";
import type { FeedDatabase, NewFeedMessage } from "./types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const value = await restoreFixture(); cleanup.push(value.close); return value; }
const emptyPage = { recipient: "runtime-one" };

test("restore publishes full cards first and saves historical answer/followup/message headers without live eligibility", async () => {
  const f = await fixture();
  const followup = { ...restoredHeader, responseId: "response-restored-followup", kind: "followup" as const, supersedesResponseId: restoredHeader.responseId };
  const message: NewFeedMessage = {
    cardId: restoredCard.cardId, revision: restoredCard.revision, issuanceId: restoredCard.issuanceId,
    responseId: "response-restored-message", kind: "message", text: "A historical note, not a decision.", createdAt: restoredCard.createdAt,
  };
  const records = { cards: [restoredCard], responses: [restoredRecord(), restoredRecord({ response: followup, origin: origin(followup.responseId), payload: undefined }), restoredRecord({ response: message, origin: origin(message.responseId), payload: undefined })] };
  unwrap(await feed.restoreFeedRecords(f.databases, records));
  expect(unwrap(await feed.listFeedCards(f.output))).toEqual([restoredCard]);
  const saved = unwrap(await feed.listFeedResponses(f.responses));
  expect(saved.map((row) => [row.responseId, row.kind])).toEqual([[restoredHeader.responseId, "answer"], [followup.responseId, "followup"], [message.responseId, "message"]]);
  expect(unwrap(await feed.readFeedResponsePayload(f.responses, restoredHeader))).toEqual(restoredPayload);
  expect(JSON.stringify(saved)).not.toContain(privateMarker);
  expect((await feed.appendFeedResponse(f.output, f.responses, { ...restoredHeader, responseId: "live-ineligible" })).ok).toBe(false);
  unwrap(await feed.restoreFeedRecords(f.databases, records));
  expect(unwrap(await feed.listFeedResponses(f.responses))).toEqual(saved);
  const denied = unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage));
  expect(denied.responses).toEqual([]);
  expect(denied.nextSequence).toBe(saved[2].sequence);
});

test("restored response replay refuses changed, omitted, late or cross-kind private content", async () => {
  const f = await fixture();
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [restoredRecord()] }));
  const before = unwrap(await feed.listFeedResponses(f.responses));
  for (const record of [
    restoredRecord({ payload: undefined }),
    restoredRecord({ payload: { ...restoredPayload, data: { code: "OTHER-SYNTHETIC" } } }),
    restoredRecord({ response: { ...restoredHeader, text: "Changed header" } }),
    restoredRecord({ response: { cardId: restoredCard.cardId, revision: restoredCard.revision, issuanceId: restoredCard.issuanceId, responseId: restoredHeader.responseId, kind: "message", text: "Changed kind", createdAt: restoredCard.createdAt } }),
  ]) {
    const result = await feed.restoreFeedRecords(f.databases, { cards: [], responses: [record] });
    expect(result.ok).toBe(false);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
  }
  expect(unwrap(await feed.listFeedResponses(f.responses))).toEqual(before);
  expect(unwrap(await feed.readFeedResponsePayload(f.responses, restoredHeader))).toEqual(restoredPayload);
  const plain = restoredRecord({ response: { ...restoredHeader, responseId: "restored-plain" }, origin: origin("restored-plain"), payload: undefined });
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [], responses: [plain] }));
  expect((await feed.restoreFeedRecords(f.databases, { cards: [], responses: [{ ...plain, payload: restoredPayload }] })).ok).toBe(false);
});

test("an existing identical live response never acquires import origin or remote suppression metadata", async () => {
  const f = await fixture();
  unwrap(await feed.publishFeedCard(f.output, { ...restoredCard, needsResponse: true }));
  const live = unwrap(await feed.appendFeedResponse(f.output, f.responses, restoredHeader, restoredPayload));
  expect((await feed.restoreFeedRecords(f.databases, { cards: [], responses: [restoredRecord()] })).ok).toBe(false);
  for (const table of ["feed_response_imports", "feed_response_origins", "feed_response_delivery_policies"]) {
    expect(unwrap(await f.responses.query(`SELECT response_id FROM ${table}`)).rows).toEqual([]);
  }
  expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage))).toEqual({ responses: [live], nextSequence: live.sequence, hasMore: false });
});

test("a live SQL commit wins even while its caller is still awaiting completion of the append", async () => {
  const f = await fixture();
  unwrap(await feed.publishFeedCard(f.output, { ...restoredCard, needsResponse: true }));
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delayedLive: FeedDatabase = {
    ...f.responses,
    batch: async (statements, options) => {
      const result = await f.responses.batch(statements, options);
      committed.resolve();
      await release.promise;
      return result;
    },
  };
  const live = feed.appendFeedResponse(f.output, delayedLive, restoredHeader, restoredPayload);
  try {
    await committed.promise;
    const result = await feed.restoreFeedRecords({ output: f.output, responses: f.otherResponses() }, { cards: [], responses: [restoredRecord()] });
    expect(result.ok).toBe(false);
    expect(unwrap(await f.responses.query("SELECT response_id FROM feed_response_imports")).rows).toEqual([]);
  } finally { release.resolve(); await live; }
  expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage)).responses.map((row) => row.responseId)).toEqual([restoredHeader.responseId]);
});

test("unknown card revision or issuance and invalid generic response/payload shapes do not restore headers", async () => {
  const f = await fixture();
  unwrap(await feed.publishFeedCard(f.output, restoredCard));
  const invalid = [
    restoredRecord({ response: { ...restoredHeader, cardId: "unpublished-card" } }),
    restoredRecord({ response: { ...restoredHeader, revision: restoredCard.revision + 1 } }),
    restoredRecord({ response: { ...restoredHeader, issuanceId: "unpublished-issuance" } }),
    restoredRecord({ payload: { ...restoredPayload, version: 0 } }),
    { ...restoredRecord(), response: { ...restoredHeader, kind: "message", text: "A note", choiceId: "approve" } } as unknown as FeedRestoreResponse,
  ];
  for (const record of invalid) expect((await feed.restoreFeedRecords(f.databases, { cards: [], responses: [record] })).ok).toBe(false);
  expect(unwrap(await feed.listFeedResponses(f.responses))).toEqual([]);
});

test("origin or default-policy trigger failure rolls back header, private payload and all import authority together", async () => {
  for (const table of ["feed_response_origins", "feed_response_delivery_policies"]) {
    const f = await fixture();
    unwrap(await f.responses.execute(`CREATE TRIGGER fail_restore_metadata BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`));
    const failed = await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [restoredRecord()] });
    expect(failed.ok).toBe(false);
    expect(inspect(failed, { depth: 20 })).not.toContain(privateMarker);
    expect(unwrap(await feed.listFeedCards(f.output))).toEqual([restoredCard]);
    for (const name of ["feed_responses", "feed_response_payloads", "feed_response_imports", "feed_response_origins", "feed_response_delivery_policies"]) {
      expect(unwrap(await f.responses.query(`SELECT response_id FROM ${name}`)).rows).toEqual([]);
    }
    unwrap(await f.responses.execute("DROP TRIGGER fail_restore_metadata"));
    unwrap(await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [restoredRecord()] }));
    expect(unwrap(await feed.readFeedResponsePayload(f.responses, restoredHeader))).toEqual(restoredPayload);
    expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage)).responses).toEqual([]);
  }
});

test("new response import provenance and default deny are durable on a fresh connection without private receipt copies", async () => {
  const f = await fixture();
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [restoredRecord()] }));
  const reopened = f.otherResponses();
  expect(unwrap(await feed.listFeedResponseDeliveries(reopened, emptyPage)).responses).toEqual([]);
  const origins = unwrap(await reopened.query<string>("SELECT source_json FROM feed_response_origins")).rows.map((row) => JSON.parse(row[0]));
  expect(origins).toEqual([origin()]);
  const policies = unwrap(await reopened.query<string>("SELECT policy_json FROM feed_response_delivery_policies")).rows.map((row) => JSON.parse(row[0]));
  expect(policies).toEqual([{ recipient: "*", state: "unknown", dispatch: "never", resolvedOwnerMapping: false, dispatchBefore: null, source: origin() }]);
  expect(inspect({ origins, policies }, { depth: 20 })).not.toContain(privateMarker);
});

test("distinct snapshots preserve references but cannot alias source binding or use another snapshot's exception", async () => {
  const f = await fixture();
  const first = restoredRecord({ deliveries: [pendingPolicy()] });
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [first] }));
  const nextOrigin = { ...origin(), snapshotId: "snapshot-frozen-two" };
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [], responses: [restoredRecord({ origin: nextOrigin })] }));
  expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage)).responses).toEqual([]);
  unwrap(await feed.restoreFeedRecords(f.databases, { cards: [], responses: [restoredRecord({ origin: nextOrigin, deliveries: [pendingPolicy(nextOrigin)] })] }));
  expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, emptyPage)).responses.map((row) => row.responseId)).toEqual([restoredHeader.responseId]);
  for (const changed of [
    { sourceSpaceId: "other-space" }, { namespace: "another/namespace/" }, { sourceKey: "another/key" }, { eventKey: "another-event" },
  ]) {
    expect((await feed.restoreFeedRecords(f.databases, { cards: [], responses: [restoredRecord({ origin: { ...nextOrigin, ...changed, snapshotId: "snapshot-alias" } })] })).ok).toBe(false);
  }
  const refs = unwrap(await f.responses.query<string>("SELECT source_json FROM feed_response_origins")).rows.map((row) => JSON.parse(row[0]));
  expect(refs.map((value) => value.snapshotId).sort()).toEqual(["snapshot-frozen-one", "snapshot-frozen-two"]);
});

test("raw receipts and cross-origin or wildcard allow policies are rejected before new restore authority", async () => {
  for (const delivery of [
    { ...pendingPolicy(), originalReceipt: { code: privateMarker } },
    pendingPolicy({ ...origin(), snapshotId: "unregistered-snapshot" }),
    { ...pendingPolicy(), recipient: "*" },
  ]) {
    const f = await fixture();
    const result = await feed.restoreFeedRecords(f.databases, { cards: [restoredCard], responses: [restoredRecord({ deliveries: [delivery as FeedRestoreDeliveryPolicy] })] });
    expect(result.ok).toBe(false);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
    expect(unwrap(await feed.listFeedResponses(f.responses))).toEqual([]);
  }
});

test("concurrent independent restores retain contradictory evidence and conservatively deny after explicit failed-call replay", async () => {
  const f = await fixture();
  unwrap(await feed.publishFeedCard(f.output, restoredCard));
  const second = f.otherResponses();
  const allow = restoredRecord({ deliveries: [pendingPolicy()] });
  const deny = restoredRecord({ deliveries: [{ ...pendingPolicy(), state: "delivered", dispatch: "never" }] });
  const results = await Promise.all([
    feed.restoreFeedRecords(f.databases, { cards: [], responses: [allow] }),
    feed.restoreFeedRecords({ output: f.output, responses: second }, { cards: [], responses: [deny] }),
  ]);
  // SQLite can reject a competing writer as busy; an explicit repeat is safe, never an automatic send retry.
  if (!results[0].ok) unwrap(await feed.restoreFeedRecords(f.databases, { cards: [], responses: [allow] }));
  if (!results[1].ok) unwrap(await feed.restoreFeedRecords({ output: f.output, responses: second }, { cards: [], responses: [deny] }));
  expect(unwrap(await feed.listFeedResponseDeliveries(second, emptyPage)).responses).toEqual([]);
  const evidence = unwrap(await second.query<string>("SELECT policy_json FROM feed_response_delivery_policies WHERE recipient = ?", ["runtime-one"])).rows.map((row) => JSON.parse(row[0]).state).sort();
  expect(evidence).toEqual(["delivered", "pending"]);
  expect(unwrap(await feed.readFeedResponsePayload(second, restoredHeader))).toEqual(restoredPayload);
});

test("concurrent first imports cannot bind one response to unrelated source namespaces", async () => {
  const f = await fixture();
  unwrap(await feed.publishFeedCard(f.output, restoredCard));
  const second = f.otherResponses();
  const foreignOrigin = { ...origin(), namespace: "unrelated/namespace/" };
  const firstRecord = restoredRecord({ deliveries: [pendingPolicy()] });
  const secondRecord = restoredRecord({ origin: foreignOrigin, deliveries: [pendingPolicy(foreignOrigin)] });
  const results = await Promise.all([
    feed.restoreFeedRecords(f.databases, { cards: [], responses: [firstRecord] }),
    feed.restoreFeedRecords({ output: f.output, responses: second }, { cards: [], responses: [secondRecord] }),
  ]);
  expect(results.some((result) => result.ok)).toBe(true);
  // A busy loser may be explicitly retried, but it cannot turn the winning binding into an alias.
  if (!results[0].ok) await feed.restoreFeedRecords(f.databases, { cards: [], responses: [firstRecord] });
  if (!results[1].ok) await feed.restoreFeedRecords({ output: f.output, responses: second }, { cards: [], responses: [secondRecord] });
  const refs = unwrap(await second.query<string>("SELECT source_json FROM feed_response_origins")).rows.map((row) => JSON.parse(row[0]));
  expect(new Set(refs.map((value) => JSON.stringify([value.sourceSpaceId, value.namespace, value.sourceKey, value.eventKey]))).size).toBe(1);
  const page = unwrap(await feed.listFeedResponseDeliveries(second, emptyPage));
  expect(page.responses.map((row) => row.responseId)).toEqual([restoredHeader.responseId]);
});
