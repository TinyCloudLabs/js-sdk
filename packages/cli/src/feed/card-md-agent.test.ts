import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFeedCardMd } from "@tinycloud/sdk-services/feed";
import type { FeedReadDatabase } from "@tinycloud/sdk-services/feed";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import { CARD_MD_DEFAULT, CARD_MD_DEFAULT_VERSION } from "./card-md-default.js";
import { cardMdChangedText, cardMdOrDefaultForPublish, copyCardMdToAgent, markDefault } from "./card-md.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const profileDir = async () => { const dir = await mkdtemp(join(tmpdir(), "tc-card-md-agent-")); directories.push(dir); return dir; };

const TABLE = "CREATE TABLE card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)";
const ownerWith = async (text: string, version: string) => {
  const owner = sqliteHandle();
  unwrap(await owner.handle.execute(TABLE));
  unwrap(await owner.handle.execute("INSERT INTO card_md VALUES (1, ?, ?, ?)", [text, version, "2026-11-19T01:00:00Z"]));
  return owner;
};
const noTable: FeedReadDatabase = { query: async () => ({ ok: false, error: { code: "SQL_ERROR", message: "no such table: card_md", service: "sql" } }) };
const refused: FeedReadDatabase = { query: async () => ({ ok: false, error: { code: "PERMISSION_DENIED", message: "denied", service: "sql" } }) };
const row = (text: string, version: string): FeedReadDatabase => ({
  query: async () => ({ ok: true, data: { columns: ["text", "version", "updated_at"], rows: [[text, version, "2026-11-19T01:00:00Z"]] as never, rowCount: 1 } }),
});

test("connecting an agent copies the owner's card.md into its response database, and a later copy of the same version changes nothing", async () => {
  const owner = await ownerWith("Keep cards short.", "aaaaaaaaaaaa");
  const agent = sqliteHandle();
  try {
    expect(await copyCardMdToAgent(owner.handle, agent.handle)).toBe(true);
    const copied = unwrap(await readFeedCardMd(agent.handle));
    expect(copied).toEqual({ text: "Keep cards short.", version: "aaaaaaaaaaaa", updatedAt: "2026-11-19T01:00:00Z" });
    // The Feed's own copy later is the same upsert: same version, no change.
    expect(await copyCardMdToAgent(owner.handle, agent.handle)).toBe(true);
    expect(unwrap(await readFeedCardMd(agent.handle))).toEqual(copied);
    // A newer owner version replaces it.
    unwrap(await owner.handle.execute("UPDATE card_md SET text = ?, version = ? WHERE id = 1", ["Keep cards very short.", "bbbbbbbbbbbb"]));
    await copyCardMdToAgent(owner.handle, agent.handle);
    expect(unwrap(await readFeedCardMd(agent.handle))?.version).toBe("bbbbbbbbbbbb");
  } finally { owner.close(); agent.close(); }
});

test("an agent connected while the owner has no card.md (the Feed is closed) still gets one: the bundled default, marked default", async () => {
  const agent = sqliteHandle();
  const dir = await profileDir();
  try {
    expect(await copyCardMdToAgent(noTable, agent.handle)).toBe(true);
    const stored = unwrap(await readFeedCardMd(agent.handle));
    expect(stored).toMatchObject({ text: CARD_MD_DEFAULT, version: CARD_MD_DEFAULT_VERSION });
    // Read back through the agent's own path, the copy is the default, not an owner's card.md.
    const shown = await cardMdOrDefaultForPublish(agent.handle, dir, "agent_connected");
    expect(shown.cardMd).toEqual({ version: CARD_MD_DEFAULT_VERSION, default: true });
    expect(shown.changed).toEqual({ text: CARD_MD_DEFAULT, version: CARD_MD_DEFAULT_VERSION, default: true });
    expect(markDefault(stored!)).toEqual({ text: CARD_MD_DEFAULT, version: CARD_MD_DEFAULT_VERSION, default: true });
  } finally { agent.close(); }
});

test("the default copy never replaces a card.md the agent's database already has, and the owner's card.md replaces the default", async () => {
  const agent = sqliteHandle();
  const owner = await ownerWith("Keep cards short.", "aaaaaaaaaaaa");
  try {
    expect(await copyCardMdToAgent(owner.handle, agent.handle)).toBe(true);
    expect(await copyCardMdToAgent(noTable, agent.handle)).toBe(true);
    expect(unwrap(await readFeedCardMd(agent.handle))?.version).toBe("aaaaaaaaaaaa");
    const fresh = sqliteHandle();
    try {
      await copyCardMdToAgent(noTable, fresh.handle);
      await copyCardMdToAgent(owner.handle, fresh.handle);
      expect(unwrap(await readFeedCardMd(fresh.handle))).toMatchObject({ text: "Keep cards short.", version: "aaaaaaaaaaaa" });
    } finally { fresh.close(); }
  } finally { owner.close(); agent.close(); }
});

test("an owner's card.md that cannot be read copies nothing, and never stops the connection", async () => {
  const agent = sqliteHandle();
  try {
    expect(await copyCardMdToAgent(refused, agent.handle)).toBe(false);
    const tables = unwrap(await agent.handle.query<string>("SELECT name FROM sqlite_master WHERE name = 'card_md'"));
    expect(tables.rowCount).toBe(0);
  } finally { agent.close(); }
});

test("an agent with no card_md row reads the bundled default, marked default, once", async () => {
  const dir = await profileDir();
  const first = await cardMdOrDefaultForPublish(noTable, dir, "agent_one");
  expect(first.cardMd).toEqual({ version: CARD_MD_DEFAULT_VERSION, default: true });
  expect(first.changed?.text).toBe(CARD_MD_DEFAULT);
  expect(cardMdChangedText(first.changed!).startsWith(`The owner hasn't set a card.md, so this is the default (${CARD_MD_DEFAULT_VERSION}):\n# card.md`)).toBe(true);
  const again = await cardMdOrDefaultForPublish(noTable, dir, "agent_one");
  expect(again).toEqual({ cardMd: { version: CARD_MD_DEFAULT_VERSION, default: true } });
});

test("when the owner's copy arrives it shows once as a change, no longer marked default", async () => {
  const dir = await profileDir();
  await cardMdOrDefaultForPublish(noTable, dir, "agent_one");
  const arrived = await cardMdOrDefaultForPublish(row("Keep cards short.", "aaaaaaaaaaaa"), dir, "agent_one");
  expect(arrived.cardMd).toEqual({ version: "aaaaaaaaaaaa" });
  expect(cardMdChangedText(arrived.changed!)).toBe("The owner's card.md changed (aaaaaaaaaaaa):\nKeep cards short.");
  expect(await cardMdOrDefaultForPublish(row("Keep cards short.", "aaaaaaaaaaaa"), dir, "agent_one")).toEqual({ cardMd: { version: "aaaaaaaaaaaa" } });
});

test("a refused read leaves the result alone instead of claiming the owner has nothing set", async () => {
  expect(await cardMdOrDefaultForPublish(refused, await profileDir(), "agent_one")).toEqual({});
});
