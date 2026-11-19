import { z } from "zod";
import { ErrorCodes, ok } from "../types";
import type { Result } from "../types";
import type { QueryOptions } from "../sql/types";
import { feedError, feedJson, responseDataFailure, sameFeedIdentity } from "./store";
import { feedResponseHeaderSchema, feedResponsePayloadSchema } from "./schemas";
import { validDispatchBefore } from "./dispatch";
import type { FeedReadDatabase, FeedResponseIdentity, FeedResponsePayload, NewFeedMessage, NewFeedResponse } from "./types";
import type { FeedRestoreDeliveryPolicy, FeedRestoreOrigin } from "./restore-types";

export const restoreOriginSchema: z.ZodType<FeedRestoreOrigin> = z.object({
  sourceSpaceId: z.string().min(1), namespace: z.string().min(1), snapshotId: z.string().min(1),
  sourceKey: z.string().min(1), eventKey: z.string().min(1).optional(),
}).strict();
export const restorePolicySchema: z.ZodType<FeedRestoreDeliveryPolicy> = z.object({
  recipient: z.string().min(1), state: z.enum(["pending", "held", "delivered", "unconfirmed", "refused", "unknown"]),
  dispatch: z.enum(["never", "resolved-pending", "held"]), resolvedOwnerMapping: z.boolean(),
  dispatchBefore: z.custom<string | null>(validDispatchBefore), source: restoreOriginSchema,
}).strict();

export interface RestoreContent {
  response: NewFeedResponse | NewFeedMessage;
  headerJson: string;
  payload?: FeedResponsePayload;
  payloadJson?: string;
  canonical: string;
}
export function restoreContent(input: unknown, inputPayload?: unknown): RestoreContent {
  const response = feedResponseHeaderSchema.parse(input);
  const headerJson = feedJson(response);
  if (feedJson(input) !== headerJson) throw new Error("Invalid restored response header fields");
  const payload = inputPayload === undefined ? undefined : feedResponsePayloadSchema.parse(inputPayload);
  const payloadJson = payload === undefined ? undefined : feedJson(payload.data);
  const envelope = payload === undefined ? "null"
    : `{"data":${payloadJson},"type":${JSON.stringify(payload.type)},"version":${payload.version}}`;
  return { response, headerJson, payload, payloadJson, canonical: `{"payload":${envelope},"response":${headerJson}}` };
}
export async function contentSha256(content: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
export function sameOriginBinding(a: FeedRestoreOrigin, b: FeedRestoreOrigin): boolean {
  return a.sourceSpaceId === b.sourceSpaceId && a.namespace === b.namespace && a.sourceKey === b.sourceKey && a.eventKey === b.eventKey;
}
export function restoreCancelled(signal?: AbortSignal): Result<never> | undefined {
  return signal?.aborted ? feedError(ErrorCodes.ABORTED, "Feed restore or policy read was aborted") : undefined;
}
export function baselinePolicy(source: FeedRestoreOrigin): FeedRestoreDeliveryPolicy {
  return { recipient: "*", state: "unknown", dispatch: "never", resolvedOwnerMapping: false, dispatchBefore: null, source };
}
export interface RestoreMarker {
  cardId: string;
  revision: number;
  issuanceId: string;
  contentSha256: string;
}
export interface RestoreMetadata {
  marker?: RestoreMarker;
  origins: Map<string, FeedRestoreOrigin>;
  policies: FeedRestoreDeliveryPolicy[];
}

/** One metadata query for the entire already-limited header page, independent of evidence fanout. */
export async function readRestoreMetadata(
  responses: FeedReadDatabase, responseIds: string[], options: QueryOptions,
): Promise<Result<Map<string, RestoreMetadata>>> {
  const cancelled = restoreCancelled(options.signal);
  if (cancelled) return cancelled;
  const metadata = new Map<string, RestoreMetadata>();
  for (const id of responseIds) metadata.set(id, { origins: new Map(), policies: [] });
  const selected = responseIds.length ? `VALUES ${responseIds.map(() => "(?)").join(",")}` : "SELECT CAST(NULL AS TEXT) WHERE 0";
  try {
    const result = await responses.query<unknown>(`WITH selected(response_id) AS (${selected})
      SELECT response_id, 'import', card_id, revision, issuance_id, content_sha256
        FROM feed_response_imports WHERE response_id IN (SELECT response_id FROM selected)
      UNION ALL SELECT response_id, 'origin', source_json, NULL, NULL, NULL
        FROM feed_response_origins WHERE response_id IN (SELECT response_id FROM selected)
      UNION ALL SELECT response_id, 'policy', recipient, policy_json, NULL, NULL
        FROM feed_response_delivery_policies WHERE response_id IN (SELECT response_id FROM selected)`, responseIds, options);
    if (!result.ok) return responseDataFailure("Could not read feed restore policy metadata", result.error);
    const aborted = restoreCancelled(options.signal);
    if (aborted) return aborted;
    for (const row of result.data.rows) {
      const target = metadata.get(String(row[0]));
      if (!target) throw new Error("Policy metadata does not belong to its response page");
      if (row[1] === "import") {
        if (target.marker || typeof row[2] !== "string" || !row[2] || !Number.isSafeInteger(row[3]) || Number(row[3]) < 1 ||
          typeof row[4] !== "string" || !row[4] || typeof row[5] !== "string" || !/^[a-f0-9]{64}$/.test(row[5])) {
          throw new Error("Invalid import marker");
        }
        target.marker = { cardId: row[2], revision: Number(row[3]), issuanceId: row[4], contentSha256: row[5] };
      } else if (row[1] === "origin") {
        const source = restoreOriginSchema.parse(JSON.parse(String(row[2])));
        target.origins.set(feedJson(source), source);
      } else if (row[1] === "policy") {
        const policy = restorePolicySchema.parse(JSON.parse(String(row[3])));
        if (row[2] !== policy.recipient) throw new Error("Policy recipient does not match its stored key");
        target.policies.push(policy);
      } else throw new Error("Unknown restore metadata row");
    }
    return ok(metadata);
  } catch (error) {
    return responseDataFailure("Could not verify feed restore policy metadata", error);
  }
}

/** False means positively verified ordinary live data, never a missing-table fallback. */
export function verifyRestoreMetadata(metadata: RestoreMetadata, response: FeedResponseIdentity, contentHash?: string): boolean {
  if (!metadata.marker) {
    if (metadata.origins.size || metadata.policies.length) throw new Error("Orphan restore metadata");
    return false;
  }
  if (!sameFeedIdentity(metadata.marker, response) || (contentHash !== undefined && metadata.marker.contentSha256 !== contentHash) || !metadata.origins.size) {
    throw new Error("Import identity, content or source reference is unverified");
  }
  let binding: FeedRestoreOrigin | undefined;
  const defaults = new Set<string>();
  for (const source of metadata.origins.values()) {
    if (binding && !sameOriginBinding(binding, source)) throw new Error("Conflicting import source bindings");
    binding = source;
  }
  for (const policy of metadata.policies) {
    const source = feedJson(policy.source);
    if (!metadata.origins.has(source)) throw new Error("Policy references an unregistered import origin");
    if (policy.recipient === "*") {
      if (feedJson(policy) !== feedJson(baselinePolicy(policy.source))) throw new Error("Invalid default import policy");
      defaults.add(source);
    }
  }
  for (const source of metadata.origins.keys()) if (!defaults.has(source)) throw new Error("Missing default import policy");
  return true;
}
