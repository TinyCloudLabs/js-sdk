import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFeedDatabases } from "./index";
import { feedJson } from "./store";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedCard, FeedDatabase, FeedHooks, FeedResponsePayload, NewFeedResponse } from "./types";
import type { FeedRestoreDeliveryPolicy, FeedRestoreOrigin, FeedRestoreResponse } from "./restore-types";

export const privateMarker = "SYNTHETIC-RESTORE-PRIVATE-CODE-52";
export const restoredCard: FeedCard = {
  cardId: "card-restored-full", revision: 3, issuanceId: "issuance-restored-full",
  kind: "information", needsResponse: false, title: "Historical draft", body: "The original draft decision.",
  choices: [{ id: "approve", label: "Approve" }], urgency: 1, createdAt: "2026-10-29T12:00:00Z",
  payload: { app: { public: "generic card payload, no migration domain rules" } },
};
export const restoredHeader: NewFeedResponse = {
  cardId: restoredCard.cardId, revision: restoredCard.revision, issuanceId: restoredCard.issuanceId,
  responseId: "response-restored-full", kind: "answer", choiceId: "approve", createdAt: restoredCard.createdAt,
};
export const restoredPayload: FeedResponsePayload = {
  type: "test.private-restore", version: 1, data: { code: privateMarker },
};
export function origin(responseId = restoredHeader.responseId, snapshotId = "snapshot-frozen-one"): FeedRestoreOrigin {
  return { sourceSpaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
    namespace: "fixture/source/", snapshotId, sourceKey: `fixture/source/${responseId}`, eventKey: `event-${responseId}` };
}
export function pendingPolicy(source = origin(), recipient = "runtime-one", dispatchBefore: string | null = null): FeedRestoreDeliveryPolicy {
  return { recipient, state: "pending", dispatch: "resolved-pending", resolvedOwnerMapping: true, dispatchBefore, source };
}
export function restoredRecord(overrides: Partial<FeedRestoreResponse> = {}): FeedRestoreResponse {
  return { response: restoredHeader, payload: restoredPayload, origin: origin(), ...overrides };
}

/** Explicit canonical owner-fixture DDL, not a production missing-table fallback. */
export async function createHistoricalMetadata(responses: FeedDatabase): Promise<void> {
  unwrap(await responses.batch([
    { sql: `CREATE TABLE IF NOT EXISTS feed_response_imports (
      response_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, revision INTEGER NOT NULL, issuance_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS feed_response_origins (
      response_id TEXT NOT NULL, source_json TEXT NOT NULL, PRIMARY KEY (response_id, source_json)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS feed_response_delivery_policies (
      response_id TEXT NOT NULL, recipient TEXT NOT NULL, policy_json TEXT NOT NULL,
      PRIMARY KEY (response_id, recipient, policy_json)
    )` },
  ]));
}

export async function restoreFixture(historicalMetadata = false) {
  const directory = await mkdtemp(join(tmpdir(), "tc2209-restore-"));
  const outputPath = join(directory, "output.sqlite");
  const responsePath = join(directory, "responses.sqlite");
  const output = sqliteHandle(outputPath);
  const responses = sqliteHandle(responsePath);
  const additional: Array<() => void> = [];
  try {
    unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
    if (historicalMetadata) await createHistoricalMetadata(responses.handle);
  } catch (error) {
    responses.close(); output.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
  return {
    directory, output: output.handle, responses: responses.handle,
    databases: { output: output.handle, responses: responses.handle },
    otherResponses: () => {
      const connection = sqliteHandle(responsePath); additional.push(connection.close); return connection.handle;
    },
    handoff: (name: string) => {
      const connection = sqliteHandle(join(directory, name)); additional.push(connection.close); return connection.handle;
    },
    close: async () => {
      for (const close of additional.reverse()) close();
      responses.close(); output.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Construct stored historical protocol rows to exercise today's listener before the new API exists. */
export async function seedHistoricalResponse(responses: FeedDatabase, record = restoredRecord()): Promise<void> {
  const { response, payload, origin: source } = record;
  const contentHash = createHash("sha256").update(feedJson({ response, payload: payload ?? null })).digest("hex");
  const baseline: FeedRestoreDeliveryPolicy = {
    recipient: "*", state: "unknown", dispatch: "never", resolvedOwnerMapping: false, dispatchBefore: null, source,
  };
  unwrap(await responses.batch([
    { sql: "INSERT INTO feed_response_imports (response_id, card_id, revision, issuance_id, content_sha256) VALUES (?, ?, ?, ?, ?)",
      params: [response.responseId, response.cardId, response.revision, response.issuanceId, contentHash] },
    { sql: "INSERT INTO feed_responses (response_id, card_id, revision, issuance_id, response_json) VALUES (?, ?, ?, ?, ?)",
      params: [response.responseId, response.cardId, response.revision, response.issuanceId, feedJson(response)] },
    ...(payload === undefined ? [] : [{
      sql: "INSERT INTO feed_response_payloads (response_id, payload_type, payload_version, payload_json) VALUES (?, ?, ?, ?)",
      params: [response.responseId, payload.type, payload.version, feedJson(payload.data)],
    }]),
    { sql: "INSERT INTO feed_response_origins (response_id, source_json) VALUES (?, ?)", params: [response.responseId, feedJson(source)] },
    ...[baseline, ...(record.deliveries ?? [])].map((policy) => ({
      sql: "INSERT INTO feed_response_delivery_policies (response_id, recipient, policy_json) VALUES (?, ?, ?)",
      params: [response.responseId, policy.recipient, feedJson(policy)],
    })),
  ]));
}

export async function addPolicyEvidence(responses: FeedDatabase, responseId: string, policy: FeedRestoreDeliveryPolicy): Promise<void> {
  unwrap(await responses.execute("INSERT INTO feed_response_delivery_policies (response_id, recipient, policy_json) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [responseId, policy.recipient, feedJson(policy)]));
}

/** A controllable public ready boundary; the SQL data and local ledgers remain real. */
export function oneReadyStream() {
  const opened = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let announceReady: (() => void) | undefined;
  const hooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      announceReady = options?.onReady;
      const stop = () => finished.resolve();
      options?.signal?.addEventListener("abort", stop, { once: true });
      opened.resolve();
      try { if (!options?.signal?.aborted) await finished.promise; }
      finally { options?.signal?.removeEventListener("abort", stop); }
    },
  };
  return { hooks, opened: opened.promise, ready: () => announceReady?.(), finish: () => finished.resolve() };
}
