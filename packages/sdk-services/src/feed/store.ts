import { ErrorCodes, err, ok } from "../types";
import type { Result } from "../types";
import type { QueryOptions, SqlStatement, SqlValue } from "../sql/types";
import type {
  FeedApi, FeedCard, FeedCardIdentity, FeedHandling, FeedReadDatabase, FeedResponse, FeedResponsePayload, NewFeedResponse,
} from "./types";
import { feedResponsePayloadSchema, newFeedResponseSchema } from "./schemas";
import { projectFeedResponseNotification } from "./notification";

const PRIVATE_RESPONSE_OPTIONS: QueryOptions & { redactErrors: true } = { redactErrors: true };

export function feedError(code: string, message: string): Result<never> {
  return err({ code, message, service: "feed" });
}

// Canonical JSON makes identity replay independent of object-key insertion order.
export function feedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const sorted: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
      return sorted;
    }
    return item;
  });
}

function validIdentity(identity: FeedCardIdentity): boolean {
  return typeof identity.cardId === "string" && identity.cardId.length > 0 &&
    Number.isSafeInteger(identity.revision) && identity.revision > 0 &&
    typeof identity.issuanceId === "string" && identity.issuanceId.length > 0;
}

export function sameFeedIdentity(a: FeedCardIdentity, b: FeedCardIdentity): boolean {
  return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId;
}

async function jsonRows<T>(
  db: FeedReadDatabase, sql: string, params: SqlValue[] = [], options?: QueryOptions,
): Promise<Result<T[]>> {
  const result = await db.query<string>(sql, params, options);
  if (!result.ok) return result;
  try {
    return ok(result.data.rows.map((row) => JSON.parse(row[0]) as T));
  } catch {
    return feedError("INVALID_INPUT", "Feed record contains invalid JSON");
  }
}

const RESPONSE_HEADER_SELECT = `SELECT r.sequence, r.response_json, p.payload_type, p.payload_version
  FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id`;

function responseDataFailure(message: string, error?: unknown): Result<never> {
  let code: string = ErrorCodes.SQL_ERROR;
  if (error !== null && typeof error === "object" && "code" in error) {
    const candidate = error.code;
    if (typeof candidate === "string" && Object.values(ErrorCodes).some((known) => known === candidate)) code = candidate;
  }
  // Never retain raw payload-bearing SQL messages, causes, stacks, or metadata.
  return feedError(code, message);
}

function responseFromRow(row: unknown[]): FeedResponse {
  const header = newFeedResponseSchema.parse(JSON.parse(String(row[1])));
  const response: FeedResponse = { ...header, sequence: Number(row[0]) };
  if (row[2] !== null && row[2] !== undefined) {
    response.payloadType = String(row[2]);
    response.payloadVersion = Number(row[3]);
  }
  return projectFeedResponseNotification(response);
}

async function storedResponse(db: FeedReadDatabase, responseId: string) {
  try {
    const result = await db.query<unknown>(`SELECT r.sequence, r.response_json, p.payload_type, p.payload_version, p.payload_json
      FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id
      WHERE r.response_id = ?`, [responseId], PRIVATE_RESPONSE_OPTIONS);
    if (!result.ok) return responseDataFailure("Could not read the saved feed response", result.error);
    const row = result.data.rows[0];
    if (!row) return ok(undefined);
    const response = responseFromRow(row);
    const payload: FeedResponsePayload | undefined = row[2] === null || row[2] === undefined ? undefined
      : feedResponsePayloadSchema.parse({ type: row[2], version: Number(row[3]), data: JSON.parse(String(row[4])) });
    return ok({ response, headerJson: feedJson(newFeedResponseSchema.parse(response)), payload });
  } catch (error) {
    return responseDataFailure("Could not read the saved feed response", error);
  }
}

