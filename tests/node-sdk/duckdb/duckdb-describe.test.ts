import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const DB_NAME = `sdk_test_describe_${Date.now()}`;
const TABLE_PRODUCTS = `products`;
const TABLE_ORDERS = `orders`;
const VIEW_NAME = `active_products`;

describe("DuckDB Describe", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-describe", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);

    // Create tables and views in named database
    await alice.duckdb.db(DB_NAME).execute(
      `CREATE TABLE ${TABLE_PRODUCTS} (
        id INTEGER NOT NULL,
        name VARCHAR NOT NULL,
        price DOUBLE,
        in_stock BOOLEAN DEFAULT true,
        description VARCHAR
      )`
    );
    await alice.duckdb.db(DB_NAME).execute(
      `CREATE TABLE ${TABLE_ORDERS} (
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        ordered_at TIMESTAMP DEFAULT current_timestamp
      )`
    );
    await alice.duckdb.db(DB_NAME).execute(
      `CREATE VIEW ${VIEW_NAME} AS SELECT id, name, price FROM ${TABLE_PRODUCTS} WHERE in_stock = true`
    );
    console.log("[Setup] Schema created in db:", DB_NAME);
  });

  afterAll(async () => {
    await alice.duckdb.db(DB_NAME).execute(`DROP VIEW IF EXISTS ${VIEW_NAME}`);
    await alice.duckdb.db(DB_NAME).execute(`DROP TABLE IF EXISTS ${TABLE_ORDERS}`);
    await alice.duckdb.db(DB_NAME).execute(`DROP TABLE IF EXISTS ${TABLE_PRODUCTS}`);
    console.log("[Cleanup] Schema dropped");
  });

  // PART 1: Schema Introspection
  describe("Schema Introspection", () => {
    test("table has name and columns array", async () => {
      const result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const productsTable = result.data.tables.find(t => t.name === TABLE_PRODUCTS);
        expect(productsTable).toBeDefined();
        expect(productsTable!.name).toBe(TABLE_PRODUCTS);
        expect(Array.isArray(productsTable!.columns)).toBe(true);
        expect(productsTable!.columns.length).toBeGreaterThanOrEqual(4);
      }
    });

    test("column.type is string", async () => {
      const result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const productsTable = result.data.tables.find(t => t.name === TABLE_PRODUCTS);
        const idCol = productsTable!.columns.find(c => c.name === "id");
        expect(typeof idCol!.type).toBe("string");
        // DuckDB returns type names like "INTEGER", "VARCHAR", etc.
        expect(idCol!.type).toMatch(/INTEGER/i);
      }
    });

    test("column.nullable is boolean", async () => {
      const result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const productsTable = result.data.tables.find(t => t.name === TABLE_PRODUCTS);
        const idCol = productsTable!.columns.find(c => c.name === "id");
        const descCol = productsTable!.columns.find(c => c.name === "description");

        expect(typeof idCol!.nullable).toBe("boolean");
        expect(typeof descCol!.nullable).toBe("boolean");
        // id is NOT NULL, description allows NULL
        expect(idCol!.nullable).toBe(false);
        expect(descCol!.nullable).toBe(true);
      }
    });

    test("views array has name and sql", async () => {
      const result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const view = result.data.views.find(v => v.name === VIEW_NAME);
        expect(view).toBeDefined();
        expect(view!.name).toBe(VIEW_NAME);
        expect(typeof view!.sql).toBe("string");
        expect(view!.sql.length).toBeGreaterThan(0);
      }
    });
  });

  // PART 2: Schema Changes Reflected
  describe("Schema Changes Reflected", () => {
    test("adding a column shows in next describe", async () => {
      await alice.duckdb.db(DB_NAME).execute(
        `ALTER TABLE ${TABLE_PRODUCTS} ADD COLUMN category VARCHAR`
      );

      const result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const productsTable = result.data.tables.find(t => t.name === TABLE_PRODUCTS);
        const categoryCol = productsTable!.columns.find(c => c.name === "category");
        expect(categoryCol).toBeDefined();
        expect(categoryCol!.type).toMatch(/VARCHAR/i);
      }
    });

    test("dropping a table removes it from describe", async () => {
      const tempTable = `temp_describe_${Date.now()}`;
      await alice.duckdb.db(DB_NAME).execute(`CREATE TABLE ${tempTable} (x INTEGER)`);

      // Verify it exists
      let result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.tables.find(t => t.name === tempTable)).toBeDefined();
      }

      // Drop it
      await alice.duckdb.db(DB_NAME).execute(`DROP TABLE ${tempTable}`);

      // Verify it's gone
      result = await alice.duckdb.db(DB_NAME).describe();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.tables.find(t => t.name === tempTable)).toBeUndefined();
      }
    });
  });
});
