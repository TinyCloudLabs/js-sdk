import { ok } from "../types";
import type { Result } from "../types";
import { feedError } from "./store";
import type { FeedReadDatabase } from "./types";

export interface FeedCardMd {
  text: string;
  /** First 12 hex characters of the SHA-256 of the UTF-8 text; the only thing compared to decide "changed". */
  version: string;
  updatedAt: string;
}

/**
 * Read the owner's card.md from an agent's response database, where the owner's app keeps a copy
 * (table `card_md`, one row with id 1). The agent's existing read grant on that database is enough.
 *
 * `null` means it is not set: no table or no row. An owner who cleared card.md has a row with empty
 * text, which is returned as such so that clearing is a version change. Any other failure is
 * returned as an error, never as `null`.
 */
export async function readFeedCardMd(responses: FeedReadDatabase): Promise<Result<FeedCardMd | null>> {
  const result = await responses.query<unknown>("SELECT text, version, updated_at FROM card_md WHERE id = 1");
  if (!result.ok) return /no such table/i.test(result.error.message) ? ok(null) : result;
  const row = result.data.rows[0];
  if (!row) return ok(null);
  const [text, version, updatedAt] = row;
  if (typeof text !== "string" || typeof version !== "string" || typeof updatedAt !== "string") {
    return feedError("INVALID_INPUT", "The card.md record is not text, a version and an update time");
  }
  return ok({ text, version, updatedAt });
}