export const initializeFeedDatabases: FeedApi["initializeFeedDatabases"] = async ({ output, responses }) => {
  const initialized = await output.batch([
    { sql: `CREATE TABLE IF NOT EXISTS feed_cards (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), issuance_id TEXT NOT NULL,
      card_json TEXT NOT NULL, UNIQUE (card_id, revision, issuance_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS feed_handling (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, handling_id TEXT NOT NULL UNIQUE,
      response_id TEXT NOT NULL, card_id TEXT NOT NULL, revision INTEGER NOT NULL, issuance_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('acknowledged', 'succeeded', 'failed')),
      handling_json TEXT NOT NULL
    )` },
    { sql: "CREATE INDEX IF NOT EXISTS feed_handling_response ON feed_handling (response_id, sequence)" },
  ]);
  if (!initialized.ok) return initialized;
  const responseSchema = await responses.batch([
    { sql: `CREATE TABLE IF NOT EXISTS feed_responses (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, response_id TEXT NOT NULL UNIQUE,
      card_id TEXT NOT NULL, revision INTEGER NOT NULL, issuance_id TEXT NOT NULL,
      response_json TEXT NOT NULL
    )` },
    { sql: "CREATE INDEX IF NOT EXISTS feed_responses_card ON feed_responses (card_id, revision, issuance_id, sequence)" },
    { sql: `CREATE TABLE IF NOT EXISTS feed_response_payloads (
      response_id TEXT PRIMARY KEY, payload_type TEXT NOT NULL, payload_version INTEGER NOT NULL, payload_json TEXT NOT NULL
    )` },
  ]);
  return responseSchema.ok ? ok(undefined) : responseSchema;
};

export const publishFeedCard: FeedApi["publishFeedCard"] = async (output, card) => {
  if (!validIdentity(card)) return feedError("INVALID_INPUT", "A card requires its full ID, positive revision and issuance ID");
  const encoded = feedJson(card);
  const inserted = await output.execute(
    `INSERT INTO feed_cards (card_id, revision, issuance_id, card_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (card_id, revision, issuance_id) DO NOTHING`,
    [card.cardId, card.revision, card.issuanceId, encoded],
  );
  if (!inserted.ok) return inserted;
  const stored = await jsonRows<FeedCard>(output,
    "SELECT card_json FROM feed_cards WHERE card_id = ? AND revision = ? AND issuance_id = ?",
    [card.cardId, card.revision, card.issuanceId]);
  if (!stored.ok) return stored;
  if (!stored.data[0] || feedJson(stored.data[0]) !== encoded) {
    return feedError("INVALID_INPUT", "A published card identity cannot be silently changed");
  }
  return ok(stored.data[0]);
};

export const listFeedCards: FeedApi["listFeedCards"] = async (output) => {
  return jsonRows<FeedCard>(output, `SELECT card_json FROM feed_cards
    WHERE sequence IN (SELECT MAX(sequence) FROM feed_cards GROUP BY card_id) ORDER BY sequence DESC`);
};

export const appendFeedResponse: FeedApi["appendFeedResponse"] = async (output, responses, input, inputPayload) => {
  let payload: FeedResponsePayload | undefined;
  let response: NewFeedResponse;
  try {
    const header = newFeedResponseSchema.safeParse(input);
    if (!header.success) return feedError("INVALID_INPUT", "Invalid feed response header");
    response = header.data;
    if (inputPayload !== undefined) {
      const parsed = feedResponsePayloadSchema.safeParse(inputPayload);
      if (!parsed.success) return feedError("INVALID_INPUT", "Invalid private feed response payload");
      payload = parsed.data;
    }
  } catch {
    return feedError("INVALID_INPUT", "Invalid feed response or private payload");
  }
  try {
    const cards = await jsonRows<FeedCard>(output,
      "SELECT card_json FROM feed_cards WHERE card_id = ? AND revision = ? AND issuance_id = ?",
      [response.cardId, response.revision, response.issuanceId], PRIVATE_RESPONSE_OPTIONS);
    if (!cards.ok) return responseDataFailure("Could not verify the response card issuance", cards.error);
    const card = cards.data[0];
    if (!card || !sameFeedIdentity(card, response) || !card.needsResponse) {
      return feedError("INVALID_INPUT", "The response does not identify a published actionable card issuance");
    }
    if (response.choiceId !== undefined && !card.choices?.some((choice) => choice.id === response.choiceId)) {
      return feedError("INVALID_INPUT", "The response choice is not part of this card issuance");
    }
    if (response.supersedesResponseId) {
      const previous = await jsonRows<FeedResponse>(responses,
        "SELECT response_json FROM feed_responses WHERE response_id = ?", [response.supersedesResponseId], PRIVATE_RESPONSE_OPTIONS);
      if (!previous.ok) return responseDataFailure("Could not verify the corrected response", previous.error);
      if (!previous.data[0] || !sameFeedIdentity(previous.data[0], response)) {
        return feedError("INVALID_INPUT", "A correction must reference a response to the same card issuance");
      }
    }
    const encoded = feedJson(response);
    const match = (stored: { response: FeedResponse; headerJson: string; payload?: FeedResponsePayload }) => {
      const samePayload = payload === undefined ? stored.payload === undefined
        : stored.payload !== undefined && feedJson(stored.payload) === feedJson(payload);
      return stored.headerJson === encoded && samePayload ? ok(stored.response)
        : feedError("INVALID_INPUT", "A response ID cannot be reused for different header or private payload content");
    };
    const existing = await storedResponse(responses, response.responseId);
    if (!existing.ok) return existing;
    if (existing.data) return match(existing.data);
    const statements: SqlStatement[] = [{
      sql: "INSERT INTO feed_responses (response_id, card_id, revision, issuance_id, response_json) VALUES (?, ?, ?, ?, ?)",
      params: [response.responseId, response.cardId, response.revision, response.issuanceId, encoded],
    }];
    if (payload !== undefined) statements.push({
      sql: "INSERT INTO feed_response_payloads (response_id, payload_type, payload_version, payload_json) VALUES (?, ?, ?, ?)",
      params: [response.responseId, payload.type, payload.version, feedJson(payload.data)],
    });
    let failed = false;
    let failure: unknown;
    try {
      // A duplicate header aborts this entire transaction; it cannot attach a late payload.
      const saved = await responses.batch(statements, PRIVATE_RESPONSE_OPTIONS);
      if (!saved.ok) { failed = true; failure = saved.error; }
    } catch (error) { failed = true; failure = error; }
    const committed = await storedResponse(responses, response.responseId);
    if (!committed.ok) return failed
      ? responseDataFailure("Could not save the feed response and private payload", failure) : committed;
    if (!committed.data) return responseDataFailure("Could not save the feed response and private payload", failure);
    // Concurrent identical creation is an idempotent replay only after both records match.
    return match(committed.data);
  } catch (error) {
    return responseDataFailure("Could not save the feed response and private payload", error);
  }
};

