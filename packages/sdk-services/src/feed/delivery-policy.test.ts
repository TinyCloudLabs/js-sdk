import { afterEach, expect, setSystemTime, test } from "bun:test";
import { inspect } from "node:util";
import * as feed from "./index";
import { ErrorCodes } from "../types";
import { unwrap } from "./sqlite.test-helper";
import {
  addPolicyEvidence, origin, pendingPolicy, privateMarker, restoredHeader, restoredRecord, restoreFixture, seedHistoricalResponse,
} from "./restore.test-helper";
import type { FeedRestoreDeliveryPolicy } from "./restore-types";
import type { FeedDatabase, FeedResponse } from "./types";
import type { QueryOptions, SqlValue } from "../sql/types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { setSystemTime(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const value = await restoreFixture(true); cleanup.push(value.close); return value; }
const recipient = "runtime-one";
const futureDeadline = "2099-01-01T00:00:00.000Z";

test("every verified historical state denies except exact resolved pending with an explicit valid cutoff", async () => {
  for (const state of ["delivered", "unconfirmed", "refused", "held", "unknown"] as const) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [{ ...pendingPolicy(), state }] }));
    const page = unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient }));
    expect(page.responses).toEqual([]);
    expect(page.nextSequence).toBe(1);
  }
  for (const deadline of [null, futureDeadline]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy(origin(), recipient, deadline)] }));
    const page = unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient }));
    expect(page.responses).toEqual([{ ...restoredHeader, sequence: 1, payloadType: "test.private-restore", payloadVersion: 1, dispatchBefore: deadline }]);
    expect(JSON.stringify(page)).not.toContain(privateMarker);
  }
});

test("recipient identity, resolved mapping, and dispatch mode cannot be inferred from other policy flags", async () => {
  for (const policy of [
    pendingPolicy(origin(), "different-runtime"),
    { ...pendingPolicy(), resolvedOwnerMapping: false },
    { ...pendingPolicy(), dispatch: "never" as const },
    { ...pendingPolicy(), dispatch: "held" as const },
  ]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [policy] }));
    expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient })).responses).toEqual([]);
  }
});

test("missing or invalid cutoff is unverified metadata, not an unbounded pending exception", async () => {
  for (const dispatchBefore of [undefined, "not-a-timestamp", "2030-01-01"]) {
    const f = await fixture();
    const invalid = { ...pendingPolicy(), dispatchBefore } as unknown as FeedRestoreDeliveryPolicy;
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [invalid] }));
    const result = await feed.listFeedResponseDeliveries(f.responses, { recipient });
    expect(result.ok).toBe(false);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
  }
});

test("expired valid policy is denied at the exact deadline while its verified page cursor can advance", async () => {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const f = await fixture();
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy(origin(), recipient, "2030-01-01T00:00:00.000Z")] }));
  expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient }))).toEqual({ responses: [], nextSequence: 1, hasMore: false });
});

test("state and cutoff conflicts deny independently of evidence insertion order", async () => {
  const conflicts = [
    { ...pendingPolicy(), state: "delivered" as const, dispatch: "never" as const },
    { ...pendingPolicy(), state: "unconfirmed" as const, dispatch: "never" as const },
    pendingPolicy(origin(), recipient, futureDeadline),
  ];
  for (const conflict of conflicts) for (const reverse of [false, true]) {
    const f = await fixture();
    const evidence = reverse ? [conflict, pendingPolicy()] : [pendingPolicy(), conflict];
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: evidence }));
    expect(unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient })).responses).toEqual([]);
  }
});

test("missing markers/origins/defaults and malformed or orphan evidence never fall through to live delivery", async () => {
  for (const damage of ["marker", "origin", "baseline", "malformed", "orphan-snapshot", "marker-identity"]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy()] }));
    if (damage === "marker") unwrap(await f.responses.execute("DELETE FROM feed_response_imports"));
    if (damage === "origin") unwrap(await f.responses.execute("DELETE FROM feed_response_origins"));
    if (damage === "baseline") unwrap(await f.responses.execute("DELETE FROM feed_response_delivery_policies WHERE recipient = '*'"));
    if (damage === "malformed") unwrap(await f.responses.execute("UPDATE feed_response_delivery_policies SET policy_json = ? WHERE recipient = ?", [`{${privateMarker}`, recipient]));
    if (damage === "orphan-snapshot") await addPolicyEvidence(f.responses, restoredHeader.responseId, pendingPolicy({ ...origin(), snapshotId: "not-registered" }));
    if (damage === "marker-identity") unwrap(await f.responses.execute("UPDATE feed_response_imports SET issuance_id = 'wrong-issuance'"));
    const result = await feed.listFeedResponseDeliveries(f.responses, { recipient });
    expect(result.ok).toBe(false);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
  }
});

test("a missing metadata table is a read failure, never a live fallback or unchecked cursor", async () => {
  for (const table of ["feed_response_imports", "feed_response_origins", "feed_response_delivery_policies"]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord());
    unwrap(await f.responses.execute(`DROP TABLE ${table}`));
    expect((await feed.listFeedResponseDeliveries(f.responses, { recipient })).ok).toBe(false);
  }
});

