import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardMdVersion, noticeCardMd, readCardMd, ShownCardMdVersions } from "./card-md";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedDatabase } from "../../../sdk-services/src/feed";

const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// The table exactly as the owner's Feed creates it in each agent's response database.
const CREATE = "CREATE TABLE card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)";

async function database(row?: { text: string; version?: string; updatedAt?: string }) {
  const { handle, close } = sqliteHandle();
  closers.push(close);
  unwrap(await handle.execute(CREATE));
  if (row) {
    unwrap(await handle.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)",
      [row.text, row.version ?? cardMdVersion(row.text), row.updatedAt ?? "2026-11-19T05:00:00.000Z"]));
  }
  return handle;
}
async function setRow(handle: FeedDatabase, text: string, version = cardMdVersion(text)) {
  unwrap(await handle.execute("DELETE FROM card_md"));
  unwrap(await handle.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)", [text, version, "2026-11-19T06:00:00.000Z"]));
}
function state() {
  const directory = mkdtempSync(join(tmpdir(), "card-md-state-"));
  directories.push(directory);
  const file = join(directory, "feed-card-md.json");
  return { file, shown: new ShownCardMdVersions(file) };
}
function notice(responses: FeedDatabase, shown: ShownCardMdVersions, resource = "app/feed/feed_responses_demo") {
  const written: string[] = [];
  return noticeCardMd({ responses, shown, resource, write: (text) => { written.push(text); } }).then((printed) => ({ printed, stderr: written.join("") }));
}

test("the version is the first 12 hex characters of SHA-256 over the text exactly as stored", () => {
  expect(cardMdVersion("")).toBe("e3b0c44298fc");
  expect(cardMdVersion("hello")).toBe("2cf24dba5fb0");
  // No trimming and no newline normalisation: these are different texts.
  expect(new Set([cardMdVersion("a"), cardMdVersion("a\n"), cardMdVersion("a\r\n"), cardMdVersion(" a")]).size).toBe(4);
  // UTF-8 bytes, not UTF-16 units.
  expect(cardMdVersion("é")).toBe("4a99557e4033");
});

test("a table that does not exist yet and a table with no row both mean nothing to show", async () => {
  const noTable: FeedDatabase = {
    ...(await database()), query: async () => ({ ok: false as const, error: { code: "SQL_ERROR", message: "SQLite error: no such table: card_md", service: "sql" } }),
  };
  expect(await readCardMd(noTable)).toEqual({ kind: "none" });
  expect(await readCardMd(await database())).toEqual({ kind: "none" });
  const { shown, file } = state();
  expect(await notice(noTable, shown)).toEqual({ printed: false, stderr: "" });
  expect(await notice(await database(), shown)).toEqual({ printed: false, stderr: "" });
  expect(() => statSync(file)).toThrow();
});

test("any other read failure is an error for the caller, not an empty card.md", async () => {
  const refused: FeedDatabase = {
    ...(await database()), query: async () => ({ ok: false as const, error: { code: "PERMISSION_DENIED", message: "not authorized", service: "sql" } }),
  };
  await expect(readCardMd(refused)).rejects.toMatchObject({ message: expect.stringContaining("not authorized") });
});

test("the first read shows the full text once, an unchanged version is silent, a changed version shows the new text once", async () => {
  const text = "Post at most two cards a day.\nKeep titles under 60 characters.\n";
  const handle = await database({ text });
  const { shown } = state();
  const first = await notice(handle, shown);
  expect(first.printed).toBe(true);
  expect(first.stderr).toBe(`The owner's card.md changed (${cardMdVersion(text)}):\n${text}`);
  expect(await notice(handle, shown)).toEqual({ printed: false, stderr: "" });

  await setRow(handle, "Only post decisions.");
  const next = await notice(handle, shown);
  expect(next.stderr).toBe(`The owner's card.md changed (${cardMdVersion("Only post decisions.")}):\nOnly post decisions.\n`);
  expect(await notice(handle, shown)).toEqual({ printed: false, stderr: "" });
});

test("a long owner text is printed in full, never cut", async () => {
  const text = `${"Prefer short cards. ".repeat(400)}END`;
  const { stderr } = await notice(await database({ text }), state().shown);
  expect(stderr).toContain(text);
  expect(stderr.endsWith("END\n")).toBe(true);
});

test("an empty text prints nothing but is remembered, so a later text counts as changed", async () => {
  const handle = await database({ text: "" });
  const { shown } = state();
  expect(await readCardMd(handle)).toMatchObject({ kind: "found", card: { text: "", version: "e3b0c44298fc" } });
  expect(await notice(handle, shown)).toEqual({ printed: false, stderr: "" });
  expect(await shown.get("app/feed/feed_responses_demo")).toBe("e3b0c44298fc");
  await setRow(handle, "Back to the rules.");
  expect((await notice(handle, shown)).printed).toBe(true);
});

test("a row whose version is not its text's is ignored with one line and remembers nothing", async () => {
  const handle = await database({ text: "Edited by hand", version: "000000000000" });
  const { shown, file } = state();
  expect(await readCardMd(handle)).toEqual({ kind: "unreadable" });
  const result = await notice(handle, shown);
  expect(result.printed).toBe(false);
  expect(result.stderr).toBe("The owner's card.md in this feed does not match its version, so it was ignored.\n");
  expect(() => statSync(file)).toThrow();
  await setRow(handle, "Fixed text");
  expect((await notice(handle, shown)).printed).toBe(true);
});

test("the last shown version is kept per response resource, so two feeds on one profile don't share it", async () => {
  const handle = await database({ text: "Same text for both" });
  const { shown } = state();
  expect((await notice(handle, shown, "app/feed/feed_responses_one")).printed).toBe(true);
  expect((await notice(handle, shown, "app/feed/feed_responses_two")).printed).toBe(true);
  expect((await notice(handle, shown, "app/feed/feed_responses_one")).printed).toBe(false);
});

test("the remembered version is a private file on this computer and holds no card text", async () => {
  const text = "Private owner preference";
  const { shown, file } = state();
  await notice(await database({ text }), shown);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "app/feed/feed_responses_demo": cardMdVersion(text) });
  expect(readFileSync(file, "utf8")).not.toContain(text);
});

test("a damaged state file reads as nothing shown yet: the text is shown once more and the file is repaired", async () => {
  const handle = await database({ text: "Rules" });
  const { shown, file } = state();
  writeFileSync(file, "{not json");
  expect((await notice(handle, shown)).printed).toBe(true);
  expect((await notice(handle, shown)).printed).toBe(false);
});
