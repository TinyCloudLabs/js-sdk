import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, TEST_KEY } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { DuckDbStatement } from "@tinycloud/sdk-services";

const DB = `sdk_test_pivot_${Date.now()}`;

describe("DuckDB PIVOT", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-pivot", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);

    // Create EAV schema
    const db = alice.duckdb.db(DB);
    const setupStatements: DuckDbStatement[] = [
      { sql: `CREATE TABLE objects (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)` },
      { sql: `CREATE TABLE fields (id INTEGER PRIMARY KEY, object_id INTEGER, name VARCHAR NOT NULL, field_type VARCHAR DEFAULT 'text')` },
      { sql: `CREATE TABLE entries (id INTEGER PRIMARY KEY, object_id INTEGER, created_at TIMESTAMP DEFAULT current_timestamp)` },
      { sql: `CREATE TABLE entry_fields (entry_id INTEGER, field_id INTEGER, value VARCHAR, PRIMARY KEY(entry_id, field_id))` },

      // Seed people object
      { sql: `INSERT INTO objects VALUES (1, 'People')` },
      { sql: `INSERT INTO fields VALUES (1, 1, 'Full Name', 'text')` },
      { sql: `INSERT INTO fields VALUES (2, 1, 'Email', 'text')` },
      { sql: `INSERT INTO fields VALUES (3, 1, 'Phone', 'text')` },
      { sql: `INSERT INTO fields VALUES (4, 1, 'Status', 'text')` },

      // Seed task object
      { sql: `INSERT INTO objects VALUES (2, 'Tasks')` },
      { sql: `INSERT INTO fields VALUES (5, 2, 'Title', 'text')` },
      { sql: `INSERT INTO fields VALUES (6, 2, 'Status', 'text')` },
      { sql: `INSERT INTO fields VALUES (7, 2, 'Priority', 'text')` },
    ];

    // Seed 10 people entries
    const people = [
      ["Alice Johnson", "alice@acme.com", "555-0101", "Active"],
      ["Bob Smith", "bob@acme.com", "555-0102", "Active"],
      ["Charlie Brown", "charlie@acme.com", "555-0103", "Inactive"],
      ["Diana Prince", "diana@acme.com", "555-0104", "Active"],
      ["Eve Wilson", "eve@acme.com", null, "Active"],
      ["Frank Castle", "frank@acme.com", "555-0106", "Inactive"],
      ["Grace Hopper", "grace@acme.com", "555-0107", "Active"],
      ["Henry Ford", "henry@acme.com", "555-0108", "Active"],
      ["Ivy Chen", "ivy@acme.com", "555-0109", "Inactive"],
      ["Jack Ryan", "jack@acme.com", "555-0110", "Active"],
    ];

    for (let i = 0; i < people.length; i++) {
      const entryId = i + 1;
      const [name, email, phone, status] = people[i];
      setupStatements.push(
        { sql: `INSERT INTO entries VALUES (?, 1, current_timestamp)`, params: [entryId] },
        { sql: `INSERT INTO entry_fields VALUES (?, 1, ?)`, params: [entryId, name] },
        { sql: `INSERT INTO entry_fields VALUES (?, 2, ?)`, params: [entryId, email] },
      );
      if (phone) {
        setupStatements.push({ sql: `INSERT INTO entry_fields VALUES (?, 3, ?)`, params: [entryId, phone] });
      }
      setupStatements.push({ sql: `INSERT INTO entry_fields VALUES (?, 4, ?)`, params: [entryId, status] });
    }

    const setupResult = await db.batch(setupStatements);
    expect(setupResult.ok).toBe(true);
    console.log("[Setup] EAV schema seeded with 10 people entries");
  });

  afterAll(async () => {
    const db = alice.duckdb.db(DB);
    await db.execute(`DROP VIEW IF EXISTS v_people`);
    await db.execute(`DROP TABLE IF EXISTS entry_fields`);
    await db.execute(`DROP TABLE IF EXISTS entries`);
    await db.execute(`DROP TABLE IF EXISTS fields`);
    await db.execute(`DROP TABLE IF EXISTS objects`);
    console.log("[Cleanup] EAV schema dropped");
  });

  // PART 1: PIVOT Query
  describe("PIVOT Query", () => {
    const PIVOT_SQL = `
      SELECT * FROM (
        SELECT e.id as entry_id, f.name as field_name, ef.value
        FROM entries e
        JOIN entry_fields ef ON ef.entry_id = e.id
        JOIN fields f ON f.id = ef.field_id
        WHERE e.object_id = 1
      )
      PIVOT (
        FIRST(value) FOR field_name IN ('Full Name', 'Email', 'Phone', 'Status')
      )
      ORDER BY entry_id
    `;

    test("PIVOT query denormalizes EAV to flat rows", async () => {
      const result = await alice.duckdb.db(DB).query(PIVOT_SQL);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBeGreaterThan(0);
      }
    });

    test("result columns include pivoted field names", async () => {
      const result = await alice.duckdb.db(DB).query(PIVOT_SQL);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        // Columns should include the pivoted field names
        expect(data.columns).toContain("entry_id");
        // DuckDB PIVOT columns use the IN values as column names
        const colNames = data.columns.map(c => c.toLowerCase());
        expect(colNames.some(c => c.includes("full name"))).toBe(true);
        expect(colNames.some(c => c.includes("email"))).toBe(true);
      }
    });

    test("result row count matches entry count", async () => {
      const result = await alice.duckdb.db(DB).query(PIVOT_SQL);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBe(10);
      }
    });

    test("NULL entry_fields produce NULL in pivoted output", async () => {
      // Eve (entry 5) has no phone
      const result = await alice.duckdb.db(DB).query(PIVOT_SQL);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        // Find Eve's row (entry_id = 5)
        const entryIdIdx = data.columns.indexOf("entry_id");
        const eveRow = data.rows.find(r => r[entryIdIdx] === 5);
        expect(eveRow).toBeDefined();

        // Find Phone column and verify it's null
        const phoneIdx = data.columns.findIndex(c => c.toLowerCase().includes("phone"));
        expect(eveRow![phoneIdx]).toBeNull();
      }
    });
  });

  // PART 2: PIVOT as View
  describe("PIVOT as View", () => {
    beforeAll(async () => {
      await alice.duckdb.db(DB).execute(`
        CREATE VIEW v_people AS
        SELECT * FROM (
          SELECT e.id as entry_id, f.name as field_name, ef.value
          FROM entries e
          JOIN entry_fields ef ON ef.entry_id = e.id
          JOIN fields f ON f.id = ef.field_id
          WHERE e.object_id = 1
        )
        PIVOT (
          FIRST(value) FOR field_name IN ('Full Name', 'Email', 'Phone', 'Status')
        )
      `);
    });

    test("CREATE VIEW with PIVOT succeeds", async () => {
      // View was created in beforeAll; verify it exists via a query
      const result = await alice.duckdb.db(DB).query(`SELECT COUNT(*) as cnt FROM v_people`);
      expect(result.ok).toBe(true);
    });

    test("SELECT * FROM v_people returns denormalized rows", async () => {
      const result = await alice.duckdb.db(DB).query(`SELECT * FROM v_people ORDER BY entry_id`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBe(10);
      }
    });

    test("WHERE on pivoted column filters correctly", async () => {
      const result = await alice.duckdb.db(DB).query(
        `SELECT * FROM v_people WHERE "Status" = 'Active'`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        // We seeded 7 Active people
        expect(data.rowCount).toBe(7);
      }
    });

    test("ORDER BY on pivoted column works", async () => {
      const result = await alice.duckdb.db(DB).query(
        `SELECT * FROM v_people ORDER BY "Full Name" ASC`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBe(10);
        // First row alphabetically should be Alice Johnson
        const nameIdx = data.columns.findIndex(c => c.toLowerCase().includes("full name"));
        expect(data.rows[0][nameIdx]).toBe("Alice Johnson");
      }
    });
  });

  // PART 3: Analytics on Pivoted Data
  describe("Analytics on Pivoted Data", () => {
    test("COUNT(*) GROUP BY Status", async () => {
      const result = await alice.duckdb.db(DB).query(
        `SELECT "Status", COUNT(*) as cnt FROM v_people GROUP BY "Status" ORDER BY cnt DESC`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBeGreaterThanOrEqual(2); // Active + Inactive
        const statusIdx = data.columns.findIndex(c => c === "Status");
        const cntIdx = data.columns.indexOf("cnt");
        // Active should have more entries
        expect(data.rows[0][cntIdx]).toBe(7);
      }
    });

    test("LIKE filter on pivoted text column", async () => {
      const result = await alice.duckdb.db(DB).query(
        `SELECT * FROM v_people WHERE "Email" LIKE '%@acme.com'`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBe(10); // All have @acme.com
      }
    });

    test("CTE filter injection pattern", async () => {
      const result = await alice.duckdb.db(DB).query(`
        WITH __report_data AS (SELECT * FROM v_people)
        SELECT * FROM __report_data WHERE "Status" = 'Active'
      `);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.rowCount).toBe(7);
      }
    });

    test("Window functions on pivoted data (ROW_NUMBER)", async () => {
      const result = await alice.duckdb.db(DB).query(`
        SELECT *, ROW_NUMBER() OVER (PARTITION BY "Status" ORDER BY "Full Name") as rn
        FROM v_people
      `);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.columns).toContain("rn");
        expect(data.rowCount).toBe(10);
      }
    });
  });

  // PART 4: UNPIVOT
  describe("UNPIVOT", () => {
    test("UNPIVOT converts wide table back to name/value rows", async () => {
      const result = await alice.duckdb.db(DB).query(`
        SELECT entry_id, field_name, field_value
        FROM v_people
        UNPIVOT (
          field_value FOR field_name IN ("Full Name", "Email", "Phone", "Status")
        )
        ORDER BY entry_id, field_name
      `);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data;
        expect(data.columns).toContain("field_name");
        expect(data.columns).toContain("field_value");
        // Each of 10 entries has up to 4 fields (some NULL Phone values may be excluded by UNPIVOT)
        expect(data.rowCount).toBeGreaterThanOrEqual(30);
      }
    });
  });
});
