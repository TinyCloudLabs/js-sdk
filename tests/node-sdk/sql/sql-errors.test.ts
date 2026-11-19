import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const TABLE = `sdk_test_sql_errors_${Date.now()}`;

describe("SQL Errors", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-sql-errors", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);

    // Create the test table
    const result = await alice.sql.execute(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`
    );
    expect(result.ok).toBe(true);
    console.log("[Setup] Test table created:", TABLE);
  });

  afterAll(async () => {
    await alice.sql.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    console.log("[Cleanup] Table dropped:", TABLE);
  });

  // PART 1: SQL Syntax Errors
  describe("SQL Syntax Errors", () => {
    test("error message contains useful info", async () => {
      const result = await alice.sql.query(`SELEC * FROM ${TABLE}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error.message).toBe("string");
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });
  });

  // PART 2: Constraint Violations
  describe("Constraint Violations", () => {
    test("INSERT duplicate primary key returns error", async () => {
      // Insert first row
      const first = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name) VALUES (?, ?)`,
        [1, "Alice"]
      );
      expect(first.ok).toBe(true);

      // Insert duplicate
      const result = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name) VALUES (?, ?)`,
        [1, "Duplicate"]
      );
      expect(result.ok).toBe(false);
    });

    test("INSERT violating NOT NULL returns error", async () => {
      const result = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name) VALUES (?, ?)`,
        [10, null]
      );
      expect(result.ok).toBe(false);
    });
  });

  // PART 3: Missing Objects
  describe("Missing Objects", () => {
    test("SELECT from non-existent table returns error", async () => {
      const result = await alice.sql.query(
        `SELECT * FROM table_that_does_not_exist`
      );
      expect(result.ok).toBe(false);
    });

    test("DROP non-existent table without IF EXISTS returns error", async () => {
      const result = await alice.sql.execute(
        `DROP TABLE table_that_does_not_exist`
      );
      expect(result.ok).toBe(false);
    });
  });

  // PART 4: Type Mismatches
  describe("Type Mismatches", () => {
    test("INSERT wrong type into column returns error", async () => {
      const result = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name) VALUES (?, ?)`,
        ["abc", "TypeTest"]
      );
      expect(result.ok).toBe(false);
    });
  });
});
