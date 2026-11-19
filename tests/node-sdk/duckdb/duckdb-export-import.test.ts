import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const SMALL_DB = `sdk_test_small_export_${Date.now()}`;
const LARGE_DB = `sdk_test_large_export_${Date.now()}`;
const IMPORTED_DB = `sdk_test_imported_${Date.now()}`;
const TABLE = `data_table`;

describe("DuckDB Export/Import", () => {
  let alice: TinyCloudNode;
  let exportedBlob: Blob;
  let originalRowCount: number;
  let originalFirstRow: unknown[];

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-export", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);
  });

  afterAll(async () => {
    await alice.duckdb.db(SMALL_DB).execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await alice.duckdb.db(LARGE_DB).execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await alice.duckdb.db(IMPORTED_DB).execute(`DROP TABLE IF EXISTS ${TABLE}`);
    console.log("[Cleanup] Tables dropped in all test dbs");
  });

  // PART 1: Small Database Export
  describe("Small Database Export", () => {
    beforeAll(async () => {
      await alice.duckdb.db(SMALL_DB).execute(
        `CREATE TABLE ${TABLE} (id INTEGER, name VARCHAR)`
      );
      await alice.duckdb.db(SMALL_DB).execute(
        `INSERT INTO ${TABLE} VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')`
      );
      console.log("[Part 1] Small db created with 3 rows");
    });

    test("export of small (in-memory) db succeeds", async () => {
      const result = await alice.duckdb.db(SMALL_DB).export();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBeInstanceOf(Blob);
        expect(result.data.size).toBeGreaterThan(0);
        console.log("[Part 1] Small db export succeeded, blob size:", result.data.size);
      }
    });
  });

  // PART 2: Large Database Export (triggers file promotion at 10 MiB threshold)
  describe("Large Database Export", () => {
    beforeAll(async () => {
      await alice.duckdb.db(LARGE_DB).execute(
        `CREATE TABLE ${TABLE} (id INTEGER, payload TEXT)`
      );
      console.log("[Part 2] Large db table created, inserting ~50K rows...");

      // Insert 50 batches of 1000 rows each (~256 chars per row) to exceed 10 MiB
      for (let batch = 0; batch < 50; batch++) {
        const offset = batch * 1000;
        await alice.duckdb.db(LARGE_DB).execute(
          `INSERT INTO ${TABLE} SELECT i + ${offset}, REPEAT('x', 256) FROM generate_series(1, 1000) AS t(i)`
        );
      }

      // Capture original row count and first row for later round-trip checks
      const countResult = await alice.duckdb.db(LARGE_DB).query(
        `SELECT COUNT(*) AS cnt FROM ${TABLE}`
      );
      if (countResult.ok) {
        const cntIdx = countResult.data.columns.indexOf("cnt");
        originalRowCount = countResult.data.rows[0][cntIdx] as number;
        console.log("[Part 2] Inserted rows:", originalRowCount);
      }

      const firstRowResult = await alice.duckdb.db(LARGE_DB).query(
        `SELECT * FROM ${TABLE} ORDER BY id LIMIT 1`
      );
      if (firstRowResult.ok) {
        originalFirstRow = firstRowResult.data.rows[0];
      }
    }, 120000);

    test("export returns a Blob after data exceeds memory threshold", async () => {
      const result = await alice.duckdb.db(LARGE_DB).export();
      expect(result.ok).toBe(true);
      if (result.ok) {
        exportedBlob = result.data;
        expect(exportedBlob).toBeInstanceOf(Blob);
        console.log("[Part 2] Export succeeded, blob size:", exportedBlob.size);
      }
    }, 120000);
  });

  // PART 3: Import Errors
  describe("Import Errors", () => {
    test("import invalid bytes returns error (not crash)", async () => {
      const invalidBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
      const invalidDb = `sdk_test_invalid_${Date.now()}`;
      const result = await alice.duckdb.db(invalidDb).import(invalidBytes);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
        console.log("[Part 3] Invalid bytes error:", result.error.message);
      }
    });
  });

  // PART 4: Large Round-Trip
  describe("Large Round-Trip", () => {
    test("import bytes from export succeeds", async () => {
      expect(exportedBlob).toBeDefined();

      const arrayBuffer = await exportedBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const result = await alice.duckdb.db(IMPORTED_DB).import(bytes);
      expect(result.ok).toBe(true);
      if (result.ok) {
        console.log("[Part 4] Import succeeded into db:", IMPORTED_DB);
      }
    }, 120000);

    test("query imported db returns same row count as original", async () => {
      const result = await alice.duckdb.db(IMPORTED_DB).query(
        `SELECT COUNT(*) AS cnt FROM ${TABLE}`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const cntIdx = result.data.columns.indexOf("cnt");
        const importedRowCount = result.data.rows[0][cntIdx];
        expect(importedRowCount).toBe(originalRowCount);
        console.log("[Part 4] Imported row count matches:", importedRowCount);
      }
    }, 120000);

    test("spot-check: first row data matches between original and imported db", async () => {
      const result = await alice.duckdb.db(IMPORTED_DB).query(
        `SELECT * FROM ${TABLE} ORDER BY id LIMIT 1`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const importedFirstRow = result.data.rows[0];
        expect(importedFirstRow).toEqual(originalFirstRow);
        console.log("[Part 4] First row matches between original and imported db");
      }
    }, 120000);
  });
});
