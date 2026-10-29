import { z } from "zod";
import { ErrorCodes, ok } from "../types";
import type { Result } from "../types";
import type { QueryOptions, SqlStatement, SqlValue } from "../sql/types";
import { feedCardSchema } from "./schemas";
import { feedError, feedJson, responseDataFailure, sameFeedIdentity, storedResponse, storeFeedCard } from "./store";
import {
  baselinePolicy, contentSha256, readRestoreMetadata, restoreCancelled, restoreContent,
  restoreOriginSchema, restorePolicySchema, sameOriginBinding, verifyRestoreMetadata,
} from "./restore-metadata";
import type { RestoreContent } from "./restore-metadata";
import type { FeedApi, FeedCard, FeedDatabase } from "./types";
import type { FeedRestoreDeliveryPolicy, FeedRestoreOrigin } from "./restore-types";

const envelopeSchema = z.object({
  response: z.unknown(), payload: z.unknown().optional(), origin: restoreOriginSchema,
  deliveries: z.array(restorePolicySchema).optional(),
}).strict();
const recordsSchema = z.object({ cards: z.array(z.unknown()), responses: z.array(envelopeSchema) }).strict();
interface RestoreOriginEvidence { origin: FeedRestoreOrigin; policies: Map<string, FeedRestoreDeliveryPolicy> }
interface RestoreGroup { content: RestoreContent; origins: Map<string, RestoreOriginEvidence> }
interface Guard { sql: string; params: SqlValue[] }

function markerGuard(content: RestoreContent, hash: string): Guard {
  const response = content.response;
  return { sql: `EXISTS (SELECT 1 FROM feed_response_imports WHERE response_id = ? AND card_id = ?
    AND revision = ? AND issuance_id = ? AND content_sha256 = ?)`,
  params: [response.responseId, response.cardId, response.revision, response.issuanceId, hash] };
}
function bindingGuard(responseId: string, source: FeedRestoreOrigin): Guard {
  return { sql: `NOT EXISTS (SELECT 1 FROM feed_response_origins WHERE response_id = ? AND (
    json_extract(source_json, '$.sourceSpaceId') IS NOT ? OR json_extract(source_json, '$.namespace') IS NOT ?
    OR json_extract(source_json, '$.sourceKey') IS NOT ? OR json_extract(source_json, '$.eventKey') IS NOT ?))`,
  params: [responseId, source.sourceSpaceId, source.namespace, source.sourceKey, source.eventKey ?? null] };
}
function headerGuard(content: RestoreContent): Guard {
  const response = content.response;
  return { sql: `EXISTS (SELECT 1 FROM feed_responses r WHERE r.response_id = ? AND r.card_id = ? AND r.revision = ?
    AND r.issuance_id = ? AND r.response_json = ?)`,
  params: [response.responseId, response.cardId, response.revision, response.issuanceId, content.headerJson] };
}
function payloadGuard(content: RestoreContent): Guard {
  const responseId = content.response.responseId;
  return content.payload === undefined
    ? { sql: "NOT EXISTS (SELECT 1 FROM feed_response_payloads WHERE response_id = ?)", params: [responseId] }
    : { sql: `EXISTS (SELECT 1 FROM feed_response_payloads WHERE response_id = ? AND payload_type = ?
        AND payload_version = ? AND payload_json = ?)`,
      params: [responseId, content.payload.type, content.payload.version, content.payloadJson!] };
}
function combined(...guards: Guard[]): Guard {
  return { sql: guards.map((guard) => `(${guard.sql})`).join(" AND "), params: guards.flatMap((guard) => guard.params) };
}
function restoreStatements(group: RestoreGroup, hash: string): SqlStatement[] {
  const { content } = group;
  const response = content.response;
  const first = group.origins.values().next().value as RestoreOriginEvidence;
  const claim = combined(markerGuard(content, hash), bindingGuard(response.responseId, first.origin));
  const header = headerGuard(content);
  const complete = combined(claim, header, payloadGuard(content));
  const committed: Guard[] = [complete];
  const statements: SqlStatement[] = [{
    // Claim precedes the header under the same transaction. A committed live header cannot be reclassified.
    sql: `INSERT INTO feed_response_imports (response_id, card_id, revision, issuance_id, content_sha256)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM feed_responses WHERE response_id = ?)
        AND NOT EXISTS (SELECT 1 FROM feed_response_payloads WHERE response_id = ?)
        AND NOT EXISTS (SELECT 1 FROM feed_response_origins WHERE response_id = ?)
        AND NOT EXISTS (SELECT 1 FROM feed_response_delivery_policies WHERE response_id = ?)
      ON CONFLICT (response_id) DO NOTHING`,
    params: [response.responseId, response.cardId, response.revision, response.issuanceId, hash,
      response.responseId, response.responseId, response.responseId, response.responseId],
  }, {
    sql: `INSERT INTO feed_responses (response_id, card_id, revision, issuance_id, response_json)
      SELECT ?, ?, ?, ?, ? WHERE ${claim.sql} ON CONFLICT (response_id) DO NOTHING`,
    params: [response.responseId, response.cardId, response.revision, response.issuanceId, content.headerJson, ...claim.params],
  }];
  if (content.payload !== undefined) statements.push({
    sql: `INSERT INTO feed_response_payloads (response_id, payload_type, payload_version, payload_json)
      SELECT ?, ?, ?, ? WHERE ${combined(claim, header).sql} ON CONFLICT (response_id) DO NOTHING`,
    params: [response.responseId, content.payload.type, content.payload.version, content.payloadJson!, ...claim.params, ...header.params],
  });
  for (const [sourceJson, evidence] of group.origins) {
    statements.push({ sql: `INSERT INTO feed_response_origins (response_id, source_json)
      SELECT ?, ? WHERE ${complete.sql} ON CONFLICT (response_id, source_json) DO NOTHING`,
    params: [response.responseId, sourceJson, ...complete.params] });
    committed.push({ sql: "EXISTS (SELECT 1 FROM feed_response_origins WHERE response_id = ? AND source_json = ?)",
      params: [response.responseId, sourceJson] });
    for (const policy of [baselinePolicy(evidence.origin), ...evidence.policies.values()]) {
      statements.push({ sql: `INSERT INTO feed_response_delivery_policies (response_id, recipient, policy_json)
        SELECT ?, ?, ? WHERE ${complete.sql} AND EXISTS (
          SELECT 1 FROM feed_response_origins WHERE response_id = ? AND source_json = ?)
        ON CONFLICT (response_id, recipient, policy_json) DO NOTHING`,
      params: [response.responseId, policy.recipient, feedJson(policy), ...complete.params, response.responseId, sourceJson] });
      committed.push({ sql: "EXISTS (SELECT 1 FROM feed_response_delivery_policies WHERE response_id = ? AND recipient = ? AND policy_json = ?)",
        params: [response.responseId, policy.recipient, feedJson(policy)] });
    }
  }
  const proof = combined(...committed);
  // Fail the transaction, rather than committing a header whose conditional metadata writes were skipped.
  statements.push({
    sql: `INSERT INTO feed_response_imports (response_id, card_id, revision, issuance_id, content_sha256)
      SELECT ?, NULL, NULL, NULL, NULL WHERE NOT (${proof.sql})`,
    params: [response.responseId, ...proof.params],
  });
  return statements;
}

