import { expect, test } from "bun:test";
import { backgroundFetch } from "./requestPriority";
import { verifyResourceDestination } from "./resourceRouting";

test("background identity checks consume fragmented info before requesting node keys", async () => {
  const target = { url: "https://fragmented-metadata.invalid", nodeDid: "did:key:metadata" };
  const abort = new AbortController();
  const requests: string[] = [];
  const chunks = ['{"nodeId":', '"did:key:', 'metadata"}'];
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  const fetch = backgroundFetch(async (url) => {
    requests.push(url);
    return url.endsWith("/info")
      ? new Response(body)
      : Response.json({ nodeDid: target.nodeDid });
  });
  const checked = verifyResourceDestination(target, (url, init) => fetch(url, {
    ...init,
    signal: AbortSignal.any([abort.signal, init!.signal!]),
  }));
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Fragmented metadata blocked the background lane")), 500);
  });
  try {
    await expect(Promise.race([checked, deadline])).resolves.toEqual({ nodeId: target.nodeDid });
    expect(requests).toEqual([`${target.url}/info`, `${target.url}/.well-known/tinycloud/node-keys`]);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    streamController.error(abort.signal.reason);
    await checked.catch(() => undefined);
  }
});

test.each([
  { statuses: [403, 500], code: "NODE_NOT_RESPONDING" },
  { statuses: [500, 403], code: "NODE_NOT_RESPONDING" },
  { statuses: [403, 200], code: "NODE_IDENTITY_MISMATCH" },
  { statuses: [200, 403], code: "NODE_IDENTITY_MISMATCH" },
])("background metadata preserves status precedence for $statuses", async ({ statuses, code }) => {
  const target = { url: `https://metadata-${statuses.join("-")}.invalid`, nodeDid: "did:key:metadata" };
  let index = 0;
  const fetch = backgroundFetch(async () => new Response("invalid JSON", { status: statuses[index++] }));
  await expect(verifyResourceDestination(target, fetch)).rejects.toMatchObject({ code });
  expect(index).toBe(2);
});

test("background metadata rejects a malformed successful body", async () => {
  const target = { url: "https://malformed-metadata.invalid", nodeDid: "did:key:metadata" };
  const fetch = backgroundFetch(async (url) => url.endsWith("/info")
    ? new Response("invalid JSON")
    : Response.json({ nodeDid: target.nodeDid }));
  await expect(verifyResourceDestination(target, fetch)).rejects.toMatchObject({ code: "NODE_IDENTITY_MISMATCH" });
});
