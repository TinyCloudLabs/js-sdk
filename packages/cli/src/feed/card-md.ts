import { createHash } from "node:crypto";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { readJson, writeJson } from "../config/storage.js";
import { cliErrorFromService } from "../output/errors.js";

/**
 * The owner's card.md, as the owner's Feed delivers it into each connected agent's own response database:
 * one row, `card_md(id INTEGER PRIMARY KEY, text, version, updated_at)` with `id = 1`. The agent only reads it.
 */
export interface CardMd {
  text: string;
  version: string;
  updatedAt: string;
}

/** `none`: no table or no row (the owner's Feed has not delivered one). `unreadable`: a row whose version is not its text's. */
export type CardMdRead = { kind: "none" } | { kind: "unreadable" } | { kind: "found"; card: CardMd };

/** First 12 lowercase hex characters of SHA-256 over the UTF-8 bytes of `text`, exactly as stored (no trimming). */
export function cardMdVersion(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export async function readCardMd(responses: FeedDatabase): Promise<CardMdRead> {
  const result = await responses.query<string>("SELECT text, version, updated_at FROM card_md WHERE id = 1");
  // The table appears the first time the owner's Feed delivers a card.md to this agent.
  if (!result.ok) {
    if (/no such table/i.test(result.error.message)) return { kind: "none" };
    throw cliErrorFromService(result.error);
  }
  const row = result.data.rows[0];
  if (!row) return { kind: "none" };
  const [text, version, updatedAt] = row;
  if (typeof text !== "string" || typeof version !== "string" || typeof updatedAt !== "string") return { kind: "unreadable" };
  if (cardMdVersion(text) !== version) return { kind: "unreadable" };
  return { kind: "found", card: { text, version, updatedAt } };
}

/**
 * The last card.md version this profile showed, per response resource, kept only on this computer.
 * A missing or damaged file reads as "nothing shown yet", so the next read shows the text once.
 */
export class ShownCardMdVersions {
  constructor(private readonly file: string) {}

  async get(resource: string): Promise<string | undefined> {
    let stored: unknown;
    try { stored = await readJson<unknown>(this.file); } catch { return undefined; }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
    const version = (stored as Record<string, unknown>)[resource];
    return typeof version === "string" ? version : undefined;
  }

  async set(resource: string, version: string): Promise<void> {
    let stored: unknown;
    try { stored = await readJson<unknown>(this.file); } catch { stored = null; }
    const current = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    await writeJson(this.file, { ...current, [resource]: version });
  }
}

export interface CardMdNoticeOptions {
  responses: FeedDatabase;
  shown: ShownCardMdVersions;
  /** Key for "last shown": the profile's response resource, so two feeds on one profile don't share it. */
  resource: string;
  write: (text: string) => void;
}

/**
 * Print the owner's card.md once per version: the first time this profile sees a version, and whenever it changes.
 * No card.md, an empty one (the owner cleared it on purpose) and an unchanged version print nothing; an empty
 * version is still remembered, so a later non-empty text counts as changed. Returns whether it printed the text.
 */
export async function noticeCardMd(options: CardMdNoticeOptions): Promise<boolean> {
  const read = await readCardMd(options.responses);
  if (read.kind === "none") return false;
  if (read.kind === "unreadable") {
    options.write("The owner's card.md in this feed does not match its version, so it was ignored.\n");
    return false;
  }
  const { card } = read;
  if ((await options.shown.get(options.resource)) === card.version) return false;
  if (card.text === "") {
    await options.shown.set(options.resource, card.version);
    return false;
  }
  options.write(`The owner's card.md changed (${card.version}):\n${card.text}${card.text.endsWith("\n") ? "" : "\n"}`);
  await options.shown.set(options.resource, card.version);
  return true;
}
