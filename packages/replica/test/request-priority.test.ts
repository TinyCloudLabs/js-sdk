import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ServiceContext } from "@tinycloud/sdk-services/context";
import { readSql, syncPrefixes } from "./browser/request-priority.fixture";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function browserFixture(entrypoint: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sdk-priority-browser-"));
  try {
    const output = join(directory, "fixture.js");
    // Isolate Bun 1.3's bundler from imported workspace files in the test VM (oven-sh/bun#11123).
    execFileSync(process.execPath, ["build", entrypoint, "--target=browser", `--outfile=${output}`], {
      timeout: 10_000,
      stdio: "pipe",
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
  test("Chromium pauses sibling background workers on busy while foreground SQL proceeds", async () => {
    const fixture = browserFixture(`${import.meta.dir}/browser/request-priority.fixture.ts`);
    const worker = browserFixture(`${import.meta.dir}/browser/request-priority-busy.worker.ts`);
    const firstBackground = Promise.withResolvers<void>();
    const backgroundStarts: number[] = [];
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js") return new Response(fixture, { headers: { "content-type": "text/javascript" } });
        if (path === "/worker.js") return new Response(worker, { headers: { "content-type": "text/javascript" } });
        if (path === "/background") {
          backgroundStarts.push(performance.now());
          firstBackground.resolve();
          return backgroundStarts.length === 1
            ? new Response("unavailable_retryable", { status: 503, headers: { "retry-after": "1" } })
            : new Response("ready");
        }
        if (path === "/invoke") {
          await sleep(80);
          return Response.json({ columns: ["1"], rows: [[1]], rowCount: 1 });
        }
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
      const background = page.evaluate(() => Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
        const worker = new Worker("/worker.js", { type: "module" });
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data === "done") resolve();
          else reject(new Error(data));
        };
        worker.postMessage(location.origin);
      }))));
      await firstBackground.promise;
      const loaded = await page.evaluate(() => (window as any).readSql(location.origin));
      await background;
      expect(loaded).toBeLessThanOrEqual(idle * 1.5);
      expect(backgroundStarts).toHaveLength(2);
      expect(backgroundStarts[1]! - backgroundStarts[0]!).toBeGreaterThanOrEqual(990);
    } finally {
      await browser.close();
      app.stop(true);
    }
  }, 15_000);

  test("Chromium shares foreground priority between the page and two replica workers", async () => {
    const fixture = browserFixture(`${import.meta.dir}/browser/request-priority.fixture.ts`);
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
