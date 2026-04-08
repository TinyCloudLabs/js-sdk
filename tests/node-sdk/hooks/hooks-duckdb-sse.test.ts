import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import { installFetchMetrics, sleep, waitFor } from "./hooks-test-utils";

const STAMP = Date.now();
const DB_NAME = `phase2_duck_${STAMP}`;
const TABLE_NAME = `phase2_duck_items_${STAMP}`;

describe("DuckDB hooks SSE", () => {
  let alice: TinyCloudNode;
  let restoreFetch: (() => void) | undefined;
  let metrics: ReturnType<typeof installFetchMetrics>["metrics"];

  beforeAll(async () => {
    await checkServerHealth();
    ({ restoreFetch, metrics } = installFetchMetrics());
    alice = createClient("alice-hooks-duckdb", TEST_KEY);
    await alice.signIn();
    await alice.duckdb
      .db(DB_NAME)
      .execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
  });

  afterAll(async () => {
    restoreFetch?.();
    await alice.duckdb
      .db(DB_NAME)
      .execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
  });

  test("delivers named DuckDB database writes on the hooks stream", async () => {
    const abort = new AbortController();
    const stream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "duckdb",
            pathPrefix: DB_NAME,
            abilities: ["tinycloud.duckdb/write"],
          },
        ],
        { signal: abort.signal },
      )
      [Symbol.asyncIterator]();

    const nextEvent = stream.next();
    await waitFor(() => metrics.activeStreams === 1);

    const createResult = await alice.duckdb
      .db(DB_NAME)
      .execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, label VARCHAR)`,
      );
    expect(createResult.ok).toBe(true);

    const event = await nextEvent;
    abort.abort();
    await waitFor(() => metrics.activeStreams === 0);

    expect(event.done).toBe(false);
    if (!event.done) {
      expect(event.value.type).toBe("write");
      expect(event.value.service).toBe("duckdb");
      expect(event.value.ability).toBe("tinycloud.duckdb/write");
      expect(event.value.space).toBe(alice.spaceId);
      expect(event.value.path).toBe(`${DB_NAME}/${TABLE_NAME}`);
    }
  }, 30000);

  test("filters DuckDB hook delivery by path", async () => {
    const seedResult = await alice.duckdb
      .db(DB_NAME)
      .execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, label VARCHAR)`,
      );
    expect(seedResult.ok).toBe(true);

    const pathAbort = new AbortController();
    const pathStream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "duckdb",
            pathPrefix: `${DB_NAME}/missing`,
            abilities: ["tinycloud.duckdb/write"],
          },
        ],
        { signal: pathAbort.signal },
      )
      [Symbol.asyncIterator]();
    const pathNext = pathStream.next();
    await waitFor(() => metrics.activeStreams === 1);

    const updateResult = await alice.duckdb
      .db(DB_NAME)
      .execute(
        `INSERT INTO ${TABLE_NAME} (id, label) VALUES (1, 'duck-write')`,
      );
    expect(updateResult.ok).toBe(true);

    await sleep(250);
    pathAbort.abort();
    const pathResult = await pathNext;
    expect(pathResult.done).toBe(true);
    await waitFor(() => metrics.activeStreams === 0);

    const secondPathAbort = new AbortController();
    const secondPathStream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "duckdb",
            pathPrefix: `${DB_NAME}/other`,
            abilities: ["tinycloud.duckdb/write"],
          },
        ],
        { signal: secondPathAbort.signal },
      )
      [Symbol.asyncIterator]();
    const secondPathNext = secondPathStream.next();

    const secondWriteResult = await alice.duckdb
      .db(DB_NAME)
      .execute(
        `INSERT INTO ${TABLE_NAME} (id, label) VALUES (2, 'duck-path-filter')`,
      );
    expect(secondWriteResult.ok).toBe(true);

    await sleep(250);
    secondPathAbort.abort();
    const secondPathResult = await secondPathNext;
    expect(secondPathResult.done).toBe(true);
    await waitFor(() => metrics.activeStreams === 0);
  }, 30000);
});
