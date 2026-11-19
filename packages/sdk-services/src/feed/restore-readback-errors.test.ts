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
  pendingPolicy, privateMarker, restoredCard, restoredHeader,
  restoredPayload, restoredRecord, restoreFixture,
} from "./restore.test-helper";
import type { FeedDatabase } from "./types";

type Stage = "header" | "metadata";
type Batch = "sql" | "permission" | "success";
type Readback = "native" | "late-success" | "permission";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const records = () => ({ cards: [], responses: [restoredRecord({ deliveries: [pendingPolicy()] })] });

async function readbackFixture(stage: Stage, batch: Batch, readback: Readback) {
  const disk = await restoreFixture();
  cleanup.push(disk.close);
  unwrap(await publishFeedCard(disk.output, restoredCard));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  let batchStarted = false;
  let readbackQueries = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      try {
        const body = await request.json();
        const database = request.headers.get("X-Fixture-Database");
        const handle = database === "fixture-output" ? disk.output
          : database === "fixture-responses" ? disk.responses : undefined;
        if (!handle) throw new Error("Unknown fixture database");
        if (body.action === "batch") {
          batchStarted = true;
          if (batch !== "success") {
            // The caller's pre-read saw absence. Another owner commits matching
            // content and authority through a separate real SQLite connection.
            unwrap(await restoreFeedRecords({ output: disk.output, responses: disk.otherResponses() }, records()));
          }
          if (batch === "permission") {
            // Actual loopback HTTP denial, not a claim about Node authorization.
            return Response.json({ error: `Denied fixture batch: ${privateMarker}`, cause: { value: privateMarker } }, { status: 403 });
          }
          if (batch === "sql") {
            unwrap(await disk.responses.execute(`CREATE TRIGGER fail_readback_batch BEFORE INSERT ON feed_response_origins
              BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`));
          }
          return Response.json(unwrap(await handle.batch(body.statements)));
        }
        if (batchStarted && database === "fixture-responses") readbackQueries += 1;
        const atGate = batchStarted && database === "fixture-responses" &&
          readbackQueries === (stage === "header" ? 1 : 2);
        const headers = atGate ? { "X-Fixture-Readback": stage } : {};
        if (atGate && readback === "permission") {
          arrived.resolve();
          await release.promise;
          return Response.json({ error: `Denied fixture readback: ${privateMarker}`, meta: { privateValue: privateMarker } }, {
            status: 403, headers,
          });
        }
        const result = unwrap(await handle.query(body.sql, body.params));
        if (atGate) {
          arrived.resolve();
          await release.promise;
        }
        return Response.json(result, { headers });
      } catch (error) {
        return Response.json({
          error: `${privateMarker}: ${String(error)}`,
          cause: { privatePayload: { code: privateMarker } }, meta: { value: privateMarker },
        }, { status: 400 });
      }
    },
  });
  cleanup.push(async () => { abort.abort(); release.resolve(); await server.stop(true); });
  const detachedFetch: FetchFunction = async (url, options) => {
    const wire = await globalThis.fetch(url, { ...options, signal: undefined });
    const detached = new Response(await wire.arrayBuffer(), {
      status: wire.status, statusText: wire.statusText, headers: wire.headers,
    });
    if (wire.headers.get("X-Fixture-Readback") === stage) abort.abort();
    return detached;
  };
  const context = new ServiceContext({
    invoke: (_session, _service, path) => ({ Authorization: "test-invocation", "X-Fixture-Database": path }),
    hosts: [server.url.href], fetch: readback === "native" ? undefined : detachedFetch,
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
    abort, ordinary, arrived: arrived.promise, release: () => release.resolve(),
  };
}

function batchErrorEvent(batch: "sql" | "permission") {
  return expect.objectContaining({
    service: "sql", error: expect.objectContaining({
      code: batch === "sql" ? ErrorCodes.SQL_ERROR : ErrorCodes.SQL_PERMISSION_DENIED,
      meta: { status: batch === "sql" ? 400 : 403 },
    }),
  });
}

async function expectCompleteImport(responses: FeedDatabase) {
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
}

for (const stage of ["header", "metadata"] as const) {
  for (const batch of ["sql", "permission"] as const) {
    test(`completed ${batch} batch failure survives cancellation during native ${stage} readback`, async () => {
      const f = await readbackFixture(stage, batch, "native");
      const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
      await f.arrived;
      // The batch error is already classified and observed while the caller is live.
      expect(f.abort.signal.aborted).toBe(false);
      expect(f.ordinary).toEqual([batchErrorEvent(batch)]);
      f.abort.abort();
      const result = await pending;
      expect(f.ordinary).toEqual([batchErrorEvent(batch), expect.objectContaining({
        service: "sql", error: expect.objectContaining({ code: ErrorCodes.ABORTED }),
      })]);
      expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
      await expectCompleteImport(f.responses);
      expect(result).toMatchObject({
        ok: false, error: { code: batch === "sql" ? ErrorCodes.SQL_ERROR : ErrorCodes.SQL_PERMISSION_DENIED },
      });
    });
  }

  test(`completed batch SQL_ERROR survives a successful ${stage} readback arriving after abort`, async () => {
    const f = await readbackFixture(stage, "sql", "late-success");
    const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    await f.arrived;
    expect(f.abort.signal.aborted).toBe(false);
    expect(f.ordinary).toEqual([batchErrorEvent("sql")]);
    f.release();
    const result = await pending;
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.ordinary).toEqual([batchErrorEvent("sql")]);
    expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
    await expectCompleteImport(f.responses);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
  });

  test(`successful batch plus successful late ${stage} readback remains genuine ABORTED`, async () => {
    const f = await readbackFixture(stage, "success", "late-success");
    const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    await f.arrived;
    expect(f.abort.signal.aborted).toBe(false);
    expect(f.ordinary).toEqual([]);
    f.release();
    const result = await pending;
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.ordinary).toEqual([]);
    expect(inspect(result, { depth: 20 })).not.toContain(privateMarker);
    await expectCompleteImport(f.responses);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.ABORTED } });
  });

  test(`complete ${stage} readback recovers an identical concurrent commit despite a failed batch`, async () => {
    const f = await readbackFixture(stage, "sql", "native");
    const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    await f.arrived;
    expect(f.abort.signal.aborted).toBe(false);
    expect(f.ordinary).toEqual([batchErrorEvent("sql")]);
    f.release();
    const result = await pending;
    expect(result).toEqual({ ok: true, data: undefined });
    expect(f.abort.signal.aborted).toBe(false);
    expect(f.ordinary).toEqual([batchErrorEvent("sql")]);
    expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
    await expectCompleteImport(f.responses);
  });

  test(`an unrelated ${stage} readback permission failure is not replaced by the earlier batch SQL_ERROR`, async () => {
    const f = await readbackFixture(stage, "sql", "permission");
    const pending = restoreFeedRecords(f.pair, records(), { signal: f.abort.signal });
    await f.arrived;
    expect(f.abort.signal.aborted).toBe(false);
    expect(f.ordinary).toEqual([batchErrorEvent("sql")]);
    f.release();
    const result = await pending;
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.ordinary).toEqual([batchErrorEvent("sql"), expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_PERMISSION_DENIED, meta: { status: 403 } }),
    })]);
    expect(inspect({ result, ordinary: f.ordinary }, { depth: 20 })).not.toContain(privateMarker);
    await expectCompleteImport(f.responses);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_PERMISSION_DENIED } });
  });
}
