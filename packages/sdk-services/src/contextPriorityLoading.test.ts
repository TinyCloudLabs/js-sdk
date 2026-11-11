import { expect, test } from "bun:test";
import { ServiceContext } from "./context";

test.each(["foreground", "background"] as const)("%s dispatch rechecks retirement after loading its lane", async (priority) => {
  let sends = 0;
  const context = new ServiceContext({
    hosts: ["https://retired-lane.invalid"],
    priority,
    invoke: () => ({}),
    fetch: async () => { sends++; return new Response("ok"); },
  });
  const pending = context.fetch("https://retired-lane.invalid/invoke");
  context.retire();
  await expect(pending).rejects.toThrow("retired");
  expect(sends).toBe(0);
});

test("foreground dispatch forwards an aborted signal to a custom transport", async () => {
  let received: AbortSignal | undefined;
  const context = new ServiceContext({
    hosts: ["https://aborted-lane.invalid"],
    invoke: () => ({}),
    fetch: async (_url, init) => { received = init!.signal; return new Response("ok"); },
  });
  const abort = new AbortController();
  const reason = new Error("Cancelled before dispatch");
  const pending = context.fetch("https://aborted-lane.invalid/invoke", { signal: abort.signal });
  abort.abort(reason);
  await pending;
  expect(received?.reason).toBe(reason);
});

test("background dispatch preserves an abort while loading its lane", async () => {
  let sends = 0;
  const context = new ServiceContext({
    hosts: ["https://aborted-background-lane.invalid"],
    priority: "background",
    invoke: () => ({}),
    fetch: async () => { sends++; return new Response("ok"); },
  });
  const abort = new AbortController();
  const reason = new Error("Cancelled before dispatch");
  const pending = context.fetch("https://aborted-background-lane.invalid/invoke", { signal: abort.signal });
  abort.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(sends).toBe(0);
});

test("a foreground retry cannot sign after its graph retires during lane loading", async () => {
  let builds = 0;
  const context = new ServiceContext({ hosts: ["https://retired-retry.invalid"], invoke: () => ({}) });
  const pending = context.invokeWithRetry("https://retired-retry.invalid/invoke", () => {
    builds++;
    return { method: "POST" };
  });
  context.retire();
  await expect(pending).rejects.toThrow("retired");
  expect(builds).toBe(0);
});


test.each(["foreground", "background"] as const)("%s invocation keeps the pre-load context abort signal", async (priority) => {
  let builds = 0;
  let sends = 0;
  const context = new ServiceContext({
    hosts: ["https://context-abort-lane.invalid"],
    priority,
    invoke: () => ({}),
    fetch: async () => { sends++; return new Response("ok"); },
  });
  const signal = context.abortSignal;
  const pending = context.invokeWithRetry("https://context-abort-lane.invalid/invoke", () => {
    builds++;
    return { method: "POST" };
  });
  context.abort();
  await expect(pending).rejects.toBe(signal.reason);
  expect(builds).toBe(0);
  expect(sends).toBe(0);
  expect(context.abortSignal.aborted).toBe(false);
});
