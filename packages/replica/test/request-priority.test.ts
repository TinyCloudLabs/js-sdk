import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { ServiceContext } from "@tinycloud/sdk-services/context";
import { readSql, syncPrefixes } from "./browser/request-priority.fixture";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function startNode() {
  const firstReplica = Promise.withResolvers<void>();
  const releaseReplica = Promise.withResolvers<void>();
  const replicaStarts: number[] = [];
  let foregroundFinishedAt = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("x-fixture-op") === "sql") {
        await sleep(80);
        foregroundFinishedAt = performance.now();
        return Response.json({ columns: ["1"], rows: [[1]], rowCount: 1 });
      }
      const prefix = request.headers.get("x-fixture-prefix");
      if (!prefix) return new Response("missing fixture prefix", { status: 400 });
      replicaStarts.push(performance.now());
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      if (replicaStarts.length === 1) {
        firstReplica.resolve();
        await releaseReplica.promise;
      }
      await sleep(15);
      inFlight--;
      return Response.json({
        changes: [], more: false, cursor: "cursor",
        source: { nodeDid: "did:key:fixture", space: "fixture", prefix },
        authority: { notBefore: null, expiresAt: null, retainUntil: null },
      });
    },
  });
  return {
    server, host: server.url.origin, firstReplica: firstReplica.promise, releaseReplica: releaseReplica.resolve,
    verify(idle: number, loaded: number) {
      expect(loaded).toBeLessThanOrEqual(idle * 1.5);
      expect(maxInFlight).toBe(1);
      expect(replicaStarts).toHaveLength(8);
      expect(replicaStarts[1]! - foregroundFinishedAt).toBeGreaterThanOrEqual(400);
    },
  };
}

test("Node gives a foreground SQL read priority during an eight-prefix sync", async () => {
  const node = startNode();
  try {
    const idle = await readSql(node.host);
    const sync = syncPrefixes(node.host);
    await node.firstReplica;
    const loaded = await readSql(node.host);
    node.releaseReplica();
    await sync;
    node.verify(idle, loaded);
  } finally {
    node.releaseReplica();
    node.server.stop(true);
  }
}, 10_000);

test("a busy reply pauses other background contexts and bounds foreground retry", async () => {
  const host = "https://priority-busy.fixture";
  const busy = () => new Response("unavailable_retryable", { status: 503, headers: { "retry-after": "5" } });
  const foreground = new ServiceContext({
    hosts: [host], invoke: () => ({}), fetch: async () => busy(),
    retryPolicy: { foregroundBusyMaxTotalMs: 4_000 },
  });
  const started = performance.now();
  const response = await foreground.invokeWithRetry(`${host}/invoke`, () => ({ method: "POST" }));
  expect(response.retry?.attempts).toBe(1);
  expect(performance.now() - started).toBeLessThan(4_000);

  const backgroundHost = "https://priority-background-busy.fixture";
  const context = new ServiceContext({
    hosts: [backgroundHost], invoke: () => ({}), priority: "background",
    fetch: async (_url, init) => {
      expect(init?.priority).toBe("low");
      return new Response("unavailable_retryable", { status: 503, headers: { "retry-after": "1" } });
    },
  });
  const queued = new ServiceContext({
    hosts: [backgroundHost], invoke: () => ({}), priority: "background",
    fetch: async () => new Response("ok"),
  });
  await context.fetch(`${backgroundHost}/invoke`);
  const pausedAt = performance.now();
  await queued.fetch(`${backgroundHost}/invoke`);
  expect(performance.now() - pausedAt).toBeGreaterThanOrEqual(990);
});

test("background concurrency includes streamed response bodies", async () => {
  const host = "https://priority-stream.fixture";
  let finish!: () => void;
  const first = new ServiceContext({
    hosts: [host], invoke: () => ({}), priority: "background",
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finish = () => controller.close();
      },
    })),
  });
  let secondStarted = false;
  const second = new ServiceContext({
    hosts: [host], invoke: () => ({}), priority: "background",
    fetch: async () => { secondStarted = true; return new Response("second"); },
  });
  const response = await first.fetch(`${host}/invoke`);
  const controller = new AbortController();
  const queued = second.fetch(`${host}/invoke`, { signal: controller.signal });
  await sleep(30);
  expect(secondStarted).toBe(false);
  finish();
  expect(await response.text()).toBe("first");
  expect(await (await queued).text()).toBe("second");
});

if (process.env.TC_TEST_BROWSER_PRIORITY === "1") {
  test("Chromium shares foreground priority between the page and two replica workers", async () => {
    const build = await Bun.build({
      entrypoints: [`${import.meta.dir}/browser/request-priority.fixture.ts`],
      target: "browser",
    });
    expect(build.success).toBe(true);
    const fixture = await build.outputs[0]!.text();
    const node = startNode();
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js") return new Response(fixture, { headers: { "content-type": "text/javascript" } });
        if (path === "/invoke") return fetch(`${node.host}${path}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        return new Response(`<script type="module">import { readSql } from "/fixture.js"; window.readSql = readSql;</script>`, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(app.url.href);
      const idle = await page.evaluate(() => (window as any).readSql(location.origin));
      const sync = page.evaluate(() => Promise.all([0, 4].map((start) => new Promise<void>((resolve, reject) => {
        const worker = new Worker("/fixture.js", { type: "module" });
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          worker.terminate();
          if (data === "done") resolve();
          else reject(new Error(data));
        };
        worker.postMessage({ host: location.origin, start, count: 4 });
      }))));
      await node.firstReplica;
      const loaded = await page.evaluate(() => (window as any).readSql(location.origin));
      node.releaseReplica();
      await sync;
      node.verify(idle, loaded);
    } finally {
      node.releaseReplica();
      await browser.close();
      app.stop(true);
      node.server.stop(true);
    }
  }, 15_000);
}