async function restoreGroup(output: FeedDatabase, responses: FeedDatabase, group: RestoreGroup, options: QueryOptions): Promise<Result<void>> {
  const { content } = group;
  const response = content.response;
  const card = await output.query<string>("SELECT card_json FROM feed_cards WHERE card_id = ? AND revision = ? AND issuance_id = ?",
    [response.cardId, response.revision, response.issuanceId], options);
  if (!card.ok) return responseDataFailure("Could not verify a restored response card issuance", card.error);
  const cardReadCancelled = restoreCancelled(options.signal);
  if (cardReadCancelled) return cardReadCancelled;
  if (!card.data.rows[0] || !sameFeedIdentity(feedCardSchema.parse(JSON.parse(card.data.rows[0][0])), response)) {
    return feedError("INVALID_INPUT", "Restored response requires a published full card issuance");
  }
  const hash = await contentSha256(content.canonical);
  const cancelled = restoreCancelled(options.signal);
  if (cancelled) return cancelled;
  const previous = await storedResponse(responses, response.responseId, options);
  if (!previous.ok) return previous;
  const previousMetadata = await readRestoreMetadata(responses, [response.responseId], options);
  if (!previousMetadata.ok) return previousMetadata;
  const before = previousMetadata.data.get(response.responseId)!;
  if (previous.data) {
    if (!verifyRestoreMetadata(before, response, hash)) return feedError("INVALID_INPUT", "A live response ID cannot be restored or reclassified");
    if (restoreContent(JSON.parse(previous.data.rawHeaderJson), previous.data.payload).canonical !== content.canonical) {
      return feedError("INVALID_INPUT", "A restored response ID cannot change header or private payload");
    }
    const known = before.origins.values().next().value as FeedRestoreOrigin;
    for (const evidence of group.origins.values()) if (!sameOriginBinding(known, evidence.origin)) {
      return feedError("INVALID_INPUT", "A restored response cannot alias its source binding");
    }
  } else if (before.marker || before.origins.size || before.policies.length) {
    return feedError("INVALID_INPUT", "Orphan restore metadata cannot authorize a new header");
  }
  const aborted = restoreCancelled(options.signal);
  if (aborted) return aborted;
  let failure: unknown;
  let failed = false;
  try {
    const saved = await responses.batch(restoreStatements(group, hash), options);
    if (!saved.ok) { failed = true; failure = saved.error; }
  } catch (error) { failed = true; failure = error; }
  const stopped = restoreCancelled(options.signal);
  // Cancellation prevents verification; retain a completed failure, including its ABORTED code.
  if (stopped) return failed ? responseDataFailure("Could not restore response and atomic import policy", failure) : stopped;
  const stored = await storedResponse(responses, response.responseId, options);
  if (!stored.ok) return failed && options.signal?.aborted && stored.error.code === ErrorCodes.ABORTED
    ? responseDataFailure("Could not restore response and atomic import policy", failure) : stored;
  const metadata = await readRestoreMetadata(responses, [response.responseId], options);
  if (!metadata.ok) return failed && options.signal?.aborted && metadata.error.code === ErrorCodes.ABORTED
    ? responseDataFailure("Could not restore response and atomic import policy", failure) : metadata;
  const actual = metadata.data.get(response.responseId)!;
  if (!stored.data) return responseDataFailure("Could not restore response and atomic import policy", failure);
  if (!verifyRestoreMetadata(actual, response, hash) || restoreContent(JSON.parse(stored.data.rawHeaderJson), stored.data.payload).canonical !== content.canonical) {
    return feedError("INVALID_INPUT", "Restore conflicts with an existing live or different response");
  }
  const policies = new Set(actual.policies.map(feedJson));
  for (const [sourceJson, evidence] of group.origins) {
    if (!actual.origins.has(sourceJson) || !policies.has(feedJson(baselinePolicy(evidence.origin)))) {
      return failed ? responseDataFailure("Could not restore atomic provenance and default policy", failure)
        : feedError("INVALID_INPUT", "Restore source binding conflicts with existing provenance");
    }
    for (const policy of evidence.policies.keys()) if (!policies.has(policy)) {
      return responseDataFailure("Could not retain requested immutable delivery evidence", failure);
    }
  }
  const readbackCancelled = restoreCancelled(options.signal);
  if (readbackCancelled) return failed ? responseDataFailure("Could not restore response and atomic import policy", failure) : readbackCancelled;
  return ok(undefined);
}

