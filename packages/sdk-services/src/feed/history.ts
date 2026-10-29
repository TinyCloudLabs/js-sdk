import { ErrorCodes, ok } from "../types";
import type { SqlValue } from "../sql/types";
import { feedCardSchema } from "./schemas";
import { feedError, responseDataFailure } from "./store";
import type { FeedApi, FeedCard, FeedCardIdentity } from "./types";

function validIdentity(value: FeedCardIdentity): boolean {
  return value !== null && typeof value === "object" &&
    typeof value.cardId === "string" && value.cardId.length > 0 &&
    Number.isSafeInteger(value.revision) && value.revision > 0 &&
    typeof value.issuanceId === "string" && value.issuanceId.length > 0;
}

export const listFeedCardHistory: FeedApi["listFeedCardHistory"] = async (output, options = {}) => {
  try {
    const { afterIdentity, signal } = options;
    const limit = options.limit === undefined ? 100 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
      (afterIdentity !== undefined && !validIdentity(afterIdentity))) {
      return feedError(ErrorCodes.INVALID_INPUT, "Card history requires a full identity cursor and valid page limit");
    }
    if (signal?.aborted) return feedError(ErrorCodes.ABORTED, "Card history read was cancelled");
    const params: SqlValue[] = afterIdentity
      ? [afterIdentity.cardId, afterIdentity.revision, afterIdentity.issuanceId, limit + 1]
      : [limit + 1];
    // This full-tuple snapshot cursor is not a monotonic publication cursor.
    const result = await output.query<unknown>(`SELECT card_id, revision, issuance_id, card_json FROM feed_cards
      ${afterIdentity ? "WHERE (card_id COLLATE BINARY, revision, issuance_id COLLATE BINARY) > (?, ?, ?)" : ""}
      ORDER BY card_id COLLATE BINARY, revision, issuance_id COLLATE BINARY LIMIT ?`, params, { redactErrors: true, signal });
    if (!result.ok) return responseDataFailure("Could not read feed card history", result.error);
    if (signal?.aborted) return feedError(ErrorCodes.ABORTED, "Card history read was cancelled");
    const cards: FeedCard[] = [];
    const count = Math.min(limit, result.data.rows.length);
    for (let index = 0; index < count; index += 1) {
      const row = result.data.rows[index];
      if (typeof row[3] !== "string") throw new Error("Stored card envelope is invalid");
      const card = feedCardSchema.parse(JSON.parse(row[3]));
      if (!validIdentity(card) || row[0] !== card.cardId || row[1] !== card.revision || row[2] !== card.issuanceId) {
        throw new Error("Stored card identity does not match its key");
      }
      cards.push(card);
    }
    const last = cards[cards.length - 1];
    return ok({
      cards,
      nextIdentity: last ? { cardId: last.cardId, revision: last.revision, issuanceId: last.issuanceId } : null,
      hasMore: result.data.rows.length > limit,
    });
  } catch (error) {
    return responseDataFailure("Could not verify feed card history", error);
  }
};
