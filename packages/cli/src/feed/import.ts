import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseSpaceUri } from "@tinycloud/sdk-core";
import { ErrorCodes } from "@tinycloud/sdk-services";
import type { IDatabaseHandle, QueryOptions, Result, SqlValue } from "@tinycloud/sdk-services";
import {
  feedCardSchema, feedResourceNames, feedResponsePayloadSchema, initializeFeedDatabases,
  newFeedMessageSchema, newFeedResponseSchema, restoreFeedRecords,
} from "@tinycloud/sdk-services/feed";
import type { FeedCard, FeedCardIdentity, FeedDatabase, FeedRestoreRecords, JSONValue, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { CLIError, cliErrorFromService } from "../output/errors.js";
import type { FeedPreparedImportOptions, FeedPreparedImportReceipt } from "./import-types.js";

const OWNER_RESOURCE = "xyz.tinycloud.tinychat/home_feed";
const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";
const ARCHIVE_SCHEMA = `CREATE TABLE IF NOT EXISTS feed_owner_imports (
  source_space_id TEXT NOT NULL, namespace TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  bundle_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(source_space_id,namespace,snapshot_id))`;
const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ cardId: text, revision: z.number().int().positive().safe(), issuanceId: text }).strict();
const legacyRef = z.object({ kind: text, id: text }).strict();
const classification = z.enum(["card", "answer", "owner-state", "claim-decision", "group-preference", "thread", "receipt", "checkpoint", "quarantine"]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function jsonValue(value: unknown, active = new Set<object>()): value is JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  active.add(value);
  const valid = Array.isArray(value) ? value.every((item) => jsonValue(item, active))
    : object(value) && Object.keys(value).every((key) => jsonValue(value[key], active));
  active.delete(value);
  return valid;
}
const opaque = z.custom<JSONValue>(jsonValue);
const opaqueObject = z.custom<Record<string, JSONValue>>((value) => object(value) && jsonValue(value));
function identity(value: unknown): value is FeedCardIdentity { return identitySchema.safeParse(value).success; }
function onlyParsedKeys(value: Record<string, unknown>, parsed: object): boolean {
  return Object.keys(value).every((key) => Object.prototype.hasOwnProperty.call(parsed, key));
}
const cardSchema = z.custom<FeedCard>((value) => {
  const parsed = feedCardSchema.safeParse(value);
  if (!parsed.success || !object(value) || !identity({ cardId: parsed.data.cardId, revision: parsed.data.revision, issuanceId: parsed.data.issuanceId }) || !onlyParsedKeys(value, parsed.data)) return false;
  return value.choices === undefined || (Array.isArray(value.choices) && value.choices.every((choice) => object(choice) && Object.keys(choice).every((key) => key === "id" || key === "label")));
});
const headerParser = z.union([newFeedMessageSchema, newFeedResponseSchema]);
const headerSchema = z.custom<NewFeedMessage | NewFeedResponse>((value) => {
  const parsed = headerParser.safeParse(value);
  return parsed.success && object(value) && onlyParsedKeys(value, parsed.data) &&
    identity({ cardId: parsed.data.cardId, revision: parsed.data.revision, issuanceId: parsed.data.issuanceId });
});
const typedPayload = z.object({
  sitrep: z.object({ version: z.literal(1), record: opaqueObject }).strict(),
  source: z.object({ label: z.string(), ref: text }).strict(),
  report: z.object({ label: z.string(), url: text }).strict().optional(), project: z.string().optional(),
}).strict();
const publisherSchema = z.object({ publisherId: text, agentId: text, agentDid: text, outputResource: text, responseResource: text }).strict();
const bundleSchema = z.object({
  formatVersion: z.literal(1), modelVersion: z.literal(1), frozenAt: timestamp,
  source: z.object({ spaceId: text, namespace: text.endsWith("/"), snapshotId: text, completePrefixSnapshot: z.boolean(), previousSnapshotId: text.optional(), cursor: opaque.optional(), revision: opaque.optional() }).strict(),
  origins: z.array(z.object({ path: text, sha256: digest }).strict()),
  sourceRows: z.array(z.object({ sourceKey: text, sourceArea: z.enum(["kv", "watch-state", "thread-watch-state", "expiry-state"]), encoding: z.literal("base64"), rawBase64: z.string(), sha256: digest, classification }).strict()),
  publishers: z.array(publisherSchema),
  recipients: z.array(z.object({ recipientKey: text, legacyName: text, runtimeTarget: z.object({ agentId: text.refine((id) => id !== "*"), provider: text.optional() }).strict().optional() }).strict()),
  routes: z.array(z.object({ sourceKey: text, card: legacyRef, recipientKeys: z.array(text), fallbackRecipientKeys: z.array(text), unresolvedRecipients: z.array(text) }).strict()),
  cards: z.array(z.object({ sourceKey: text, publisherId: text, identity: identitySchema, record: opaqueObject, canonicalCard: cardSchema, needsAction: z.boolean(), currentAnswerSourceKey: text.optional(), foldedInto: legacyRef.optional(), attention: z.enum(["needs-action", "information", "handled", "expired", "snoozed", "closed", "not-needed", "waiting-on-owner"]) }).strict()),
  ownerResponses: z.array(z.object({ sourceKey: text, eventKey: text, publisherId: text, card: legacyRef, response: headerSchema, payload: feedResponsePayloadSchema.optional(), ownerEventKind: z.enum(["answer", "state", "claim", "thread", "note", "hold-notice"]), legacyAnswer: opaqueObject.optional(), restoreTarget: z.enum(["agent-response", "owner-only"]), recipientKeys: z.array(text), unresolvedRecipients: z.array(text) }).strict()),
  ownerState: z.array(z.discriminatedUnion("type", [
    z.object({ sourceKey: text, type: z.literal("state"), value: opaqueObject }).strict(),
    z.object({ sourceKey: text, type: z.literal("claim-decision"), card: legacyRef, value: opaqueObject }).strict(),
    z.object({ sourceKey: text, type: z.literal("group-preference"), value: opaqueObject }).strict(),
  ])),
  threads: z.array(z.object({ sourceKey: text, publisherId: text, identity: identitySchema, message: opaqueObject }).strict()),
  deliveries: z.array(z.object({ sourceKey: text, eventSourceKey: text, eventKey: text, publisherId: text, identity: identitySchema, responseId: text, recipientKey: text, recipient: text, state: z.enum(["pending", "held", "delivered", "unconfirmed", "refused"]), routedTo: z.enum(["owner", "xo"]), at: z.string().optional(), reason: z.string().optional(), evidence: z.enum(["explicit", "sent-without-confirmation", "historical-cursor"]), dispatch: z.enum(["never", "resolved-pending", "held"]), dispatchBefore: timestamp.nullable(), originalReceipt: opaque }).strict()),
  checkpoints: z.array(z.object({ sourceKey: text, type: z.enum(["answer-cursor", "claim-cursor", "task-steps", "task-closed", "thread-cursor", "expiry-grace", "expiry-notice", "chat-receipt", "hold-actions"]), value: opaque }).strict()),
  deletions: z.array(z.object({ sourceKey: text, classification, previousSha256: digest.optional(), deletedAt: z.string().optional() }).strict()),
  quarantine: z.array(z.object({ sourceKey: text, reason: z.enum(["unknown", "invalid", "ambiguous-reference", "orphan-reference", "unmapped-publisher", "unresolved-issuance", "unsupported-receipt"]), detail: z.string() }).strict()),
}).strict();
type Bundle = z.infer<typeof bundleSchema>;
type Card = Bundle["cards"][number];
function refuse(): never { throw new CLIError(ErrorCodes.INVALID_INPUT, "Prepared feed bundle is structurally inconsistent"); }
function sameIdentity(a: FeedCardIdentity, b: FeedCardIdentity): boolean { return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId; }
function sameJSON(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
function cardKey(publisher: string, value: FeedCardIdentity): string { return JSON.stringify([publisher, value.cardId, value.revision, value.issuanceId]); }
function unique<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) { const id = key(value); if (map.has(id)) refuse(); map.set(id, value); }
  return map;
}