test("pagination limits headers before evidence fanout and never duplicates/skips a response", async () => {
  const f = await fixture();
  for (let index = 0; index < 5; index += 1) {
    const responseId = `policy-page-${index}`;
    const source = origin(responseId);
    await seedHistoricalResponse(f.responses, restoredRecord({ response: { ...restoredHeader, responseId }, origin: source,
      deliveries: [pendingPolicy(source), pendingPolicy(source, "runtime-other"), { ...pendingPolicy(source, "runtime-denied"), state: "held" }] }));
  }
  const seen: string[] = [];
  let afterSequence = 0;
  const cursors: number[] = [];
  for (;;) {
    const page = unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient, afterSequence, limit: 2 }));
    seen.push(...page.responses.map((row) => row.responseId));
    cursors.push(page.nextSequence);
    if (!page.hasMore) break;
    expect(page.nextSequence).toBeGreaterThan(afterSequence);
    afterSequence = page.nextSequence;
  }
  expect(seen).toEqual(["policy-page-0", "policy-page-1", "policy-page-2", "policy-page-3", "policy-page-4"]);
  expect(cursors).toEqual([2, 4, 5]);
});

test("a whole policy page is batch-read rather than one remote query per header", async () => {
  const f = await fixture();
  for (let index = 0; index < 25; index += 1) {
    const responseId = `policy-batch-${index}`;
    const source = origin(responseId);
    await seedHistoricalResponse(f.responses, restoredRecord({ response: { ...restoredHeader, responseId }, origin: source, deliveries: [pendingPolicy(source)] }));
  }
  let queries = 0;
  const counted = { query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
    queries += 1; return f.responses.query<T>(sql, params, options);
  } };
  const page = unwrap(await feed.listFeedResponseDeliveries(counted, { recipient, limit: 25 }));
  expect(page.responses.map((row) => row.responseId)).toEqual(Array.from({ length: 25 }, (_, index) => `policy-batch-${index}`));
  expect(queries).toBeLessThanOrEqual(2);
});

test("caller abort before or during the metadata read returns no verified delivery page", async () => {
  for (const before of [false, true]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy()] }));
    const abort = new AbortController();
    if (before) abort.abort(new Error(privateMarker));
    let queries = 0;
    const reader = { query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
      const result = await f.responses.query<T>(sql, params, options);
      if (++queries === 2) abort.abort(new Error(privateMarker));
      return result;
    } };
    const result = await feed.listFeedResponseDeliveries(reader, { recipient, signal: abort.signal });
    expect(result.ok).toBe(false);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
  }
});

test("deadline is checked before any local handoff even when an allowed page was read earlier", async () => {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const f = await fixture();
  const deadline = "2030-01-01T00:01:00.000Z";
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy(origin(), recipient, deadline)] }));
  const page = unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient }));
  setSystemTime(new Date(deadline));
  const handoff = f.handoff("expired-after-page.sqlite");
  unwrap(await feed.initializeFeedHandoff(handoff));
  const calls: string[] = [];
  const result = await feed.deliverFeedResponse({ handoff, recipient, response: page.responses[0], deliver: async (row) => { calls.push(row.responseId); return "delivered"; } });
  expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.PERMISSION_DENIED, meta: { reason: "dispatch_deadline" } } });
  expect(calls).toEqual([]);
  expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([]);
});

test("an already-expired safe header is refused before creating a ledger row", async () => {
  const f = await fixture();
  const handoff = f.handoff("already-expired.sqlite");
  unwrap(await feed.initializeFeedHandoff(handoff));
  const header = { ...restoredHeader, sequence: 1, dispatchBefore: "2000-01-01T00:00:00.000Z" };
  const calls: string[] = [];
  const result = await feed.deliverFeedResponse({ handoff, recipient, response: header, deliver: async (row) => { calls.push(row.responseId); return "delivered"; } });
  expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.PERMISSION_DENIED, meta: { reason: "dispatch_deadline" } } });
  expect(calls).toEqual([]);
  expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([]);
});

test("a deadline crossing after the durable claim cannot become delivered and the uncertain identity never auto-replays", async () => {
  const deadline = "2030-01-01T00:01:00.000Z";
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const f = await fixture();
  const disk = f.handoff("claim-crossing.sqlite");
  unwrap(await feed.initializeFeedHandoff(disk));
  const handoff: FeedDatabase = {
    ...disk,
    execute: async (sql, params, options) => {
      const result = await disk.execute(sql, params, options);
      const rows = unwrap(await disk.query<string>("SELECT state FROM feed_handoffs WHERE response_id = ?", [restoredHeader.responseId])).rows;
      if (rows[0]?.[0] === "unconfirmed") setSystemTime(new Date(deadline));
      return result;
    },
  };
  const header = { ...restoredHeader, sequence: 1, dispatchBefore: deadline };
  const calls: string[] = [];
  const deliver = async (row: FeedResponse): Promise<"delivered"> => { calls.push(row.responseId); return "delivered"; };
  expect(await feed.deliverFeedResponse({ handoff, recipient, response: header, deliver }))
    .toMatchObject({ ok: false, error: { code: ErrorCodes.PERMISSION_DENIED, meta: { reason: "dispatch_deadline" } } });
  expect(calls).toEqual([]);
  expect(unwrap(await feed.getFeedHandoff(disk, header.responseId, recipient))?.state).toBe("unconfirmed");
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  expect(unwrap(await feed.deliverFeedResponse({ handoff: disk, recipient, response: header, deliver })).state).toBe("unconfirmed");
  expect(calls).toEqual([]);
});
