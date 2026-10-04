import { describe, test, expect, beforeAll } from "bun:test";
import { checkServerHealth, createClient, SERVER_URL } from "../setup";
import { isStorageFullError, type TinyCloudNode } from "@tinycloud/node-sdk";

// Needs a node started with TINYCLOUD_ADMIN_SECRET, so the test can cap the
// space below what it already stores (PUT /admin/quota/<space>).
const ADMIN_SECRET = process.env.TC_TEST_ADMIN_SECRET;
const NAMESPACE = "com.example.storage-full";
const NOTES_MIGRATION = {
  id: "001_notes",
  sql: ["CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"],
};

describe.skipIf(!ADMIN_SECRET)("Storage full: reads keep working, writes fail", () => {
  let alice: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    alice = createClient("storage-full");
    await alice.signIn();

    const db = alice.sql.db("default");
    const migrated = await db.migrations.apply({
      namespace: NAMESPACE,
      migrations: [NOTES_MIGRATION],
    });
    expect(migrated.ok).toBe(true);
    expect((await db.execute("INSERT INTO notes (body) VALUES (?)", ["saved before"])).ok).toBe(true);
    expect((await alice.kv.put("notes/first", "saved before")).ok).toBe(true);

    const capped = await fetch(
      `${SERVER_URL}/admin/quota/${encodeURIComponent(alice.spaceId!)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ADMIN_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit_bytes: 1 }),
      },
    );
    expect(capped.ok).toBe(true);
  });

  test("an up-to-date schema still opens", async () => {
    const result = await alice.sql.db("default").migrations.apply({
      namespace: NAMESPACE,
      migrations: [NOTES_MIGRATION],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.status).toBe("already_current");
  });

  test("SQL and KV reads work", async () => {
    const rows = await alice.sql.db("default").query("SELECT body FROM notes");
    expect(rows.ok).toBe(true);
    expect(rows.ok && rows.data.rows).toEqual([["saved before"]]);

    const value = await alice.kv.get<string>("notes/first");
    expect(value.ok).toBe(true);
    expect(value.ok && value.data.data).toBe("saved before");
  });

  test("SQL writes fail with STORAGE_QUOTA_EXCEEDED", async () => {
    const result = await alice.sql
      .db("default")
      .execute("INSERT INTO notes (body) VALUES (?)", ["rejected"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(isStorageFullError(result.error)).toBe(true);
    expect(result.error.meta).toMatchObject({ status: 402, limitBytes: 1 });
    expect(Number(result.error.meta?.usedBytes)).toBeGreaterThan(1);
  });

  test("a pending migration fails with STORAGE_QUOTA_EXCEEDED", async () => {
    const result = await alice.sql.db("default").migrations.apply({
      namespace: NAMESPACE,
      migrations: [
        NOTES_MIGRATION,
        { id: "002_tags", sql: ["CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY)"] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  test("KV writes fail with STORAGE_QUOTA_EXCEEDED and deletes still work", async () => {
    const put = await alice.kv.put("notes/second", "rejected");
    expect(put.ok).toBe(false);
    expect(!put.ok && put.error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    const removed = await alice.kv.delete("notes/first");
    expect(removed.ok).toBe(true);
  });
});
