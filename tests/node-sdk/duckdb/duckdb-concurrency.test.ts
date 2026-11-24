import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const TABLE = `sdk_test_conc_${Date.now()}`;
const DB_PREFIX = `sdk_test_conc_db`;
const NAMED_DB_COUNT = 5;
const namedDbs = Array.from(
  { length: NAMED_DB_COUNT },
  (_, i) => `${DB_PREFIX}_${i}_${Date.now()}`
);

describe("DuckDB Concurrency", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-concurrent", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);

    await alice.duckdb.execute(
      `CREATE TABLE ${TABLE} (id INTEGER, val VARCHAR)`
    );
    console.log("[Setup] Table created:", TABLE);
  });

  afterAll(async () => {
    await alice.duckdb.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    for (const db of namedDbs) {
      await alice.duckdb.db(db).execute(`DROP TABLE IF EXISTS items`);
    }
    console.log("[Cleanup] Tables dropped");
  });

  // PART 1: Parallel Writes (same table)
  describe("Parallel Writes", () => {
    test("20 concurrent INSERTs all succeed", async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        alice.duckdb.execute(
          `INSERT INTO ${TABLE} VALUES (${i}, 'val_${i}')`
        )
      );
      const results = await Promise.all(promises);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.changes).toBe(1);
        }
      }
    }, 30000);

    test("final row count matches expected (no lost writes)", async () => {
      const result = await alice.duckdb.query(
        `SELECT COUNT(*) as cnt FROM ${TABLE}`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const cntIdx = result.data.columns.indexOf("cnt");
        expect(result.data.rows[0][cntIdx]).toBe(20);
      }
    }, 30000);
  });

  // PART 2: Concurrent Reads During Writes
  describe("Concurrent Reads During Writes", () => {
    test("all promises resolve without hanging or crashing", async () => {
      const promises = Array.from({ length: 20 }, (_, i) => {
        if (i % 2 === 0) {
          return alice.duckdb.execute(
            `INSERT INTO ${TABLE} VALUES (${100 + i}, 'val_${100 + i}')`
          );
        }
        return alice.duckdb.query(`SELECT * FROM ${TABLE}`);
      });
      const results = await Promise.all(promises);
      for (const result of results) {
        expect(result.ok).toBe(true);
      }
    }, 30000);

    test("reads return valid data", async () => {
      const readPromises = Array.from({ length: 10 }, () =>
        alice.duckdb.query(`SELECT * FROM ${TABLE}`)
      );
      const results = await Promise.all(readPromises);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.rowCount).toBeGreaterThan(0);
          expect(result.data.columns).toContain("id");
          expect(result.data.columns).toContain("val");
        }
      }
    }, 30000);
  });

  // PART 3: Parallel Batch Operations
  describe("Parallel Batch Operations", () => {
    test("all batch results have correct changes counts", async () => {
      const promises = Array.from({ length: 5 }, (_, batchIdx) =>
        alice.duckdb.batch([
          { sql: `INSERT INTO ${TABLE} VALUES (${300 + batchIdx * 2}, 'batch2_${batchIdx}_0')` },
          { sql: `INSERT INTO ${TABLE} VALUES (${301 + batchIdx * 2}, 'batch2_${batchIdx}_1')` },
        ])
      );
      const results = await Promise.all(promises);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.results).toHaveLength(2);
          expect(result.data.results[0].changes).toBe(1);
          expect(result.data.results[1].changes).toBe(1);
        }
      }
    }, 30000);
  });

  // PART 4: Multi-Client Same Space
  describe("Multi-Client Same Space", () => {
    let alice2: TinyCloudNode;

    beforeAll(async () => {
      alice2 = createClient("alice-concurrent", TEST_KEY);
      await alice2.signIn();
      console.log("[Setup] Alice2 signed in, DID:", alice2.did);
    });

    test("Alice and Alice2 concurrent queries both return valid data", async () => {
      const [result1, result2] = await Promise.all([
        alice.duckdb.query(`SELECT * FROM ${TABLE}`),
        alice2.duckdb.query(`SELECT * FROM ${TABLE}`),
      ]);
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok) {
        expect(result1.data.rowCount).toBeGreaterThan(0);
      }
      if (result2.ok) {
        expect(result2.data.rowCount).toBeGreaterThan(0);
      }
    }, 30000);

    test("Alice writes, Alice2 reads — sees the written data", async () => {
      const writeResult = await alice.duckdb.execute(
        `INSERT INTO ${TABLE} VALUES (999, 'cross_client')`
      );
      expect(writeResult.ok).toBe(true);

      const readResult = await alice2.duckdb.query(
        `SELECT * FROM ${TABLE} WHERE id = 999`
      );
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.data.rowCount).toBe(1);
        const valIdx = readResult.data.columns.indexOf("val");
        expect(readResult.data.rows[0][valIdx]).toBe("cross_client");
      }
    }, 30000);
  });

  // PART 5: Cross-Database Parallelism
  describe("Cross-Database Parallelism", () => {
    test("concurrent operations across different databases all succeed", async () => {
      const promises = namedDbs.map((db, i) =>
        alice.duckdb.db(db).execute(
          `CREATE TABLE items (id INTEGER, val VARCHAR)`
        ).then(() =>
          alice.duckdb.db(db).execute(
            `INSERT INTO items VALUES (${i}, 'db_${i}')`
          )
        )
      );
      const results = await Promise.all(promises);
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.changes).toBe(1);
        }
      }
    }, 30000);

    test("each database has independent data", async () => {
      const promises = namedDbs.map((db, i) =>
        alice.duckdb.db(db).query(`SELECT * FROM items`)
      );
      const results = await Promise.all(promises);
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.rowCount).toBe(1);
          const idIdx = result.data.columns.indexOf("id");
          const valIdx = result.data.columns.indexOf("val");
          expect(result.data.rows[0][idIdx]).toBe(i);
          expect(result.data.rows[0][valIdx]).toBe(`db_${i}`);
        }
      }
    }, 30000);
  });
});
