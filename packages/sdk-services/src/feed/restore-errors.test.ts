import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { ErrorCodes } from "../types";
import type { FetchFunction } from "../types";
import {
  listFeedResponseDeliveries, listFeedResponses, publishFeedCard,
  readFeedResponsePayload, restoreFeedRecords,
} from "./index";
import { unwrap } from "./sqlite.test-helper";
import {
  origin, pendingPolicy, privateMarker, restoredCard, restoredHeader,
  restoredPayload, restoredRecord, restoreFixture,
} from "./restore.test-helper";
import type { FeedDatabase } from "./types";

type Stage = "card" | "batch";
type Mode = "sql" | "permission" | "late-success" | "pending" | "recover" | "recover-abort";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const records = () => ({ cards: [], responses: [restoredRecord({ deliveries: [pendingPolicy()] })] });
const authorityTables = [
  "feed_responses", "feed_response_payloads", "feed_response_imports",
  "feed_response_origins", "feed_response_delivery_policies",
];

async function transportFixture(stage: Stage, mode: Mode) {
  const disk = await restoreFixture();
  cleanup.push(disk.close);
  unwrap(await publishFeedCard(disk.output, restoredCard));
  if (mode === "sql") {
    if (stage === "card") unwrap(await disk.output.execute("DROP TABLE feed_cards"));
    else unwrap(await disk.responses.execute(`CREATE TRIGGER fail_restore_error_race BEFORE INSERT ON feed_response_origins
      BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`));
  }
  const abort = new AbortController();
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completedStatuses: number[] = [];
  let targeted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      let atBoundary = false;
      try {
        const body = await request.json();
        // The public invocation-header callback supplies the requested database.
        const database = request.headers.get("X-Fixture-Database");
        const handle = database === "fixture-output" ? disk.output
          : database === "fixture-responses" ? disk.responses : undefined;
        if (!handle) throw new Error("Unknown fixture database");
        atBoundary = !targeted && (stage === "card"
          ? database === "fixture-output" && body.action === "query"
          : database === "fixture-responses" && body.action === "batch");
        if (atBoundary) targeted = true;
        const headers = atBoundary ? { "X-Fixture-Boundary": stage } : {};
        if (atBoundary && mode === "permission") {
          // A real loopback HTTP permission boundary, not a Node grant-proof fixture.
          return Response.json({ error: `Denied fixture capability: ${privateMarker}`, cause: { privateValue: privateMarker } }, {
            status: 403, headers,
          });
        }
        if (atBoundary && (mode === "recover" || mode === "recover-abort")) {
          // The loser already read absence. An independent SQLite owner commits the
          // identical import before the loser's batch encounters a genuine SQL error.
          unwrap(await restoreFeedRecords({ output: disk.output, responses: disk.otherResponses() }, records()));
          unwrap(await disk.responses.execute(`CREATE TRIGGER fail_restore_error_race BEFORE INSERT ON feed_response_origins
            BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`));
        }
        const result = body.action === "batch"
          ? unwrap(await handle.batch(body.statements))
          : unwrap(await handle.query(body.sql, body.params));
        if (atBoundary) {
          arrived.resolve();
          if (mode === "pending") await release.promise;
        }
        return Response.json(result, { headers });
      } catch (error) {
        if (atBoundary) arrived.resolve();
        return Response.json({
          error: `${privateMarker}: ${String(error)}`,
          cause: { privatePayload: { code: privateMarker } }, meta: { value: privateMarker },
        }, { status: 400, headers: atBoundary ? { "X-Fixture-Boundary": stage } : {} });
      }
    },
  });
  cleanup.push(async () => { abort.abort(); release.resolve(); await server.stop(true); });
  const detachedFetch: FetchFunction = async (url, options) => {
    const wire = await globalThis.fetch(url, { ...options, signal: undefined });
    // Finish the actual HTTP body before cancelling. The fresh Response cannot
    // turn a completed HTTP400/403 into a body-stream AbortError.
    const detached = new Response(await wire.arrayBuffer(), {
      status: wire.status, statusText: wire.statusText, headers: wire.headers,
    });
    if (wire.headers.get("X-Fixture-Boundary") === stage) {
      completedStatuses.push(wire.status);
      if (mode !== "recover") abort.abort();
    }
    return detached;
  };
  const context = new ServiceContext({
    invoke: (_session, _service, path) => ({ Authorization: "test-invocation", "X-Fixture-Database": path }),
    hosts: [server.url.href], fetch: mode === "pending" ? undefined : detachedFetch,
    retryPolicy: { maxAttempts: 1 },
    session: {
      delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
      spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
      verificationMethod: "did:key:test", jwk: {},
    },
  });
  const ordinary: unknown[] = [];
  context.on("service.error", (event) => { ordinary.push(event); });
  const service = new SQLService();
  service.initialize(context);
  return {
    ...disk, pair: { output: service.db("fixture-output"), responses: service.db("fixture-responses") },
    abort, ordinary, completedStatuses, arrived: arrived.promise, release: () => release.resolve(),
  };
}