function validateBundle(input: unknown): Bundle {
  try {
    const bundle = bundleSchema.parse(input);
    if (bundle.source.previousSnapshotId === bundle.source.snapshotId) refuse();
    unique(bundle.origins, (origin) => origin.path);
    for (const origin of bundle.origins) if (origin.path.startsWith("/") || origin.path.split("/").includes("..")) refuse();
    const rows = unique(bundle.sourceRows, (row) => row.sourceKey);
    const decoded = new Map<string, JSONValue>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const row of rows.values()) {
      if (row.sourceArea === "kv" && !row.sourceKey.startsWith(bundle.source.namespace)) refuse();
      const bytes = Buffer.from(row.rawBase64, "base64");
      if (bytes.toString("base64") !== row.rawBase64 || createHash("sha256").update(bytes).digest("hex") !== row.sha256) refuse();
      if (row.classification !== "quarantine") {
        const value: unknown = JSON.parse(decoder.decode(bytes));
        if (!jsonValue(value)) refuse();
        decoded.set(row.sourceKey, value);
      }
    }
    const publishers = unique(bundle.publishers, (publisher) => publisher.publisherId);
    unique(bundle.publishers, (publisher) => publisher.agentId);
    const recipients = unique(bundle.recipients, (recipient) => recipient.recipientKey);
    const cards = unique(bundle.cards, (card) => card.sourceKey);
    unique(bundle.cards, (card) => cardKey(card.publisherId, card.identity));
    const keys = (values: readonly string[]) => { unique(values, (value) => value); for (const key of values) if (!recipients.has(key)) refuse(); };
    for (const card of cards.values()) {
      const raw = decoded.get(card.sourceKey);
      if (!rows.has(card.sourceKey) || !publishers.has(card.publisherId) || !object(raw) ||
        typeof card.record.kind !== "string" || typeof card.record.id !== "string" || raw.kind !== card.record.kind || raw.id !== card.record.id ||
        card.sourceKey !== `${bundle.source.namespace}board/${card.record.kind}/${card.record.id}.json` || !sameIdentity(card.identity, card.canonicalCard) ||
        card.canonicalCard.kind !== card.record.kind) refuse();
      const payload = typedPayload.parse(card.canonicalCard.payload);
      if (payload.source.ref !== card.sourceKey || !sameJSON(payload.sitrep.record, card.record) ||
        (card.currentAnswerSourceKey !== undefined && !rows.has(card.currentAnswerSourceKey))) refuse();
    }
    unique(bundle.routes, (route) => route.sourceKey);
    for (const route of bundle.routes) {
      const card = cards.get(route.sourceKey);
      if (!card || card.record.kind !== route.card.kind || card.record.id !== route.card.id) refuse();
      keys(route.recipientKeys); keys(route.fallbackRecipientKeys);
    }
    const responses = unique(bundle.ownerResponses, (event) => event.response.responseId);
    unique(bundle.ownerResponses, (event) => event.eventKey);
    for (const event of responses.values()) {
      if (!rows.has(event.sourceKey) || !publishers.has(event.publisherId)) refuse();
      keys(event.recipientKeys);
      if (event.restoreTarget === "agent-response" && !event.recipientKeys.some((key) => recipients.get(key)?.runtimeTarget)) refuse();
    }
    for (const delivery of bundle.deliveries) {
      const event = responses.get(delivery.responseId);
      const recipient = recipients.get(delivery.recipientKey);
      if (!rows.has(delivery.sourceKey) || !rows.has(delivery.eventSourceKey) || !event || !recipient ||
        delivery.publisherId !== event.publisherId || delivery.eventSourceKey !== event.sourceKey || delivery.eventKey !== event.eventKey || !sameIdentity(delivery.identity, event.response) ||
        !event.recipientKeys.includes(delivery.recipientKey)) refuse();
      if (delivery.dispatch === "resolved-pending" && (!recipient.runtimeTarget || delivery.state !== "pending" || event.restoreTarget !== "agent-response")) refuse();
      if (["delivered", "unconfirmed", "refused"].includes(delivery.state) && delivery.dispatch !== "never") refuse();
    }
    for (const value of [...bundle.ownerState, ...bundle.checkpoints, ...bundle.quarantine]) if (!rows.has(value.sourceKey)) refuse();
    for (const thread of bundle.threads) if (!rows.has(thread.sourceKey) || !publishers.has(thread.publisherId)) refuse();
    unique(bundle.deletions, (deletion) => deletion.sourceKey);
    // Tombstones may refer to absent bytes or explicit sidecars. They remain archive data, never SQL deletes.
    return bundle;
  } catch { refuse(); }
}

