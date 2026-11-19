import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFeedCardMd } from "@tinycloud/sdk-services/feed";
import type { FeedCardMd, FeedReadDatabase } from "@tinycloud/sdk-services/feed";

const seenPath = (directory: string, agent: string) => join(directory, `feed-card-md-${agent}.json`);

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
  /** Goes into the publish result; absent when card.md is unset, unreadable, or its read failed. */
  cardMd?: { version: string };
  /** The full text to show once, present only when the version differs from the last one shown. */
  changed?: FeedCardMd;
}

/**
 * card.md as seen by a publish. It never throws: a connection made before card.md existed,
 * an unset card.md and every read error leave the publish result unchanged. A failure to save
 * the last-shown version only means the text may be shown again next time.
 */
export async function cardMdForPublish(db: FeedReadDatabase, directory: string, agent: string): Promise<PublishCardMd> {
  let card: FeedCardMd;
  try {
    const read = await readFeedCardMd(db);
    if (!read.ok || read.data === null) return {};
    card = read.data;
  } catch {
    return {};
  }
  if (await seenCardMdVersion(directory, agent) === card.version) return { cardMd: { version: card.version } };
  await rememberCardMdVersion(directory, agent, card.version).catch(() => undefined);
  return { cardMd: { version: card.version }, changed: card };
}

/** What stderr shows once per changed version. An owner who cleared card.md is a change too. */
export function cardMdChangedText(card: FeedCardMd): string {
  return card.text === "" ? `card.md changed (${card.version}): it is now empty.` : `card.md changed (${card.version}):\n${card.text}`;
}