async function expectAbsent(responses: FeedDatabase) {
  for (const table of authorityTables) {
    expect(unwrap(await responses.query(`SELECT response_id FROM ${table}`)).rows).toEqual([]);
  }
}

async function expectOneCompleteImport(responses: FeedDatabase) {
  const header = {
    ...restoredHeader, sequence: 1, payloadType: restoredPayload.type, payloadVersion: restoredPayload.version,
  };
  expect(unwrap(await listFeedResponses(responses))).toEqual([header]);
  expect(unwrap(await readFeedResponsePayload(responses, restoredHeader))).toEqual(restoredPayload);
  expect(unwrap(await listFeedResponseDeliveries(responses, { recipient: "runtime-one" }))).toEqual({
    responses: [{ ...header, dispatchBefore: null }], nextSequence: 1, hasMore: false,
  });
  expect(unwrap(await listFeedResponseDeliveries(responses, { recipient: "unmapped-runtime" }))).toEqual({
    responses: [], nextSequence: 1, hasMore: false,
  });
  expect(unwrap(await responses.query<string>("SELECT source_json FROM feed_response_origins")).rows.map((row) => JSON.parse(row[0]))).toEqual([origin()]);
}

for (const stage of ["card", "batch"] as const) {
  for (const mode of ["sql", "permission"] as const) {
    test(`completed ${stage} ${mode} failure outranks coincident caller abort without leaking diagnostics`, async () => {
      const f = await transportFixture(stage, mode);
      const result = await restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
      const code = mode === "sql" ? ErrorCodes.SQL_ERROR : ErrorCodes.SQL_PERMISSION_DENIED;
      const status = mode === "sql" ? 400 : 403;
      expect(f.abort.signal.aborted).toBe(true);
      expect(f.completedStatuses).toEqual([status]);
      // Establish the real SQLService classification independently of restore.
      expect(f.ordinary).toEqual([expect.objectContaining({
        service: "sql", error: expect.objectContaining({ code, meta: { status } }),
      })]);
      expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
      await expectAbsent(f.responses);
      expect(result).toMatchObject({ ok: false, error: { code } });
    });
  }

  test(`a completed successful ${stage} result after abort remains ABORTED`, async () => {
    const f = await transportFixture(stage, "late-success");
    const result = await restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.completedStatuses).toEqual([200]);
    expect(f.ordinary).toEqual([]);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
    if (stage === "card") await expectAbsent(f.responses);
    else {
      // Cancellation after a committed batch is not proof of rollback. An explicit
      // same-ID replay verifies the durable import instead of duplicating it.
      await expectOneCompleteImport(f.responses);
      unwrap(await restoreFeedRecords(f.pair, records()));
      await expectOneCompleteImport(f.responses);
    }
  });

  test(`caller cancellation of a genuinely pending ${stage} HTTP request remains ABORTED`, async () => {
    const f = await transportFixture(stage, "pending");
    const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    await f.arrived;
    f.abort.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
    expect(f.ordinary).toEqual([expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.ABORTED }),
    })]);
    expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
    f.release();
    if (stage === "card") await expectAbsent(f.responses);
    else await expectOneCompleteImport(f.responses);
  });
}

test("a failed redundant batch recovers through complete readback of an independent identical commit", async () => {
  const f = await transportFixture("batch", "recover");
  const result = await restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
  expect(f.abort.signal.aborted).toBe(false);
  expect(f.completedStatuses).toEqual([400]);
  expect(f.ordinary).toEqual([expect.objectContaining({
    service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
  })]);
  expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
  expect(result).toEqual({ ok: true, data: undefined });
  await expectOneCompleteImport(f.responses);
  unwrap(await f.responses.execute("DROP TRIGGER fail_restore_error_race"));
  unwrap(await restoreFeedRecords(f.pair, records()));
  await expectOneCompleteImport(f.responses);
});

test("completed batch failure remains SQL_ERROR when abort preempts verification of a concurrent identical commit", async () => {
  const f = await transportFixture("batch", "recover-abort");
  const result = await restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
  expect(f.abort.signal.aborted).toBe(true);
  expect(f.completedStatuses).toEqual([400]);
  expect(f.ordinary).toEqual([expect.objectContaining({
    service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
  })]);
  expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
  await expectOneCompleteImport(f.responses);
  expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
});