function safeError(error: unknown): CLIError {
  const candidate = object(error) ? error.code : undefined;
  const code = typeof candidate === "string" && Object.prototype.hasOwnProperty.call(ErrorCodes, candidate) ? candidate : ErrorCodes.SQL_ERROR;
  const meta = object(error) && object(error.meta) ? error.meta
    : object(error) && object(error.metadata) ? error.metadata : undefined;
  const status = meta?.status;
  return cliErrorFromService({ code, message: "Could not import the prepared feed bundle", ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { meta: { status } } : {}) });
}
function value<T>(result: Result<T>): T { if (!result.ok) throw safeError(result.error); return result.data; }
function privateDatabase(database: IDatabaseHandle): FeedDatabase {
  return {
    query<T = Record<string, unknown>>(sql: string, params?: SqlValue[], options?: QueryOptions) {
      return database.query<T>(sql, params, { ...options, redactErrors: true });
    },
    execute: (sql, params, options) => database.execute(sql, params, { ...options, redactErrors: true }),
    batch: (statements, options) => database.batch(statements, { ...options, redactErrors: true }),
  };
}
const registryRow = z.tuple([text, text, text, text, text, text]);
async function verifyRegistry(owner: FeedDatabase, publishers: Bundle["publishers"]): Promise<void> {
  const result = value(await owner.query<unknown>("SELECT agent_id, agent_did, label, output_resource, response_resource, authorization_json FROM feed_agents"));
  const registered = new Map<string, z.infer<typeof registryRow>>();
  const basenames = new Set(["home_feed", "threads"]);
  for (const raw of result.rows) {
    const row = registryRow.parse(raw);
    if (registered.has(row[0])) refuse();
    const expected = value(feedResourceNames(FEED_PREFIX, row[0]));
    if (row[3] !== expected.outputResource || row[4] !== expected.responseResource) refuse();
    for (const resource of [row[3], row[4]]) {
      const basename = resource.split("/").at(-1)!;
      if (basenames.has(basename)) refuse();
      basenames.add(basename);
    }
    registered.set(row[0], row);
  }
  for (const publisher of publishers) {
    const row = registered.get(publisher.agentId);
    if (!row || row[1] !== publisher.agentDid || row[3] !== publisher.outputResource || row[4] !== publisher.responseResource) refuse();
  }
}
async function archiveRow(owner: FeedDatabase, bundle: Bundle, snapshotId: string): Promise<string | undefined> {
  const rows = value(await owner.query<unknown>("SELECT bundle_json FROM feed_owner_imports WHERE source_space_id = ? AND namespace = ? AND snapshot_id = ?", [bundle.source.spaceId, bundle.source.namespace, snapshotId])).rows;
  if (rows.length > 1 || (rows.length && typeof rows[0][0] !== "string")) refuse();
  return rows.length ? String(rows[0][0]) : undefined;
}
async function priorCards(owner: FeedDatabase, bundle: Bundle, bytes: string): Promise<Map<string, Card>> {
  const known = new Map<string, Card>();
  const exists = value(await owner.query<unknown>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", ["feed_owner_imports"])).rows.length > 0;
  if (!exists) { if (bundle.source.previousSnapshotId) refuse(); return known; }
  const current = await archiveRow(owner, bundle, bundle.source.snapshotId);
  if (current !== undefined && current !== bytes) refuse();
  const publishers = new Map(bundle.publishers.map((publisher) => [publisher.publisherId, publisher]));
  const visited = new Set([bundle.source.snapshotId]);
  let predecessor = bundle.source.previousSnapshotId;
  while (predecessor) {
    if (visited.has(predecessor)) refuse();
    visited.add(predecessor);
    const prior = await archiveRow(owner, bundle, predecessor);
    if (prior === undefined) refuse();
    const parsed: unknown = JSON.parse(prior);
    const history = validateBundle(parsed);
    if (history.source.spaceId !== bundle.source.spaceId || history.source.namespace !== bundle.source.namespace || history.source.snapshotId !== predecessor) refuse();
    for (const card of history.cards) {
      const publisher = history.publishers.find((item) => item.publisherId === card.publisherId);
      const currentPublisher = publishers.get(card.publisherId);
      if (!publisher || !currentPublisher || !sameJSON(publisher, currentPublisher)) continue;
      const key = cardKey(card.publisherId, card.identity);
      const previous = known.get(key);
      if (previous && !sameJSON(previous.canonicalCard, card.canonicalCard)) refuse();
      known.set(key, card);
    }
    predecessor = history.source.previousSnapshotId;
  }
  return known;
}
function prepareRecords(bundle: Bundle, known: Map<string, Card>): Map<string, FeedRestoreRecords> {
  const records = new Map<string, FeedRestoreRecords>();
  const included = new Set<string>();
  for (const publisher of bundle.publishers) records.set(publisher.publisherId, { cards: [], responses: [] });
  for (const card of bundle.cards) {
    const key = cardKey(card.publisherId, card.identity);
    const previous = known.get(key);
    if (previous && !sameJSON(previous.canonicalCard, card.canonicalCard)) refuse();
    known.set(key, card);
    included.add(key);
    records.get(card.publisherId)!.cards.push(card.canonicalCard);
  }
  const recipients = new Map(bundle.recipients.map((recipient) => [recipient.recipientKey, recipient]));
  const evidence = new Map<string, Bundle["deliveries"]>();
  for (const row of bundle.deliveries) {
    const rows = evidence.get(row.responseId);
    if (rows) rows.push(row);
    else evidence.set(row.responseId, [row]);
  }
  for (const event of bundle.ownerResponses) {
    const key = cardKey(event.publisherId, event.response);
    const parent = known.get(key);
    if (event.restoreTarget === "owner-only") continue;
    if (!parent || parent.record.kind !== event.card.kind || parent.record.id !== event.card.id) refuse();
    const group = records.get(event.publisherId)!;
    if (!included.has(key)) {
      group.cards.push(parent.canonicalCard);
      included.add(key);
    }
    const origin = { sourceSpaceId: bundle.source.spaceId, namespace: bundle.source.namespace, snapshotId: bundle.source.snapshotId, sourceKey: event.sourceKey, eventKey: event.eventKey };
    const deliveries = [];
    for (const delivery of evidence.get(event.response.responseId) ?? []) {
      const target = recipients.get(delivery.recipientKey)?.runtimeTarget;
      // Unmapped evidence stays in the owner archive; the origin's default deny remains.
      if (!target) continue;
      deliveries.push({ recipient: target.agentId, state: delivery.state, dispatch: delivery.dispatch, resolvedOwnerMapping: true, dispatchBefore: delivery.dispatchBefore, source: origin });
    }
    // Keep every mapped row, including different logical keys for one runtime.
    group.responses.push({ response: event.response, payload: event.payload, origin, deliveries });
  }
  return records;
}
async function saveArchive(owner: FeedDatabase, bundle: Bundle, bytes: string): Promise<void> {
  value(await owner.execute(ARCHIVE_SCHEMA));
  const existing = await archiveRow(owner, bundle, bundle.source.snapshotId);
  if (existing !== undefined && existing !== bytes) refuse();
  if (existing === undefined) {
    if (bundle.source.previousSnapshotId && await archiveRow(owner, bundle, bundle.source.previousSnapshotId) === undefined) refuse();
    try {
      value(await owner.execute("INSERT INTO feed_owner_imports (source_space_id, namespace, snapshot_id, bundle_json, created_at) VALUES (?, ?, ?, ?, ?)", [bundle.source.spaceId, bundle.source.namespace, bundle.source.snapshotId, bytes, new Date().toISOString()]));
    } catch (error) {
      if (await archiveRow(owner, bundle, bundle.source.snapshotId) !== bytes) throw error;
    }
  }
  if (await archiveRow(owner, bundle, bundle.source.snapshotId) !== bytes) refuse();
}

export async function importFeedPreparedBundle(options: FeedPreparedImportOptions): Promise<FeedPreparedImportReceipt> {
  try {
    if (typeof options.targetSpace !== "string" || !options.targetSpace.startsWith("tinycloud:") || !parseSpaceUri(options.targetSpace)?.owner) refuse();
    const bundle = validateBundle(options.bundle);
    const bytes = JSON.stringify(options.bundle);
    const owner = privateDatabase(options.sql.db(OWNER_RESOURCE));
    await verifyRegistry(owner, bundle.publishers);
    const known = await priorCards(owner, bundle, bytes);
    const records = prepareRecords(bundle, known);
    // All structural, reference and actual-registry checks precede the first write.
    await saveArchive(owner, bundle, bytes);
    for (const publisher of bundle.publishers) {
      const pair = { output: privateDatabase(options.sql.db(publisher.outputResource)), responses: privateDatabase(options.sql.db(publisher.responseResource)) };
      value(await initializeFeedDatabases(pair));
      value(await restoreFeedRecords(pair, records.get(publisher.publisherId)!));
    }
    return { targetSpace: options.targetSpace, source: { spaceId: bundle.source.spaceId, namespace: bundle.source.namespace, snapshotId: bundle.source.snapshotId }, archiveResource: OWNER_RESOURCE, publishers: bundle.publishers.length, cards: bundle.cards.length, responses: bundle.ownerResponses.filter((event) => event.restoreTarget === "agent-response").length };
  } catch (error) { throw safeError(error); }
}
