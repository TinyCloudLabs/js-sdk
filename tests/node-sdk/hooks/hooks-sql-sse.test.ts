import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import { installFetchMetrics, sleep, waitFor } from "./hooks-test-utils";

const STAMP = Date.now();
const DB_NAME = `phase2_sql_${STAMP}`;
const TABLE_NAME = `phase2_items_${STAMP}`;

describe("SQL hooks SSE", () => {
  let alice: TinyCloudNode;
  let bob: TinyCloudNode;
  let restoreFetch: (() => void) | undefined;
  let metrics: ReturnType<typeof installFetchMetrics>["metrics"];

  beforeAll(async () => {
    await checkServerHealth();
    ({ restoreFetch, metrics } = installFetchMetrics());
    alice = createClient("alice-hooks-sql", TEST_KEY);
    bob = createClient("bob-hooks-sql");
    await alice.signIn();
    await bob.signIn();
    await alice.sql.db(DB_NAME).execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
  });

  afterAll(async () => {
    restoreFetch?.();
    await alice.sql.db(DB_NAME).execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
  });

  test("delivers named SQL database writes on the hooks stream", async () => {
    const abort = new AbortController();
    const stream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "sql",
            pathPrefix: DB_NAME,
            abilities: ["tinycloud.sql/write"],
          },
        ],
        { signal: abort.signal },
      )
      [Symbol.asyncIterator]();

    const nextEvent = stream.next();
    await waitFor(() => metrics.activeStreams === 1);

    const createResult = await alice.sql
      .db(DB_NAME)
      .execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, label TEXT)`,
      );
    expect(createResult.ok).toBe(true);

    const event = await nextEvent;
    abort.abort();
    await waitFor(() => metrics.activeStreams === 0);

    expect(event.done).toBe(false);
    if (!event.done) {
      expect(event.value.type).toBe("write");
      expect(event.value.service).toBe("sql");
      expect(event.value.ability).toBe("tinycloud.sql/write");
      expect(event.value.space).toBe(alice.spaceId);
      expect(event.value.path).toBe(`${DB_NAME}/${TABLE_NAME}`);
    }
  }, 30000);

  test("filters SQL hook delivery by path", async () => {
    const seedResult = await alice.sql
      .db(DB_NAME)
      .execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, label TEXT)`,
      );
    expect(seedResult.ok).toBe(true);

    const pathAbort = new AbortController();
    const pathStream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "sql",
            pathPrefix: `${DB_NAME}/missing`,
            abilities: ["tinycloud.sql/write"],
          },
        ],
        { signal: pathAbort.signal },
      )
      [Symbol.asyncIterator]();
    const pathNext = pathStream.next();
    await waitFor(() => metrics.activeStreams === 1);

    const updateResult = await alice.sql
      .db(DB_NAME)
      .execute(
        `INSERT OR REPLACE INTO ${TABLE_NAME} (id, label) VALUES (1, 'sql-write')`,
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
            service: "sql",
            pathPrefix: `${DB_NAME}/other`,
            abilities: ["tinycloud.sql/write"],
          },
        ],
        { signal: secondPathAbort.signal },
      )
      [Symbol.asyncIterator]();
    const secondPathNext = secondPathStream.next();

    const secondWriteResult = await alice.sql
      .db(DB_NAME)
      .execute(
        `INSERT OR REPLACE INTO ${TABLE_NAME} (id, label) VALUES (2, 'sql-path-filter')`,
      );
    expect(secondWriteResult.ok).toBe(true);

    await sleep(250);
    secondPathAbort.abort();
    const secondPathResult = await secondPathNext;
    expect(secondPathResult.done).toBe(true);
    await waitFor(() => metrics.activeStreams === 0);
  }, 30000);

  test("allows a delegated writer to trigger SQL hook events", async () => {
    const seedResult = await alice.sql
      .db(DB_NAME)
      .execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, label TEXT)`,
      );
    expect(seedResult.ok).toBe(true);

    const delegation = await alice.createDelegation({
      path: "",
      actions: ["tinycloud.sql/write"],
      delegateDID: bob.did,
    });
    const access = await bob.useDelegation(delegation);

    const abort = new AbortController();
    const stream = alice.hooks
      .subscribe(
        [
          {
            space: alice.spaceId!,
            service: "sql",
            pathPrefix: DB_NAME,
            abilities: ["tinycloud.sql/write"],
          },
        ],
        { signal: abort.signal },
      )
      [Symbol.asyncIterator]();

    const nextEvent = stream.next();
    await waitFor(() => metrics.activeStreams === 1);

    const writeResult = await access.sql
      .db(DB_NAME)
      .execute(
        `INSERT INTO ${TABLE_NAME} (id, label) VALUES (3, 'delegated-sql')`,
      );
    expect(writeResult.ok).toBe(true);

    const event = await nextEvent;
    abort.abort();
    await waitFor(() => metrics.activeStreams === 0);

    expect(event.done).toBe(false);
    if (!event.done) {
      expect(event.value.actor).not.toBe(alice.did);
      expect(event.value.path).toBe(`${DB_NAME}/${TABLE_NAME}`);
    }
  }, 30000);
});
