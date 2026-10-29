import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as feed from "./index";
import { unwrap } from "./sqlite.test-helper";
import {
  oneReadyStream, origin, pendingPolicy, privateMarker, restoredCard, restoredHeader, restoredRecord, restoreFixture, seedHistoricalResponse,
} from "./restore.test-helper";
import type { FeedDatabase, FeedReadDatabase, FeedResponse } from "./types";
import type { QueryOptions, SqlValue } from "../sql/types";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { setSystemTime(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const value = await restoreFixture(true); cleanup.push(value.close); return value; }
async function drain(responses: FeedReadDatabase, handoff: FeedDatabase, deliver: (response: FeedResponse) => Promise<"delivered" | "unconfirmed">) {
  const stream = oneReadyStream();
  const abort = new AbortController();
  const finished = feed.listenFeedResponses({ responses, handoff, recipient: "runtime-one", hooks: stream.hooks,
    subscription: { service: "sql", space: "owner-space", pathPrefix: "app/feed_responses_history" }, signal: abort.signal, deliver });
  await stream.opened;
  stream.ready();
  stream.finish();
  try { await finished; }
  finally { abort.abort(); }
}

test("remote historical denial protects every fresh local disk, not just a prior watcher ledger", async () => {
  for (const state of ["default", "delivered", "unconfirmed", "refused", "held", "unknown"] as const) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: state === "default" ? [] : [{ ...pendingPolicy(), state }] }));
    const calls: string[] = [];
    for (const filename of ["first-empty-ledger.sqlite", "second-empty-ledger.sqlite"]) {
      const handoff = f.handoff(filename);
      await drain(f.otherResponses(), handoff, async (row) => { calls.push(row.responseId); return "delivered"; });
      expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([]);
    }
    expect(calls).toEqual([]);
  }
});

test("only the exact resolved pending recipient is sent while ordinary positive-absence live rows retain flow", async () => {
  const f = await fixture();
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy()] }));
  const otherId = "history-other-recipient";
  await seedHistoricalResponse(f.responses, restoredRecord({ response: { ...restoredHeader, responseId: otherId }, origin: origin(otherId),
    deliveries: [pendingPolicy(origin(otherId), "runtime-other")] }));
  unwrap(await feed.publishFeedCard(f.output, { ...restoredCard, needsResponse: true }));
  const live = unwrap(await feed.appendFeedResponse(f.output, f.responses, { ...restoredHeader, responseId: "ordinary-live-response" }));
  const calls: Array<{ responseId: string; dispatchBefore?: string | null }> = [];
  const handoff = f.handoff("pending-and-live.sqlite");
  await drain(f.responses, handoff, async (row) => { calls.push(row); return "delivered"; });
  expect(calls.map((row) => row.responseId)).toEqual([restoredHeader.responseId, live.responseId]);
  expect(calls[0]).toHaveProperty("dispatchBefore", null);
  expect(calls[1]).not.toHaveProperty("dispatchBefore");
  expect(unwrap(await handoff.query("SELECT response_id, state FROM feed_handoffs ORDER BY rowid")).rows)
    .toEqual([[restoredHeader.responseId, "delivered"], [live.responseId, "delivered"]]);
});

test("a full denied header page cannot hide the next pending or live response, and policy reads stay batched", async () => {
  const f = await fixture();
  for (let index = 0; index < 101; index += 1) {
    const responseId = `history-denied-${index}`;
    await seedHistoricalResponse(f.responses, restoredRecord({ response: { ...restoredHeader, responseId }, origin: origin(responseId) }));
  }
  unwrap(await feed.publishFeedCard(f.output, { ...restoredCard, needsResponse: true }));
  const live = unwrap(await feed.appendFeedResponse(f.output, f.responses, { ...restoredHeader, responseId: "live-after-denied-page" }));
  let queries = 0;
  const reader = { query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
    queries += 1; return f.responses.query<T>(sql, params, options);
  } };
  const calls: string[] = [];
  const handoff = f.handoff("many-denied.sqlite");
  await drain(reader, handoff, async (row) => { calls.push(row.responseId); return "delivered"; });
  expect(calls).toEqual([live.responseId]);
  expect(queries).toBeLessThanOrEqual(4);
  expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([[live.responseId]]);
});

test("unverified metadata or a real policy SQL failure stops the drain before any handoff or live fallthrough", async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture();
    await seedHistoricalResponse(f.responses, restoredRecord());
    if (corrupt) unwrap(await f.responses.execute("UPDATE feed_response_origins SET source_json = '{invalid-origin'"));
    else unwrap(await f.responses.execute("DROP TABLE feed_response_delivery_policies"));
    const calls: string[] = [];
    const handoff = f.handoff("unverified.sqlite");
    const result = await drain(f.responses, handoff, async (row) => { calls.push(row.responseId); return "delivered"; })
      .then(() => ({ state: "stopped" }), (error: unknown) => ({ state: "failed", error }));
    expect(result).toMatchObject({ state: "failed" });
    expect(calls).toEqual([]);
    expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([]);
  }
});