export const restoreFeedRecords: FeedApi["restoreFeedRecords"] = async (ownerPair, input, options = {}) => {
  const privateOptions: QueryOptions = { redactErrors: true, signal: options.signal };
  try {
    const cancelled = restoreCancelled(options.signal);
    if (cancelled) return cancelled;
    const parsed = recordsSchema.parse(input);
    const cards: FeedCard[] = parsed.cards.map((card) => {
      const valid = feedCardSchema.parse(card);
      // Validate the envelope, but retain literal keys in its opaque payload.
      if (valid.payload !== undefined) valid.payload = (card as FeedCard).payload;
      if (feedJson(valid) !== feedJson(card)) throw new Error("Invalid restored card fields");
      return valid;
    });
    const groups = new Map<string, RestoreGroup>();
    for (const record of parsed.responses) {
      const content = restoreContent(record.response, record.payload);
      const id = content.response.responseId;
      let group = groups.get(id);
      if (group && group.content.canonical !== content.canonical) throw new Error("Conflicting restored response content");
      if (!group) { group = { content, origins: new Map() }; groups.set(id, group); }
      const first = group.origins.values().next().value as RestoreOriginEvidence | undefined;
      if (first && !sameOriginBinding(first.origin, record.origin)) throw new Error("Conflicting restored response binding");
      const sourceJson = feedJson(record.origin);
      let evidence = group.origins.get(sourceJson);
      if (!evidence) { evidence = { origin: record.origin, policies: new Map() }; group.origins.set(sourceJson, evidence); }
      for (const policy of record.deliveries ?? []) {
        if (policy.recipient === "*" || feedJson(policy.source) !== sourceJson) throw new Error("Policy must belong to its exact origin and recipient");
        evidence.policies.set(feedJson(policy), policy);
      }
    }
    // Cross-database progress is repeatable, not a fictional transaction across output and response files.
    for (const card of cards) {
      const stopped = restoreCancelled(options.signal);
      if (stopped) return stopped;
      const saved = await storeFeedCard(ownerPair.output, card, privateOptions);
      if (!saved.ok) return responseDataFailure("Could not publish a restored card", saved.error);
    }
    for (const group of groups.values()) {
      const stopped = restoreCancelled(options.signal);
      if (stopped) return stopped;
      const saved = await restoreGroup(ownerPair.output, ownerPair.responses, group, privateOptions);
      if (!saved.ok) return saved;
    }
    return restoreCancelled(options.signal) ?? ok(undefined);
  } catch (error) {
    return responseDataFailure("Could not validate or restore generic feed records", error);
  }
};
