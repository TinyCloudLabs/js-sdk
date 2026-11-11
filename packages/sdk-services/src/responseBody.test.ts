import { expect, jest, test } from "bun:test";
import { usingResponse } from "./responseBody";
import { ServiceContext } from "./context";

const gate = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
};
function finite(status = 403) {
  let cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i])); controller.close(); },
    cancel() { cancelled++; },
  }), { status });
  return { response, cancelled: () => cancelled };
}
for (const exit of ["return", "throw", "reader", "partial-reader", "prepared-transfer-throw"] as const) {
  test(`ownership finally releases a body on ${exit}`, async () => {
    const fixture = finite(); const original = new Error("consumer failed");
    const pending = usingResponse(async () => fixture.response, async (response, transfer) => {
      if (exit === "throw") throw original;
      if (exit === "reader" || exit === "partial-reader") {
        const reader = response.body!.getReader();
        if (exit === "partial-reader") await reader.read();
        throw original;
      }
      if (exit === "prepared-transfer-throw") { transfer({ response }); throw original; }
      return response.status;
    });
    if (exit === "return") expect(await pending).toBe(403);
    else await expect(pending).rejects.toBe(original);
    expect(fixture.cancelled()).toBe(1);
    expect(fixture.response.body!.locked).toBe(false);
  });
}
test("ownership preserves an exact returned response and body identity", async () => {
  const first = finite(200);
  expect(await usingResponse(async () => first.response, (response) => response)).toBe(first.response);
  expect(first.cancelled()).toBe(0); await first.response.body!.cancel();
  const second = finite(200);
  expect(await usingResponse(async () => second.response, (response) => response.body)).toBe(second.response.body);
  expect(second.cancelled()).toBe(0); await second.response.body!.cancel();
});
test("explicit body adoption stays readable by its caller", async () => {
  const fixture = finite(200);
  const adopted = await usingResponse(async () => fixture.response, (response, transfer) => transfer({
    response: new Response(transfer(response.body), { status: response.status }),
  }));
  expect(fixture.cancelled()).toBe(0);
  expect((await adopted.response.arrayBuffer()).byteLength).toBe(20);
});
test("a late acquired custom response is cleaned after the caller has aborted", async () => {
  const ready = gate(); const entered = gate(); const controller = new AbortController(); const fixture = finite();
  const pending = usingResponse(async () => { entered.resolve(); await ready.promise; return fixture.response; }, (response) => {
    controller.signal.throwIfAborted(); return response.status;
  });
  const observed = pending.catch((error) => error);
  await entered.promise; const reason = new Error("replaced"); controller.abort(reason); ready.resolve();
  expect(await observed).toBe(reason); expect(fixture.cancelled()).toBe(1);
});
test("the fake-time harness drains ownership continuations before advancing its clock", async () => {
  const reply = (status: number) => ({ ok: status === 200, status, statusText: "", headers: { get: () => null },
    json: async () => ({}), text: async () => status === 503 ? "sql_busy: begin: database is locked" : "ok",
    blob: async () => new Blob(), arrayBuffer: async () => new ArrayBuffer(0), clone() { return this; } });
  await new ServiceContext({ hosts: ["https://continuation-control.invalid"], invoke: () => ({}), fetch: async () => reply(200) }).fetch("https://continuation-control.invalid/ready");
  jest.useFakeTimers(); const random = Math.random; Math.random = () => 0.5;
  const calls: number[] = [];
  const context = new ServiceContext({ hosts: ["https://continuation-control.invalid"], invoke: () => ({}), fetch: async () => {
    calls.push(Date.now()); return reply(calls.length === 1 ? 503 : 200);
  } });
  const pending = context.invokeWithRetry("https://continuation-control.invalid/invoke", () => ({ method: "POST" }));
  const settled = pending.catch((error) => error);
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try {
    await flush();
    if (jest.getTimerCount() !== 1) throw new Error("Ownership/retry continuations exceeded the approved 40-turn flush; fake time must not advance yet");
    jest.advanceTimersByTime(124); await flush(); expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(1); await flush();
    if (calls.length !== 2) throw new Error("Retry continuations exceeded the approved 40-turn flush at the exact deadline");
    expect((await settled).status).toBe(200);
    expect(calls.map((time) => time - calls[0]!)).toEqual([0, 125]);
  } finally { context.retire(); Math.random = random; jest.useRealTimers(); }
});

test("frozen structural responses keep their body methods and single cleanup", async () => {
  let reads = 0; let cancelled = 0;
  const response = Object.freeze({ ok: false, status: 403, statusText: "", headers: { get: () => null },
    body: Object.freeze({ cancel: async () => { cancelled++; } }),
    text: async () => { reads++; return "denied"; }, json: async () => ({}),
    blob: async () => new Blob(), arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(await usingResponse(async () => response, (owned) => owned.text())).toBe("denied");
  expect(reads).toBe(1); expect(cancelled).toBe(0);
  await usingResponse(async () => response, (owned) => owned.status);
  expect(cancelled).toBe(1);
});

test("a clone read does not detach the body subsequently handed to its caller", async () => {
  const response = new Response("sql_busy: begin: database is locked", { status: 503 });
  const body = await usingResponse(async () => response, async (owned) => {
    expect(await usingResponse(async () => owned.clone(), (clone) => clone.text())).toBe("sql_busy: begin: database is locked");
    return owned.body;
  });
  expect(await new Response(body).text()).toBe("sql_busy: begin: database is locked");
});