test("caller abort during policy reconciliation cannot create a local handoff", async () => {
  const f = await fixture();
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy()] }));
  const stream = oneReadyStream();
  const abort = new AbortController();
  let queries = 0;
  const reader = { query: async <T>(sql: string, params?: SqlValue[], options?: QueryOptions) => {
    const result = await f.responses.query<T>(sql, params, options);
    if (++queries === 1) abort.abort();
    return result;
  } };
  const calls: string[] = [];
  const handoff = f.handoff("aborted-reconcile.sqlite");
  const finished = feed.listenFeedResponses({ responses: reader, handoff, recipient: "runtime-one", hooks: stream.hooks,
    subscription: { service: "sql", space: "owner-space", pathPrefix: "app/feed_responses_history" }, signal: abort.signal,
    deliver: async (row) => { calls.push(row.responseId); return "delivered"; } });
  await stream.opened; stream.ready();
  await finished;
  expect(calls).toEqual([]);
  expect(unwrap(await handoff.query("SELECT response_id FROM feed_handoffs")).rows).toEqual([]);
});

test("a genuine handoff deadline refusal is skipped without failing or suppressing a later live response", async () => {
  setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const deadline = "2030-01-01T00:01:00.000Z";
  const f = await fixture();
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy(origin(), "runtime-one", deadline)] }));
  unwrap(await feed.publishFeedCard(f.output, { ...restoredCard, needsResponse: true }));
  const live = unwrap(await feed.appendFeedResponse(f.output, f.responses, { ...restoredHeader, responseId: "live-after-deadline-refusal" }));
  const disk = f.handoff("deadline-refusal.sqlite");
  let advanced = false;
  const handoff: FeedDatabase = { ...disk, execute: async (sql, params, options) => {
    const result = await disk.execute(sql, params, options);
    const records = unwrap(await disk.query<string>("SELECT state FROM feed_handoffs WHERE response_id = ?", [restoredHeader.responseId])).rows;
    if (!advanced && records[0]?.[0] === "prepared") { advanced = true; setSystemTime(new Date(deadline)); }
    return result;
  } };
  const calls: string[] = [];
  await drain(f.responses, handoff, async (row) => { calls.push(row.responseId); return "delivered"; });
  expect(calls).toEqual([live.responseId]);
  expect(unwrap(await feed.getFeedHandoff(disk, restoredHeader.responseId, "runtime-one"))?.state).not.toBe("delivered");
  expect(unwrap(await feed.getFeedHandoff(disk, live.responseId, "runtime-one"))?.state).toBe("delivered");
});

test("validated dispatch cutoff survives durable JSON and a real child's stdin without private payload or receipt copies", async () => {
  const f = await fixture();
  const deadline = "2099-01-01T00:00:00.000Z";
  await seedHistoricalResponse(f.responses, restoredRecord({ deliveries: [pendingPolicy(origin(), "runtime-one", deadline)] }));
  const page = unwrap(await feed.listFeedResponseDeliveries(f.responses, { recipient: "runtime-one" }));
  const path = join(f.directory, "runtime-header.json");
  const handoff = f.handoff("real-runtime.sqlite");
  unwrap(await feed.initializeFeedHandoff(handoff));
  const polluted = { ...page.responses[0], payload: { code: privateMarker }, originalReceipt: { code: privateMarker }, legacyLedger: { code: privateMarker } };
  const result = unwrap(await feed.deliverFeedResponse({ handoff, recipient: "runtime-one", response: polluted, deliver: async (row) => {
    const child = Bun.spawn([process.execPath, "--eval", `
      const fs=await import('node:fs');const header=JSON.parse(fs.readFileSync(0,'utf8'));
      if(header.dispatchBefore!==null && (!header.dispatchBefore || Date.now()>=Date.parse(header.dispatchBefore)))process.exit(2);
      const file=fs.openSync(process.argv.at(-1),'wx',0o600);fs.writeFileSync(file,JSON.stringify(header));fs.fsyncSync(file);fs.closeSync(file);
    `, path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    cleanup.push(() => { if (child.exitCode === null) child.kill(); });
    child.stdin.write(`${JSON.stringify(row)}\n`); child.stdin.end();
    return await child.exited === 0 ? "delivered" : "unconfirmed";
  } }));
  expect(result.state).toBe("delivered");
  const actual = await readFile(path, "utf8");
  expect(JSON.parse(actual)).toEqual({ ...restoredHeader, sequence: 1, payloadType: "test.private-restore", payloadVersion: 1, dispatchBefore: deadline });
  expect(actual).not.toContain(privateMarker);
  const ledger = unwrap(await handoff.query<string>("SELECT response_json FROM feed_handoffs")).rows;
  expect(ledger.map((row) => JSON.parse(row[0]))).toEqual([JSON.parse(actual)]);
  expect(JSON.stringify(ledger)).not.toContain(privateMarker);
});
