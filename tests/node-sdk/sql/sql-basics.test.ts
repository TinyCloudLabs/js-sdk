import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServerHealth, createClient, SERVER_URL, TEST_KEY } from "../setup";
import { TinyCloudNode, type Manifest } from "@tinycloud/node-sdk";

const TABLE = `sdk_test_sql_users_${Date.now()}`;
const ANALYTICS_TABLE = `sdk_test_sql_analytics_${Date.now()}`;

describe("SQL Basics", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("alice-sql", TEST_KEY);
    await alice.signIn();
    console.log("[Setup] Alice signed in, DID:", alice.did);
  });

  afterAll(async () => {
    // Cleanup
    await alice.sql.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await alice.sql.db("analytics").execute(`DROP TABLE IF EXISTS ${ANALYTICS_TABLE}`);
    console.log("[Cleanup] Tables dropped");
  });

  // PART 1: Schema & Writes
  describe("Schema & Writes", () => {
    test("CREATE TABLE succeeds", async () => {
      const result = await alice.sql.execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, name TEXT, email TEXT, score REAL, notes TEXT)`
      );
      expect(result.ok).toBe(true);
    });

    test("INSERT returns changes: 1", async () => {
      const result = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name, email, score) VALUES (1, 'Alice', 'alice@example.com', 95.5)`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.changes).toBe(1);
      }
    });

    test("INSERT with params binds correctly", async () => {
      const result = await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name, email, score) VALUES (?, ?, ?, ?)`,
        [2, "Bob", "bob@example.com", 87.3]
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.changes).toBe(1);
      }
    });

    test("UPDATE returns correct changes count", async () => {
      const result = await alice.sql.execute(
        `UPDATE ${TABLE} SET score = 96.0 WHERE id = 1`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.changes).toBe(1);
      }
    });
  });

  // PART 2: Queries
  describe("Queries", () => {
    beforeAll(async () => {
      // Ensure table and baseline data exist even if PART 1 tests failed
      await alice.sql.execute(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, name TEXT, email TEXT, score REAL, notes TEXT)`
      );
      await alice.sql.execute(
        `INSERT OR IGNORE INTO ${TABLE} (id, name, email, score) VALUES (1, 'Alice', 'alice@example.com', 95.5)`
      );
      await alice.sql.execute(
        `INSERT OR IGNORE INTO ${TABLE} (id, name, email, score) VALUES (2, 'Bob', 'bob@example.com', 87.3)`
      );
    });

    test("SELECT * returns columns, rows, rowCount", async () => {
      const result = await alice.sql.query(`SELECT * FROM ${TABLE} ORDER BY id`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.columns).toContain("id");
        expect(result.data.columns).toContain("name");
        expect(result.data.rowCount).toBe(2);
        expect(result.data.rows.length).toBe(2);
      }
    });

    test("WHERE clause filters correctly", async () => {
      const result = await alice.sql.query(`SELECT * FROM ${TABLE} WHERE name = 'Alice'`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rowCount).toBe(1);
      }
    });

    test("query with params binds correctly", async () => {
      const result = await alice.sql.query(`SELECT * FROM ${TABLE} WHERE id = ?`, [2]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rowCount).toBe(1);
        // First row, check name column
        const nameIdx = result.data.columns.indexOf("name");
        expect(result.data.rows[0][nameIdx]).toBe("Bob");
      }
    });

    test("types: INTEGER, TEXT, REAL, NULL round-trip", async () => {
      // Insert a row with NULL
      await alice.sql.execute(
        `INSERT INTO ${TABLE} (id, name, email, score, notes) VALUES (3, 'Charlie', 'charlie@test.com', 72.1, NULL)`
      );
      const result = await alice.sql.query(`SELECT * FROM ${TABLE} WHERE id = 3`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const row = result.data.rows[0];
        const cols = result.data.columns;
        expect(typeof row[cols.indexOf("id")]).toBe("number"); // INTEGER
        expect(typeof row[cols.indexOf("name")]).toBe("string"); // TEXT
        expect(typeof row[cols.indexOf("score")]).toBe("number"); // REAL
        expect(row[cols.indexOf("notes")]).toBeNull(); // NULL
      }
    });
  });

  // PART 3: Batch
  describe("Batch", () => {
    test("batch with multiple INSERTs returns results array", async () => {
      const result = await alice.sql.batch([
        { sql: `INSERT INTO ${TABLE} (id, name, email, score) VALUES (4, 'Dave', 'dave@test.com', 88.0)` },
        { sql: `INSERT INTO ${TABLE} (id, name, email, score) VALUES (5, 'Eve', 'eve@test.com', 91.2)` },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.results).toHaveLength(2);
      }
    });

    test("batch results have per-statement changes count", async () => {
      const result = await alice.sql.batch([
        { sql: `UPDATE ${TABLE} SET score = 89.0 WHERE id = 4` },
        { sql: `UPDATE ${TABLE} SET score = 92.0 WHERE id = 5` },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.results[0].changes).toBe(1);
        expect(result.data.results[1].changes).toBe(1);
      }
    });
  });

  // PART 4: Named Database
  describe("Named Database", () => {
    test("db('analytics').execute CREATE TABLE works", async () => {
      const result = await alice.sql.db("analytics").execute(
        `CREATE TABLE IF NOT EXISTS ${ANALYTICS_TABLE} (id INTEGER PRIMARY KEY, event TEXT, count INTEGER)`
      );
      expect(result.ok).toBe(true);
    });

    test("db('analytics').query returns data from named db", async () => {
      await alice.sql.db("analytics").execute(
        `INSERT INTO ${ANALYTICS_TABLE} (id, event, count) VALUES (1, 'page_view', 100)`
      );
      const result = await alice.sql.db("analytics").query(`SELECT * FROM ${ANALYTICS_TABLE}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rowCount).toBe(1);
        const eventIdx = result.data.columns.indexOf("event");
        expect(result.data.rows[0][eventIdx]).toBe("page_view");
      }
    });
  });

  // PART 5: Migration permission repair
  describe("Migrations", () => {
    test("runtime SQL ddl repair lets a legacy read/write session apply migrations", async () => {
      const runId = Date.now();
      const space = `secrets-e2e-${runId}`;
      const table = `secret_metadata_${runId}`;
      const legacyManifest: Manifest = {
        manifest_version: 1,
        app_id: "xyz.tinycloud.secrets.e2e",
        name: "TinyCloud Secrets E2E",
        space,
        prefix: "",
        defaults: false,
        includePublicSpace: false,
        permissions: [
          {
            service: "tinycloud.sql",
            space,
            path: "default",
            actions: ["read", "write"],
            skipPrefix: true,
          },
        ],
      };
      const legacy = new TinyCloudNode({
        privateKey: TEST_KEY,
        host: SERVER_URL,
        prefix: space,
        autoCreateSpace: true,
        manifest: legacyManifest,
      });

      await legacy.signIn();
      await legacy.grantRuntimePermissions([
        {
          service: "tinycloud.sql",
          space,
          path: "default",
          actions: ["read", "write", "ddl"],
          skipPrefix: true,
        },
      ]);

      const result = await legacy.sql.db("default").migrations.apply({
        namespace: "xyz.tinycloud.secrets",
        migrations: [
          {
            id: "001_secret_metadata",
            sql: [
              `CREATE TABLE IF NOT EXISTS ${table} (scope TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, name))`,
            ],
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe("applied");
        expect(result.data.applied).toEqual(["001_secret_metadata"]);
      }
    });
  });

  // PART 6: Delegated Access
  describe("Delegated Access", () => {
    test("bob can query via read-only delegation", async () => {
      const bob = createClient("bob-sql");
      await bob.signIn();
      console.log("[Delegation] Bob signed in, DID:", bob.did);

      // Alice creates read-only delegation for Bob
      const delegation = await alice.createDelegation({
        path: "",
        actions: ["tinycloud.sql/read"],
        delegateDID: bob.did,
      });
      console.log("[Delegation] Created delegation:", delegation.cid);

      // Bob uses the delegation
      const access = await bob.useDelegation(delegation);
      const result = await access.sql.query(`SELECT * FROM ${TABLE} ORDER BY id`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.rowCount).toBeGreaterThanOrEqual(2);
      }
    });

    test("bob write attempt is denied", async () => {
      const bob = createClient("bob-sql-write");
      await bob.signIn();

      const delegation = await alice.createDelegation({
        path: "",
        actions: ["tinycloud.sql/read"],
        delegateDID: bob.did,
      });

      const access = await bob.useDelegation(delegation);
      const result = await access.sql.execute(
        `INSERT INTO ${TABLE} (id, name, email, score) VALUES (99, 'Hacker', 'h@x.com', 0)`
      );
      expect(result.ok).toBe(false);
    });
  });

  // PART 7: Export
  describe("Export", () => {
    test("export returns a Blob", async () => {
      const result = await alice.sql.db().export();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBeInstanceOf(Blob);
      }
    });

    test("exported Blob is non-empty", async () => {
      const result = await alice.sql.db().export();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.size).toBeGreaterThan(0);
      }
    });
  });
});
