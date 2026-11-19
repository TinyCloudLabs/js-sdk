import { expect, test } from "bun:test";
import { backgroundFetch } from "./backgroundFetch";
import { dispatchRequest } from "./requestPriority";
import { withDeadline } from "./resolvedDispatch";

// Real time on purpose: these bounds combine performance.now(), AbortSignal.timeout() and timers, and the pinned CI
// runtime is not relied on to fake all three consistently.

test("steady foreground traffic delays a background request by a bounded time", async () => {
  const host = "https://aging-lanes.invalid";
  let stop = false;
  // Each foreground completion opens a new 400 ms quiet window before the previous one closes.
  const traffic = (async () => {
    while (!stop) {
      const response = await dispatchRequest(`${host}/foreground`, { signal: new AbortController().signal }, "foreground",
        async () => new Response("foreground"));
      await response.text();
      await Bun.sleep(100);
    }
  })();
  const started = performance.now();
  try {
    const response = await backgroundFetch(async () => new Response("synced"))(`${host}/background`);
    expect(await response.text()).toBe("synced");
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4_500);
    expect(waited).toBeLessThan(7_000);
  } finally {
    stop = true;
    await traffic;
  }
}, 15_000);

test("an abandoned background response stops holding its lane", async () => {
  const host = "https://abandoned-lane.invalid";
  const fetch = backgroundFetch(async (url) => url.endsWith("/abandoned")
    ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } }))
    : new Response("next"));
  const abandoned = await fetch(`${host}/abandoned`);
  const started = performance.now();
  try {
    const next = await fetch(`${host}/next`, { signal: AbortSignal.timeout(20_000) });
    expect(await next.text()).toBe("next");
    expect(performance.now() - started).toBeGreaterThanOrEqual(14_000);
  } finally {
    await abandoned.body?.cancel();
  }
}, 25_000);

test("a request deadline starts when its lane dispatches it", async () => {
  const host = "https://deadline-at-grant.invalid";
  const fetch = backgroundFetch(async (url, init) => {
    if (url.endsWith("/held")) return new Response("held");
    await Bun.sleep(100);
    init!.signal!.throwIfAborted();
    return new Response("in time");
  });
  const held = await fetch(`${host}/held`);
  const waiting = fetch(`${host}/waiting`, withDeadline(fetch, {}, 300));
  // The unread reply keeps the background lane for longer than the waiting request's deadline.
  await Bun.sleep(600);
  await held.text();
  expect(await (await waiting).text()).toBe("in time");
});

test("a request deadline still bounds the exchange after dispatch", async () => {
  const host = "https://deadline-exchange.invalid";
  const fetch = backgroundFetch(async (_url, init) => {
    await Bun.sleep(1_000);
    init!.signal!.throwIfAborted();
    return new Response("late");
  });
  const started = performance.now();
  await expect(fetch(`${host}/slow`, withDeadline(fetch, {}, 200))).rejects.toMatchObject({ name: "TimeoutError" });
  expect(performance.now() - started).toBeLessThan(1_000);
});