export const readFeedResponsePayload: FeedApi["readFeedResponsePayload"] = async (responses, identity) => {
  if (!validIdentity(identity) || typeof identity.responseId !== "string" || !identity.responseId) {
    return feedError("INVALID_INPUT", "A private payload read requires the full response and card identity");
  }
  try {
    const result = await responses.query<unknown>(`SELECT p.payload_type, p.payload_version, p.payload_json
      FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id
      WHERE r.response_id = ? AND r.card_id = ? AND r.revision = ? AND r.issuance_id = ?`,
    [identity.responseId, identity.cardId, identity.revision, identity.issuanceId], PRIVATE_RESPONSE_OPTIONS);
    if (!result.ok) return responseDataFailure("Could not read the private feed response payload", result.error);
    const row = result.data.rows[0];
    if (!row) return feedError("NOT_FOUND", "The response identity does not match a saved response");
    if (row[0] === null || row[0] === undefined) return ok(undefined);
    const parsed = feedResponsePayloadSchema.safeParse({ type: row[0], version: Number(row[1]), data: JSON.parse(String(row[2])) });
    return parsed.success ? ok(parsed.data) : feedError("INVALID_INPUT", "The saved private response payload is invalid");
  } catch (error) {
    return responseDataFailure("Could not read the private feed response payload", error);
  }
};

export const listFeedResponses: FeedApi["listFeedResponses"] = async (responses, options = {}) => {
  const after = options.afterSequence ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return feedError("INVALID_INPUT", "Response pagination requires a nonnegative sequence and limit between 1 and 1000");
  }
  try {
    const result = await responses.query<unknown>(
      `${RESPONSE_HEADER_SELECT} WHERE r.sequence > ? ORDER BY r.sequence LIMIT ?`, [after, limit], PRIVATE_RESPONSE_OPTIONS);
    if (!result.ok) return responseDataFailure("Could not list feed responses", result.error);
    return ok(result.data.rows.map(responseFromRow));
  } catch (error) {
    return responseDataFailure("Could not list feed responses", error);
  }
};

