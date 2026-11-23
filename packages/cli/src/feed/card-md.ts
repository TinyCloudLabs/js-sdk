import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFeedCardMd } from "@tinycloud/sdk-services/feed";
import type { FeedCardMd, FeedDatabase, FeedReadDatabase } from "@tinycloud/sdk-services/feed";
import { CARD_MD_DEFAULT, CARD_MD_DEFAULT_VERSION } from "./card-md-default.js";
import { safeBlock, safeInline } from "../output/safe-text.js";

/** What an agent reads when the owner has not set a card.md: the Feed's default, marked as such. */
export const DEFAULT_CARD_MD = { text: CARD_MD_DEFAULT, version: CARD_MD_DEFAULT_VERSION, default: true as const };

/** A card.md as shown to an agent; `default` is set only on the bundled default. */
export type ShownCardMd = Pick<FeedCardMd, "text" | "version"> & { default?: true };

// encodeURIComponent: a token with a path separator cannot leave the profile directory.
const seenPath = (directory: string, agent: string) => join(directory, `feed-card-md-${encodeURIComponent(agent)}.json`);

/** The card.md version this profile last showed for this agent token, or undefined. A damaged file counts as never shown. */
export async function seenCardMdVersion(directory: string, agent: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(seenPath(directory, agent), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberCardMdVersion(directory: string, agent: string, version: string): Promise<void> {
  const target = seenPath(directory, agent);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

export interface PublishCardMd {
  /** Goes into the publish result; absent when card.md or its default cannot be read. `default` marks the bundled default. */
  cardMd?: { version: string; default?: true };
  /** The full text to show once, present only when the version differs from the last one shown. */
  changed?: ShownCardMd;
}

/** The copy of the bundled default that `feed connect` writes into an agent's database carries the default's version: it reads back as the default. */
export function markDefault(card: FeedCardMd): ShownCardMd {
  return card.version === CARD_MD_DEFAULT_VERSION ? { text: card.text, version: card.version, default: true } : card;
}

async function showOnce(card: ShownCardMd, directory: string, agent: string): Promise<PublishCardMd> {
  const cardMd = card.default === true ? { version: card.version, default: true as const } : { version: card.version };
  if (await seenCardMdVersion(directory, agent) === card.version) return { cardMd };
  await rememberCardMdVersion(directory, agent, card.version).catch(() => undefined);
  return { cardMd, changed: card };
}

/**
 * card.md as seen by a publish. It never throws: a connection made before card.md existed,
 * an unset card.md and every read error leave the publish result unchanged. A failure to save
 * the last-shown version only means the text may be shown again next time.
 */
export async function cardMdForPublish(db: FeedReadDatabase, directory: string, agent: string): Promise<PublishCardMd> {
  let card: ShownCardMd;
  try {
    const read = await readFeedCardMd(db);
    if (!read.ok || read.data === null) return {};
    card = markDefault(read.data);
  } catch {
    return {};
  }
  return showOnce(card, directory, agent);
}

/**
 * As cardMdForPublish, but an agent whose owner has not set a card.md (no table or no row) gets the bundled
 * default, marked `default`, once. When the owner's copy arrives its version differs and it shows as a change.
 * A read that fails is still left alone: the default would claim the owner has nothing set.
 */
export async function cardMdOrDefaultForPublish(db: FeedReadDatabase, directory: string, agent: string): Promise<PublishCardMd> {
  let card: ShownCardMd;
  try {
    const read = await readFeedCardMd(db);
    if (!read.ok) return {};
    card = read.data === null ? DEFAULT_CARD_MD : markDefault(read.data);
  } catch {
    return {};
  }
  return showOnce(card, directory, agent);
}

/**
 * What stderr shows once per changed version. An owner who cleared card.md is a change too. The text is the owner's,
 * but it reaches a terminal, so control, escape and bidi characters are shown as escapes (newlines and tabs stay).
 */
export function cardMdChangedText(card: ShownCardMd): string {
  const version = safeInline(card.version);
  if (card.default === true) return `The owner hasn't set a card.md, so this is the default (${version}):\n${safeBlock(card.text)}`;
  return card.text === "" ? `The owner's card.md changed (${version}): it's now empty.` : `The owner's card.md changed (${version}):\n${safeBlock(card.text)}`;
}

// The same table the Feed uses for every copy. The owner's master card.md is outside the Feed's namespace and no
// Feed login can read it, so the Feed's own delivery is what puts the owner's text here.
// No CHECK: the node's SQL authorizer refuses a CHECK that reads a column.
const CARD_MD_SCHEMA = `CREATE TABLE IF NOT EXISTS card_md (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
)`;

// The default never replaces a row the agent's database already has: the Feed may have delivered the owner's text first.
const CARD_MD_INSERT_DEFAULT = `INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`;

/**
 * Gives a newly connected agent's response database the bundled default card.md, so an agent connected while the Feed is
 * closed still has one; its version is the default's, which the agent reads back as `default`. The owner's Feed replaces
 * it with the owner's text on its next run. Returns whether it wrote. A failure never stops the connection.
 */
export async function seedDefaultCardMd(agentResponses: FeedDatabase): Promise<boolean> {
  try {
    const written = await agentResponses.batch([
      { sql: CARD_MD_SCHEMA },
      { sql: CARD_MD_INSERT_DEFAULT, params: [DEFAULT_CARD_MD.text, DEFAULT_CARD_MD.version, new Date().toISOString()] },
    ]);
    return written.ok;
  } catch {
    return false;
  }
}
