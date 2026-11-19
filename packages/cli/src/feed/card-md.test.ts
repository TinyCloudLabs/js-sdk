import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedReadDatabase } from "@tinycloud/sdk-services/feed";
import { cardMdChangedText, cardMdForPublish, rememberCardMdVersion, seenCardMdVersion } from "./card-md.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const profileDir = async () => { const dir = await mkdtemp(join(tmpdir(), "tc-card-md-")); directories.push(dir); return dir; };

const row = (text: string, version: string): FeedReadDatabase => ({
  query: async () => ({ ok: true, data: { columns: ["text", "version", "updated_at"], rows: [[text, version, "2026-11-19T01:00:00Z"]] as never, rowCount: 1 } }),
});
const refused: FeedReadDatabase = { query: async () => ({ ok: false, error: { code: "PERMISSION_DENIED", message: "denied", service: "sql" } }) };
const noTable: FeedReadDatabase = { query: async () => ({ ok: false, error: { code: "SQL_ERROR", message: "no such table: card_md", service: "sql" } }) };
const noRow: FeedReadDatabase = { query: async () => ({ ok: true, data: { columns: [], rows: [], rowCount: 0 } }) };

test("the full text is shown once per version, then only the version", async () => {
  const dir = await profileDir();
  const first = await cardMdForPublish(row("Keep cards short.", "aaaaaaaaaaaa"), dir, "agent_one");
  expect(first.cardMd).toEqual({ version: "aaaaaaaaaaaa" });
  expect(first.changed?.text).toBe("Keep cards short.");
  const again = await cardMdForPublish(row("Keep cards short.", "aaaaaaaaaaaa"), dir, "agent_one");
  expect(again).toEqual({ cardMd: { version: "aaaaaaaaaaaa" } });
  const edited = await cardMdForPublish(row("Keep cards very short.", "bbbbbbbbbbbb"), dir, "agent_one");
  expect(edited.changed?.text).toBe("Keep cards very short.");
});

test("two agent tokens in one profile each see the text once", async () => {
  const dir = await profileDir();
  await cardMdForPublish(row("x", "aaaaaaaaaaaa"), dir, "agent_one");
  expect((await cardMdForPublish(row("x", "aaaaaaaaaaaa"), dir, "agent_two")).changed?.text).toBe("x");
});

test("an owner who cleared card.md is a change, and says so", async () => {
  const dir = await profileDir();
  await cardMdForPublish(row("Old.", "aaaaaaaaaaaa"), dir, "agent_one");
  const cleared = await cardMdForPublish(row("", "e3b0c44298fc"), dir, "agent_one");
  expect(cleared.cardMd).toEqual({ version: "e3b0c44298fc" });
  expect(cardMdChangedText(cleared.changed!)).toBe("The owner's card.md changed (e3b0c44298fc): it's now empty.");
});

test("an unset, unreadable or refused card.md leaves the publish result alone", async () => {
  const dir = await profileDir();
  for (const db of [noRow, noTable, refused]) expect(await cardMdForPublish(db, dir, "agent_one")).toEqual({});
  const throwing: FeedReadDatabase = { query: async () => { throw new Error("network down"); } };
  expect(await cardMdForPublish(throwing, dir, "agent_one")).toEqual({});
});

test("a damaged or unwritable last-shown file only means the text may show again", async () => {
  const dir = await profileDir();
  await writeFile(join(dir, "feed-card-md-agent_one.json"), "{not json");
  expect(await seenCardMdVersion(dir, "agent_one")).toBeUndefined();
  expect((await cardMdForPublish(row("x", "aaaaaaaaaaaa"), dir, "agent_one")).changed?.text).toBe("x");
  // The folder is gone: the version is still returned and nothing throws.
  const missing = join(dir, "gone", "deeper");
  expect((await cardMdForPublish(row("x", "aaaaaaaaaaaa"), missing, "agent_one")).cardMd).toEqual({ version: "aaaaaaaaaaaa" });
});

test("the last-shown version is kept in an owner-only file", async () => {
  const dir = await profileDir();
  await rememberCardMdVersion(dir, "agent_one", "aaaaaaaaaaaa");
  const path = join(dir, "feed-card-md-agent_one.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: "aaaaaaaaaaaa" });
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});