export const recordFeedHandling: FeedApi["recordFeedHandling"] = async (output, handling) => {
  if (!validIdentity(handling) || !handling.handlingId || !handling.responseId ||
    !["acknowledged", "succeeded", "failed"].includes(handling.phase)) {
    return feedError("INVALID_INPUT", "Handling requires full response and card identities and a known phase");
  }
  const previous = await jsonRows<FeedHandling>(output,
    "SELECT handling_json FROM feed_handling WHERE response_id = ? ORDER BY sequence", [handling.responseId]);
  if (!previous.ok) return previous;
  if (previous.data.some((item) => !sameFeedIdentity(item, handling))) {
    return feedError("INVALID_INPUT", "Handling cannot move a response to another card issuance");
  }
  const encoded = feedJson(handling);
  const duplicate = previous.data.find((item) => item.handlingId === handling.handlingId);
  if (duplicate) {
    return feedJson(duplicate) === encoded ? ok(duplicate) : feedError("INVALID_INPUT", "A handling ID cannot change content");
  }
  const knownOutcome = previous.data.find((item) => item.phase !== "acknowledged");
  if (knownOutcome && handling.phase !== "acknowledged") {
    return feedError("INVALID_INPUT", "An existing outcome requires an explicit follow-up response, not a replacement");
  }
  // The predicate runs inside the write statement, not before its lock is acquired.
  const inserted = await output.execute(
    `INSERT INTO feed_handling (handling_id, response_id, card_id, revision, issuance_id, phase, handling_json)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM feed_handling WHERE response_id = ? AND (card_id <> ? OR revision <> ? OR issuance_id <> ?)
     ) AND (? = 'acknowledged' OR NOT EXISTS (
       SELECT 1 FROM feed_handling WHERE response_id = ? AND phase IN ('succeeded', 'failed')
     )) ON CONFLICT (handling_id) DO NOTHING`,
    [handling.handlingId, handling.responseId, handling.cardId, handling.revision, handling.issuanceId, handling.phase, encoded,
      handling.responseId, handling.cardId, handling.revision, handling.issuanceId, handling.phase, handling.responseId],
  );
  if (!inserted.ok) return inserted;
  const stored = await jsonRows<FeedHandling>(output,
    "SELECT handling_json FROM feed_handling WHERE handling_id = ?", [handling.handlingId]);
  if (!stored.ok) return stored;
  if (!stored.data[0]) return feedError("INVALID_INPUT", "Handling conflicts with an existing outcome or response issuance");
  return feedJson(stored.data[0]) === encoded
    ? ok(stored.data[0]) : feedError("INVALID_INPUT", "A handling ID cannot change content");
};

export const getFeedCardState: FeedApi["getFeedCardState"] = async (output, responses, identity) => {
  const params = [identity.cardId, identity.revision, identity.issuanceId];
  const cards = await jsonRows<FeedCard>(output,
    "SELECT card_json FROM feed_cards WHERE card_id = ? AND revision = ? AND issuance_id = ?", params);
  if (!cards.ok) return cards;
  if (!cards.data[0]) return feedError("NOT_FOUND", "Card issuance not found");
  const saved = await responses.query<unknown>(
    `${RESPONSE_HEADER_SELECT} WHERE r.card_id = ? AND r.revision = ? AND r.issuance_id = ?
     ORDER BY r.sequence DESC LIMIT 1`, params, PRIVATE_RESPONSE_OPTIONS);
  if (!saved.ok) return responseDataFailure("Could not read the card's saved response", saved.error);
  const row = saved.data.rows[0];
  let response: FeedResponse | null;
  try { response = row ? responseFromRow(row) : null; }
  catch (error) { return responseDataFailure("Could not read the card's saved response", error); }
  let acknowledgement: FeedHandling | null = null;
  let outcome: FeedHandling | null = null;
  if (response) {
    const handling = await jsonRows<FeedHandling>(output,
      `SELECT handling_json FROM feed_handling WHERE response_id = ? AND card_id = ? AND revision = ? AND issuance_id = ?
       ORDER BY sequence`, [response.responseId, ...params]);
    if (!handling.ok) return handling;
    for (const item of handling.data) {
      if (item.phase === "acknowledged") acknowledgement = item;
      else outcome = item;
    }
  }
  return ok({ card: cards.data[0], response, acknowledgement, outcome });
};

export const resolveFeedCard: FeedApi["resolveFeedCard"] = async (output, reference) => {
  if (!reference) return feedError("INVALID_INPUT", "A card reference is required");
  const rows = await output.query<unknown>(
    `SELECT card_id, revision, issuance_id FROM feed_cards
     WHERE card_id = ? ORDER BY sequence DESC LIMIT 1`, [reference]);
  if (!rows.ok) return rows;
  let row = rows.data.rows[0];
  if (!row) {
    const matches = await output.query<unknown>(
      `SELECT card_id, revision, issuance_id FROM feed_cards
       WHERE substr(card_id, 1, length(?)) = ? AND sequence IN
       (SELECT MAX(sequence) FROM feed_cards GROUP BY card_id) LIMIT 2`, [reference, reference]);
    if (!matches.ok) return matches;
    if (matches.data.rows.length !== 1) return feedError("NOT_FOUND", "Card reference is absent or ambiguous; use its full ID");
    row = matches.data.rows[0];
  }
  return ok({ cardId: String(row[0]), revision: Number(row[1]), issuanceId: String(row[2]) });
};
