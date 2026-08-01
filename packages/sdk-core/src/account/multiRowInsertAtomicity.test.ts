/**
 * TC-373 point 3: the corrected design replaces a 5-statement `db.batch`
 * call (which tinycloud-node 1.12.0 runs as a plain, non-transactional
 * statement loop — see AccountService.upsertSpacesIndex) with ONE multi-row
 * `INSERT OR REPLACE ... VALUES (...),(...),...` statement, relying on
 * SQLite's per-statement atomicity: a single statement either fully applies
 * or fully rejects.
 *
 * This exercises that exact property against a real SQLite engine
 * (bun:sqlite, in-memory), using the account index's own `spaces` table
 * schema, independent of any HTTP/service mocking. It cannot be verified by
 * mocking `IDatabaseHandle.batch()` — a mock can only assert what SQL text
 * was sent, not whether the underlying engine actually applies it
 * atomically.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ACCOUNT_INDEX_SCHEMA } from "@tinycloud/bootstrap";

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const statement of ACCOUNT_INDEX_SCHEMA) {
    db.run(statement);
  }
  return db;
}

const INSERT_SPACES_SQL =
  "INSERT OR REPLACE INTO spaces (space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at) VALUES ";

function goodRow(id: string): unknown[] {
  return [
    `tinycloud:pkh:eip155:1:0xabc:${id}`,
    id,
    "did:pkh:eip155:1:0xabc",
    "owned",
    JSON.stringify(["*"]),
    "active",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    null,
  ];
}

describe("multi-row INSERT OR REPLACE atomicity (TC-373 point 3)", () => {
  test("a single bad row in a multi-row statement rejects the WHOLE statement — none of the good rows in it apply either", () => {
    const db = freshDb();

    // `name` is declared NOT NULL in ACCOUNT_INDEX_SCHEMA; null here must
    // abort the entire multi-row statement.
    const badRow: unknown[] = [
      "tinycloud:pkh:eip155:1:0xabc:secrets",
      null,
      "did:pkh:eip155:1:0xabc",
      "owned",
      JSON.stringify(["*"]),
      "active",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      null,
    ];

    const rows = [goodRow("default"), badRow, goodRow("public")];
    const sql = INSERT_SPACES_SQL + rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = rows.flat();

    expect(() => db.run(sql, params as any)).toThrow();

    const remaining = db.query("SELECT space_id FROM spaces").all();
    // Atomicity: the two well-formed rows in the SAME statement must NOT
    // have been applied either.
    expect(remaining).toHaveLength(0);
  });

  test("a fully well-formed multi-row statement applies all rows", () => {
    const db = freshDb();

    const rows = ["default", "applications", "account", "secrets", "public"].map(goodRow);
    const sql = INSERT_SPACES_SQL + rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = rows.flat();

    db.run(sql, params as any);

    const remaining = db.query("SELECT space_id FROM spaces ORDER BY space_id").all() as Array<{
      space_id: string;
    }>;
    expect(remaining.map((row) => row.space_id)).toEqual(
      ["account", "applications", "default", "public", "secrets"].map(
        (id) => `tinycloud:pkh:eip155:1:0xabc:${id}`,
      ),
    );
  });

  test("contrast: a loop of 5 separate statements (today's db.batch shape) is NOT atomic — statements before a failing one persist", () => {
    const db = freshDb();

    const insertOne = (id: string, name: string | null) =>
      db.run(INSERT_SPACES_SQL + "(?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        `tinycloud:pkh:eip155:1:0xabc:${id}`,
        name,
        "did:pkh:eip155:1:0xabc",
        "owned",
        JSON.stringify(["*"]),
        "active",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
      ] as any);

    insertOne("default", "default");
    insertOne("applications", "applications");
    // The node's statement loop returns (stops) at the first failure — see
    // NO-GO reason #3 ("failure returns before artifact persistence") — so a
    // trailing well-formed statement is never reached in this scenario.
    expect(() => insertOne("secrets", null)).toThrow(); // fails on the 3rd statement

    const remaining = db.query("SELECT space_id FROM spaces ORDER BY space_id").all() as Array<{
      space_id: string;
    }>;
    // NOT atomic: the two statements that ran before the failing one are
    // already committed. This is exactly the gap the corrected design's
    // single multi-row statement closes.
    expect(remaining.map((row) => row.space_id)).toEqual([
      "tinycloud:pkh:eip155:1:0xabc:applications",
      "tinycloud:pkh:eip155:1:0xabc:default",
    ]);
  });
});
