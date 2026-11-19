import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFeedCardMd } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedReadDatabase } from "./types";

const version = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
const create = `CREATE TABLE card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const failing = (code: string, message: string): FeedReadDatabase => ({
  query: async () => ({ ok: false, error: { code, message, service: "sql" } }),
});

test("a stored card.md is returned with its version and update time", async () => {
  const db = sqliteHandle();
  await db.handle.execute(create);
  await db.handle.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)", ["Post short cards.", version("Post short cards."), "2026-11-19T01:00:00Z"]);
  expect(unwrap(await readFeedCardMd(db.handle))).toEqual({
    text: "Post short cards.", version: version("Post short cards."), updatedAt: "2026-11-19T01:00:00Z",
  });
  db.close();
});

test("an owner who cleared card.md gives empty text with its own version, not null", async () => {
  const db = sqliteHandle();
  await db.handle.execute(create);
  await db.handle.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, '', ?, ?)", [version(""), "2026-11-19T02:00:00Z"]);
  const cleared = unwrap(await readFeedCardMd(db.handle));
  expect(cleared).toEqual({ text: "", version: "e3b0c44298fc", updatedAt: "2026-11-19T02:00:00Z" });
  db.close();
});

test("no row is not set", async () => {
  const db = sqliteHandle();
  await db.handle.execute(create);
  expect(unwrap(await readFeedCardMd(db.handle))).toBeNull();
  db.close();
});

test("no table is not set", async () => {
  expect(unwrap(await readFeedCardMd(failing("SQL_ERROR", "no such table: card_md")))).toBeNull();
});

test("a connection without the read grant is an error, never reported as not set", async () => {
  const result = await readFeedCardMd(failing("PERMISSION_DENIED", "not authorized"));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
});

test("a record that is not text, a version and a time is refused", async () => {
  const db = sqliteHandle();
  await db.handle.execute("CREATE TABLE card_md (id INTEGER PRIMARY KEY, text, version, updated_at)");
  await db.handle.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, NULL, 'abc', 'now')");
  const result = await readFeedCardMd(db.handle);
  expect(result.ok).toBe(false);
  db.close();
});
