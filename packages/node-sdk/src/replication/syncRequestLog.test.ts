import { expect, test } from "bun:test";
import { RequestLog, type RequestEvent } from "@tinycloud/sdk-services/telemetry/requestLog";
import { recordingInfoFetch, syncRequestSink } from "./syncRequestLog";

const HOST = "https://node.example";
const SECRET_KEY = "private/inbox/secret-key-material";

function okResponse(status = 200): Response {
  return new Response("{}", { status });
}

test("sync relabel keeps op, host and outcome, and drops path and space", () => {
  const log = new RequestLog();
  const sink = syncRequestSink(log);
  sink.record({
    v: 1,
    at: 1,
    service: "kv",
    op: "kv/get",
    path: SECRET_KEY,
    space: "work",
    host: "node.example",
    bytes: 12,
    durationMs: 3,
    attempts: 2,
    ok: false,
    code: "HTTP_503",
    source: "network",
  });
  const [row] = log.snapshot();
  expect(row).toMatchObject({
    service: "sync",
    op: "kv/get",
    path: null,
    space: null,
    host: "node.example",
    bytes: 12,
    attempts: 2,
    ok: false,
    code: "HTTP_503",
  });
});

test("info probe records one sync row per successful attempt with host only", async () => {
  const log = new RequestLog();
  const fetched: string[] = [];
  const wrapped = recordingInfoFetch(async (input) => {
    fetched.push(String(input));
    return okResponse(200);
  }, log);

  const response = await wrapped(`${HOST}/info`);
  expect(response.status).toBe(200);
  expect(fetched).toEqual([`${HOST}/info`]);

  const rows: RequestEvent[] = log.snapshot();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    service: "sync",
    op: "sync/info",
    path: null,
    space: null,
    host: "node.example",
    bytes: null,
    attempts: 1,
    ok: true,
    code: "ok",
    source: "network",
  });
});

test("info probe maps a failing status to HTTP_<status> and returns the response unchanged", async () => {
  const log = new RequestLog();
  const original = okResponse(503);
  const wrapped = recordingInfoFetch(async () => original, log);

  const response = await wrapped(`${HOST}/info`);
  expect(response).toBe(original);
  expect(log.snapshot()[0]).toMatchObject({ ok: false, code: "HTTP_503", host: "node.example" });
});

test("info probe records ERROR and rethrows when the network call throws", async () => {
  const log = new RequestLog();
  const failure = new TypeError("fetch failed");
  const wrapped = recordingInfoFetch(async () => {
    throw failure;
  }, log);

  await expect(wrapped(new URL(`${HOST}/info`))).rejects.toBe(failure);
  expect(log.snapshot()).toHaveLength(1);
  expect(log.snapshot()[0]).toMatchObject({ service: "sync", ok: false, code: "ERROR", host: "node.example" });
});

test("sync rows never carry key or prefix text in any field", async () => {
  const log = new RequestLog();
  syncRequestSink(log).record({
    v: 1,
    at: 1,
    service: "kv",
    op: "kv/list",
    path: SECRET_KEY,
    space: "work",
    host: "node.example",
    bytes: null,
    durationMs: 1,
    attempts: 1,
    ok: true,
    code: "ok",
    source: "network",
  });
  await recordingInfoFetch(async () => okResponse(200), log)(`${HOST}/info`);

  const serialized = JSON.stringify(log.snapshot());
  expect(serialized).not.toContain("secret-key-material");
  expect(serialized).not.toContain("private/inbox");
  expect(log.snapshot().every((row) => row.service === "sync")).toBe(true);
});
