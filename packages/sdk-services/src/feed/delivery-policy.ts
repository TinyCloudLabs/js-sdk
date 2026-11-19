import { ok } from "../types";
import type { QueryOptions } from "../sql/types";
import { feedError, feedJson, responseDataFailure, responseFromRow, sameFeedIdentity } from "./store";
import {
  contentSha256, readRestoreMetadata, restoreCancelled, restoreContent, verifyRestoreMetadata,
} from "./restore-metadata";
import type { RestoreMetadata } from "./restore-metadata";
import { feedResponsePayloadSchema } from "./schemas";
import { projectFeedResponseNotification } from "./notification";
import type { FeedApi, FeedResponse, FeedResponsePayload } from "./types";
import type { FeedRestoreDeliveryPolicy } from "./restore-types";

function permittedDeadline(metadata: RestoreMetadata, recipient: string): { allowed: false } | { allowed: true; cutoff: string | null } {
  const evidence = new Map<string, FeedRestoreDeliveryPolicy[]>();
  for (const policy of metadata.policies) {
    if (policy.recipient !== recipient) continue;
    const source = feedJson(policy.source);
    const rows = evidence.get(source);
    if (rows) rows.push(policy); else evidence.set(source, [policy]);
  }
  let cutoff: string | null | undefined;
  for (const source of metadata.origins.keys()) {
    const rows = evidence.get(source);
    // One snapshot's exception never overrides another origin's default deny.
    if (!rows?.length) return { allowed: false };
    for (const policy of rows) {
      if (policy.state !== "pending" || policy.dispatch !== "resolved-pending" || !policy.resolvedOwnerMapping) return { allowed: false };
      if (cutoff === undefined) cutoff = policy.dispatchBefore;
      else if (cutoff !== policy.dispatchBefore) return { allowed: false };
      if (typeof policy.dispatchBefore === "string" && Date.now() >= Date.parse(policy.dispatchBefore)) return { allowed: false };
    }
  }
  return cutoff === undefined ? { allowed: false } : { allowed: true, cutoff };
}

export const listFeedResponseDeliveries: FeedApi["listFeedResponseDeliveries"] = async (responses, options) => {
  try {
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!options.recipient || options.recipient === "*" || !Number.isSafeInteger(after) || after < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return feedError("INVALID_INPUT", "Delivery pages require an exact recipient and valid sequence pagination");
    }
    const privateOptions: QueryOptions = { redactErrors: true, signal: options.signal };
    const cancelled = restoreCancelled(options.signal);
    if (cancelled) return cancelled;
    // Limit headers before evidence fanout. The extra header only reports whether another page exists.
    const result = await responses.query<unknown>(`SELECT r.sequence, r.response_json, p.payload_type, p.payload_version,
      p.payload_json, r.card_id, r.revision, r.issuance_id, r.response_id
      FROM feed_responses r LEFT JOIN feed_response_payloads p ON p.response_id = r.response_id
      WHERE r.sequence > ? ORDER BY r.sequence LIMIT ?`, [after, limit + 1], privateOptions);
    if (!result.ok) return responseDataFailure("Could not read feed response delivery headers", result.error);
    const stopped = restoreCancelled(options.signal);
    if (stopped) return stopped;
    const rows = result.data.rows.slice(0, limit);
    const headers: FeedResponse[] = [];
    const ids: string[] = [];
    const seen = new Set<string>();
    let nextSequence = after;
    for (const row of rows) {
      const response = responseFromRow(row);
      if (!Number.isSafeInteger(response.sequence) || response.sequence <= nextSequence || seen.has(response.responseId) || row[8] !== response.responseId ||
        !sameFeedIdentity(response, { cardId: String(row[5]), revision: Number(row[6]), issuanceId: String(row[7]) })) {
        throw new Error("Response page identity or ordering is unverified");
      }
      seen.add(response.responseId);
      nextSequence = response.sequence;
      headers.push(response); ids.push(response.responseId);
    }
    const metadataResult = await readRestoreMetadata(responses, ids, privateOptions);
    if (!metadataResult.ok) return metadataResult;
    const deliveries: FeedResponse[] = [];
    for (let index = 0; index < headers.length; index += 1) {
      const response = headers[index];
      const metadata = metadataResult.data.get(response.responseId)!;
      if (!verifyRestoreMetadata(metadata, response)) {
        deliveries.push(response); // Positive absence in all present metadata tables is ordinary live data.
        continue;
      }
      const row = rows[index];
      let payload: FeedResponsePayload | undefined;
      if (row[2] !== null && row[2] !== undefined) {
        payload = feedResponsePayloadSchema.parse({ type: row[2], version: row[3], data: JSON.parse(String(row[4])) });
      } else if ((row[3] !== null && row[3] !== undefined) || (row[4] !== null && row[4] !== undefined)) {
        throw new Error("Imported payload presence is unverified");
      }
      const content = restoreContent(JSON.parse(String(row[1])), payload);
      const hash = await contentSha256(content.canonical);
      const aborted = restoreCancelled(options.signal);
      if (aborted) return aborted;
      verifyRestoreMetadata(metadata, response, hash);
      const permission = permittedDeadline(metadata, options.recipient);
      if (permission.allowed) {
        deliveries.push(projectFeedResponseNotification({ ...response, dispatchBefore: permission.cutoff }));
      }
    }
    const aborted = restoreCancelled(options.signal);
    if (aborted) return aborted;
    return ok({ responses: deliveries, nextSequence, hasMore: result.data.rows.length > limit });
  } catch (error) {
    return responseDataFailure("Could not verify feed response delivery policy", error);
  }
};
