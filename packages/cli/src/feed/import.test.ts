import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { z } from "zod";
import { ServiceContext } from "../../../sdk-services/src/context";
import { SQLService } from "../../../sdk-services/src/sql/SQLService";
import { ErrorCodes } from "../../../sdk-services/src/types";
import {
  deliverFeedResponse, initializeFeedDatabases, initializeFeedHandoff,
  listFeedCardHistory, listFeedResponseDeliveries, listFeedResponses,
  readFeedResponsePayload, restoreFeedRecords,
  feedCardSchema, feedResponsePayloadSchema, feedResourceNames, newFeedResponseSchema,
} from "../../../sdk-services/src/feed";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import { importFeedPreparedBundle } from "./import";
import type { FeedPreparedImportReceipt } from "./import-types";
import type { FeedResponse } from "../../../sdk-services/src/feed";
import { restorePolicySchema } from "../../../sdk-services/src/feed/restore-metadata";
import base from "./fixtures/import/base.json";
import next from "./fixtures/import/next.json";
import conflict from "./fixtures/import/conflict.json";
import expired from "./fixtures/import/runtime-expired.json";
import input from "./fixtures/import/input.json";
import provenance from "./fixtures/import/provenance.json";

// Frozen outputs were generated and validated by the actual Home pure model.
// No foreign repository, model source, or producer is imported by these tests.
const ownerResource = "xyz.tinycloud.tinychat/home_feed";
const targetSpace = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:applications";
const archiveSchema = `CREATE TABLE IF NOT EXISTS feed_owner_imports (
  source_space_id TEXT NOT NULL, namespace TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  bundle_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(source_space_id,namespace,snapshot_id))`;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const fixtureValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fixtureStatement = z.object({ sql: z.string(), params: z.array(fixtureValue).optional() });
const fixtureRequest = z.discriminatedUnion("action", [
  fixtureStatement.extend({ action: z.literal("query") }),
  fixtureStatement.extend({ action: z.literal("execute") }),
  z.object({ action: z.literal("batch"), statements: z.array(fixtureStatement) }),
]);
const parseJSON = (value: string): unknown => JSON.parse(value);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function field(value: unknown, key: string): unknown {
  if (!object(value) || !Object.prototype.hasOwnProperty.call(value, key)) throw new Error("Stored archive field is absent");
  return value[key];
}
function arrayField(value: unknown, key: string): unknown[] {
  const rows = field(value, key);
  if (!Array.isArray(rows)) throw new Error("Stored archive field is not an array");
  return rows;
}

function noPrivate(value: unknown) {
  const rendered = inspect(value, { depth: 30 });
  for (const marker of Object.values(provenance.markers)) expect(rendered).not.toContain(marker);
}
async function failure(promise: Promise<unknown>) {
  const result = await promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  expect(result.ok).toBe(false);
  noPrivate(result);
  if (result.ok) throw new Error("Expected prepared import refusal");
  if (!(result.error instanceof Error)) throw new Error("Expected an Error refusal");
  expect(result.error.cause).toBeUndefined();
  return result.error;
}
function agentEvents(bundle: typeof base, publisherId: string) {
  return bundle.ownerResponses.filter((event) => event.publisherId === publisherId && event.restoreTarget === "agent-response");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tc2209-prepared-import-"));
  const resources = [ownerResource, ...base.publishers.flatMap((publisher) => [publisher.outputResource, publisher.responseResource])];
  const databases = new Map(resources.map((resource: string, index: number) => [resource, sqliteHandle(join(directory, `database-${index}.sqlite`))]));
  cleanup.push(async () => { for (const database of databases.values()) database.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = databases.get(ownerResource)!.handle;
  unwrap(await owner.execute(`CREATE TABLE feed_agents (
    agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, label TEXT NOT NULL,
    output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE, authorization_json TEXT NOT NULL)`));
  for (const publisher of base.publishers) unwrap(await owner.execute("INSERT INTO feed_agents VALUES (?, ?, ?, ?, ?, ?)", [
    publisher.agentId, publisher.agentDid, `Unrelated display label ${publisher.agentId}`,
    publisher.outputResource, publisher.responseResource, JSON.stringify({ cid: `synthetic-grant-${publisher.agentId}` }),
  ]));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      try {
        const handle = databases.get(request.headers.get("X-Fixture-Database") ?? "")?.handle;
        if (!handle) return Response.json({ error: "Unregistered fixture database" }, { status: 403 });
        const body = fixtureRequest.parse(await request.json());
        const value = body.action === "batch" ? unwrap(await handle.batch(body.statements))
          : body.action === "execute" ? unwrap(await handle.execute(body.sql, body.params))
          : unwrap(await handle.query(body.sql, body.params));
        return Response.json(value);
      } catch (error) {
        return Response.json({ error: `${provenance.markers.code}: ${String(error)}`, cause: { bundle: provenance.markers.privateNote }, meta: { receipt: provenance.markers.originalReceipt } }, { status: 400 });
      }
    },
  });
  cleanup.push(() => server.stop(true));
  const context = new ServiceContext({
    invoke: (_session, _service, path) => ({ Authorization: "test-invocation", "X-Fixture-Database": path }),
    hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
    session: {
      delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
      spaceId: targetSpace, verificationMethod: "did:key:synthetic-owner", jwk: {},
    },
  });
  const ordinary: unknown[] = [];
  context.on("service.error", (event) => { ordinary.push(event); });
  const sql = new SQLService(); sql.initialize(context);
  const handle = (resource: string) => databases.get(resource)!.handle;
  const tables = async (resource: string) => unwrap(await handle(resource).query<string>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )).rows.map((row) => row[0]);
  const snapshot = async () => {
    const result = [];
    for (const resource of resources) {
      const schema = unwrap(await handle(resource).query("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")).rows;
      const data = [];
      for (const table of await tables(resource)) data.push([table, unwrap(await handle(resource).query(`SELECT * FROM "${table}" ORDER BY rowid`)).rows]);
      result.push([resource, schema, data]);
    }
    return result;
  };
  let handoffs = 0;
  const drainFresh = async (recipient: string) => {
    const ledger = sqliteHandle(join(directory, `handoff-${++handoffs}.sqlite`));
    try {
      unwrap(await initializeFeedHandoff(ledger.handle));
      const notifications: FeedResponse[] = [];
      for (const publisher of base.publishers) {
        const page = unwrap(await listFeedResponseDeliveries(handle(publisher.responseResource), { recipient }));
        expect(page.hasMore).toBe(false);
        for (const response of page.responses) unwrap(await deliverFeedResponse({
          handoff: ledger.handle, recipient, response,
          deliver: async (safe) => { notifications.push(safe); return "delivered"; },
        }));
      }
      return { notifications, ledger: unwrap(await ledger.handle.query("SELECT response_id, recipient, state, response_json FROM feed_handoffs ORDER BY response_id")).rows };
    } finally { ledger.close(); }
  };
  return { sql, owner, handle, snapshot, tables, drainFresh, ordinary };
}

async function archive(f: Awaited<ReturnType<typeof fixture>>) {
  return unwrap(await f.owner.query<string>("SELECT bundle_json FROM feed_owner_imports ORDER BY source_space_id, namespace, snapshot_id")).rows.map((row) => row[0]);
}
async function expectRemoteContents(f: Awaited<ReturnType<typeof fixture>>, bundle = base) {
  for (const publisher of bundle.publishers) {
    const cards = unwrap(await listFeedCardHistory(f.handle(publisher.outputResource))).cards;
    expect(cards.sort((a, b) => a.cardId.localeCompare(b.cardId))).toEqual(bundle.cards.filter((card) => card.publisherId === publisher.publisherId).map((card) => card.canonicalCard).sort((a, b) => a.cardId.localeCompare(b.cardId)));
    const saved = unwrap(await listFeedResponses(f.handle(publisher.responseResource)));
    const expected = agentEvents(bundle, publisher.publisherId);
    expect(saved.map((event) => event.responseId).sort()).toEqual(expected.map((event) => event.response.responseId).sort());
    for (const event of expected) {
      expect(saved.find((value) => value.responseId === event.response.responseId)).toMatchObject(event.response);
      expect(unwrap(await readFeedResponsePayload(f.handle(publisher.responseResource), event.response))).toEqual(event.payload);
    }
  }
}

test("imports actual Home-produced ten-kind cards for two registered publishers and archives every frozen byte owner-only", async () => {
  const f = await fixture();
  const registry = unwrap(await f.owner.query("SELECT * FROM feed_agents ORDER BY agent_id")).rows;
  const receipt: FeedPreparedImportReceipt = await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  expect(receipt).toEqual({ targetSpace, source: { spaceId: base.source.spaceId, namespace: base.source.namespace, snapshotId: base.source.snapshotId }, archiveResource: ownerResource, publishers: 2, cards: 13, responses: 10 });
  noPrivate(receipt);
  await expectRemoteContents(f);
  expect((await archive(f))).toEqual([JSON.stringify(base)]);
  const stored = parseJSON((await archive(f))[0]);
  expect(stored).toEqual(base);
  for (const row of input.rows) {
    const saved = arrayField(stored, "sourceRows").find((value) => field(value, "sourceKey") === row.sourceKey);
    const raw = field(saved, "rawBase64");
    if (typeof raw !== "string") throw new Error("Stored source bytes are not base64 text");
    expect(raw).toBe(row.rawBase64);
    expect(field(saved, "sha256")).toBe(createHash("sha256").update(Buffer.from(raw, "base64")).digest("hex"));
    expect(Buffer.from(raw, "base64")).toEqual(Buffer.from(row.rawBase64, "base64"));
  }
  expect(unwrap(await f.owner.query("PRAGMA table_info(feed_owner_imports)")).rows.map((row) => row[1])).toEqual(["source_space_id", "namespace", "snapshot_id", "bundle_json", "created_at"]);
  expect(unwrap(await f.owner.query("SELECT * FROM feed_agents ORDER BY agent_id")).rows).toEqual(registry);
});

test("all publisher IDs, DIDs and database pairs must match the real registry before any write", async () => {
  for (const change of [
    "DELETE FROM feed_agents WHERE agent_id = 'beta'",
    "UPDATE feed_agents SET agent_did = 'did:key:wrong-agent' WHERE agent_id = 'beta'",
    "UPDATE feed_agents SET output_resource = 'untrusted/outside-output' WHERE agent_id = 'beta'",
    "UPDATE feed_agents SET response_resource = 'untrusted/outside-responses' WHERE agent_id = 'beta'",
    `UPDATE feed_agents SET agent_id = 'not-alpha', label = 'alpha', authorization_json = '{"agentId":"alpha"}' WHERE agent_id = 'alpha'`,
  ]) {
    const f = await fixture(); unwrap(await f.owner.execute(change));
    const before = await f.snapshot();
    await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base }));
    expect(await f.snapshot()).toEqual(before);
    noPrivate(f.ordinary);
  }
});
test("even matching registry rows cannot authorize unsafe grammar or aliased database basenames", async () => {
  const prefix = "xyz.tinycloud.tinychat/feed";
  const otherToken = unwrap(feedResourceNames(prefix, "different-token"));
  const unsafe: Array<Partial<(typeof base.publishers)[number]>> = [
    { outputResource: "other.namespace/feed_output_alpha", responseResource: "other.namespace/feed_responses_alpha" },
    { outputResource: otherToken.outputResource, responseResource: otherToken.responseResource },
    { outputResource: `${prefix}/home_feed` },
    { responseResource: `${prefix}/threads` },
    { outputResource: "other.namespace/feed_output_beta" },
    { outputResource: "other.namespace/feed_responses_beta" },
    { responseResource: "other.namespace/feed_output_alpha" },
    { agentId: "unsafe/token" },
  ];
  for (const patch of unsafe) {
    const f = await fixture();
    const bundle = structuredClone(base);
    const publisher = { ...bundle.publishers[0], ...patch };
    bundle.publishers[0] = publisher;
    unwrap(await f.owner.execute(
      "UPDATE feed_agents SET agent_id = ?, output_resource = ?, response_resource = ? WHERE agent_id = ?",
      [publisher.agentId, publisher.outputResource, publisher.responseResource, "alpha"],
    ));
    const before = await f.snapshot();
    await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle }));
    expect(await f.snapshot()).toEqual(before);
    noPrivate(f.ordinary);
  }
});


test("invalid structure, versions, byte proofs, full identities and references refuse before any write", async () => {
  const mutations: Array<(value: typeof base) => void> = [
    (b) => { b.formatVersion = 2; }, (b) => { b.modelVersion = 2; },
    (b) => { b.sourceRows[0].rawBase64 = "%%%"; },
    (b) => { b.sourceRows[0].sha256 = "0".repeat(64); },
    (b) => { b.sourceRows[0].sourceKey = "outside-source/card.json"; },
    (b) => { b.sourceRows.push(structuredClone(b.sourceRows[0])); },
    (b) => { b.publishers.push({ ...b.publishers[0], publisherId: "ambiguous-alias" }); },
    (b) => { b.publishers[0].responseResource = "untrusted/outside-feed"; },
    (b) => { b.cards[0].canonicalCard.issuanceId = "unbound-issuance"; },
    (b) => { b.cards[0].identity.revision = 0; },
    (b) => { b.cards[0].sourceKey = `${b.source.namespace}missing.json`; },
    (b) => { b.ownerResponses[0].publisherId = "unknown-publisher"; },
    (b) => { b.ownerResponses[0].response.issuanceId = "unpublished-issuance"; },
    (b) => { b.ownerResponses[0].sourceKey = `${b.source.namespace}missing-answer.json`; },
    (b) => { b.deliveries[0].eventKey = "unrelated-event"; },
    (b) => { b.deliveries[0].identity.revision += 1; },
    (b) => { Reflect.deleteProperty(b.deliveries[0], "dispatchBefore"); },
    (b) => { b.deliveries[0].dispatchBefore = "invalid-deadline"; },
    (b) => { b.recipients.push(structuredClone(b.recipients[0])); },
    (b) => { b.ownerResponses.find((event) => event.restoreTarget === "owner-only")!.restoreTarget = "agent-response"; },
    (b) => { b.ownerResponses[1].recipientKeys = ["logical-unmapped"]; },
  ];
  const f = await fixture(); const before = await f.snapshot();
  for (const mutate of mutations) {
    const value = structuredClone(base); mutate(value);
    await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: value }));
    expect(await f.snapshot()).toEqual(before);
  }
  noPrivate(f.ordinary);
});

test("an explicit full target space is required rather than guessing a primary name", async () => {
  const f = await fixture(); const before = await f.snapshot();
  for (const target of ["", "applications", "not-a-space"]) {
    await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace: target, bundle: base }));
    expect(await f.snapshot()).toEqual(before);
  }
});

test("private owner state, unresolved responses, raw bytes and original receipts never enter agent databases", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  const remote: unknown[] = [];
  for (const publisher of base.publishers) for (const resource of [publisher.outputResource, publisher.responseResource]) {
    for (const table of await f.tables(resource)) remote.push(unwrap(await f.handle(resource).query(`SELECT * FROM "${table}"`)).rows);
  }
  const rendered = inspect(remote, { depth: 30 });
  expect(rendered).not.toContain(provenance.markers.privateNote);
  expect(rendered).not.toContain(provenance.markers.originalReceipt);
  for (const row of base.sourceRows.filter((row) => row.classification === "quarantine")) expect(rendered).not.toContain(row.rawBase64);
  for (const event of base.ownerResponses.filter((event) => event.restoreTarget === "owner-only")) {
    expect(rendered).not.toContain(event.response.responseId);
  }
  const stored = parseJSON((await archive(f))[0]);
  expect(field(stored, "ownerState")).toEqual(base.ownerState);
  expect(field(stored, "threads")).toEqual(base.threads);
  expect(field(stored, "checkpoints")).toEqual(base.checkpoints);
  expect(field(stored, "quarantine")).toEqual(base.quarantine);
  expect(field(stored, "deliveries")).toEqual(base.deliveries);
});

test("fresh local handoffs suppress historical delivery states and send only explicitly mapped pending runtime IDs", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  const expected = base.ownerResponses.filter((event) => event.eventKey.includes("approval-code/") || event.eventKey.includes("20261029T111000000Z-") || event.eventKey === "note:work/work-partial/partialnote224").map((event) => event.response.responseId).sort();
  for (let fresh = 0; fresh < 2; fresh += 1) {
    const delivered = await f.drainFresh("runtime-alpha");
    expect(delivered.notifications.map((event) => event.responseId).sort()).toEqual(expected);
    expect(delivered.ledger.map((row) => [row[0], row[1], row[2]])).toEqual(expected.map((id: string) => [id, "runtime-alpha", "delivered"]));
    noPrivate(delivered);
    expect(JSON.stringify(delivered)).not.toContain("originalReceipt");
  }
  for (const wrongRecipient of ["logical-alpha", "SyntheticOfficer", "Unrelated display label alpha"]) {
    expect(await f.drainFresh(wrongRecipient)).toEqual({ notifications: [], ledger: [] });
  }
});

test("logical aliases targeting one runtime retain contradictory evidence and cannot discard delivered history", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  const publisher = base.publishers.find((publisher) => publisher.publisherId === "legacy-beta")!;
  const event = base.ownerResponses.find((event) => event.eventKey === "note:hold/hold-synthetic/aliasnote224")!;
  const policies = unwrap(await f.handle(publisher.responseResource).query<string>("SELECT policy_json FROM feed_response_delivery_policies WHERE response_id = ? AND recipient = ?", [event.response.responseId, "runtime-alpha"])).rows.map((row) => restorePolicySchema.parse(parseJSON(row[0])));
  expect(policies.map((policy) => [policy.state, policy.dispatch, policy.resolvedOwnerMapping, policy.dispatchBefore]).sort()).toEqual([
    ["pending", "resolved-pending", true, null], ["unconfirmed", "never", true, null],
  ]);
  expect(unwrap(await listFeedResponseDeliveries(f.handle(publisher.responseResource), { recipient: "runtime-alpha" })).responses).toEqual([]);
  const stored = parseJSON((await archive(f))[0]);
  expect(field(stored, "recipients")).toEqual(base.recipients);
  expect(arrayField(stored, "deliveries").filter((delivery) => field(delivery, "responseId") === event.response.responseId)).toEqual(base.deliveries.filter((delivery) => delivery.responseId === event.response.responseId));
  noPrivate(policies);
  expect(JSON.stringify(policies)).not.toContain("originalReceipt");
  expect(JSON.stringify(policies)).not.toContain("provider");
  expect(JSON.stringify(policies)).not.toContain("logical-alpha");
});

test("partial explicit mappings remain remote while unknown intended names stay in the owner archive", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  const event = base.ownerResponses.find((event) => event.eventKey === "note:work/work-partial/partialnote224")!;
  expect(event.unresolvedRecipients).toEqual(["MissingOfficer"]);
  expect(event.restoreTarget).toBe("agent-response");
  const publisher = base.publishers.find((publisher) => publisher.publisherId === event.publisherId)!;
  expect(unwrap(await readFeedResponsePayload(f.handle(publisher.responseResource), event.response))).toEqual(event.payload);
  const page = unwrap(await listFeedResponseDeliveries(f.handle(publisher.responseResource), { recipient: "runtime-alpha" }));
  expect(page.responses.map((response) => response.responseId)).toContain(event.response.responseId);
  expect(arrayField(parseJSON((await archive(f))[0]), "ownerResponses").find((saved) => field(field(saved, "response"), "responseId") === event.response.responseId)).toEqual(event);
});

test("an exact archive retry is immutable and a different valid prepared bundle under the same ID is refused", async () => {
  const f = await fixture(); const first = await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  const before = await archive(f);
  expect(await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base })).toEqual(first);
  await expectRemoteContents(f);
  expect(await archive(f)).toEqual(before);
  await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: conflict }));
  expect(await archive(f)).toEqual(before);
  await expectRemoteContents(f);
});

test("a missing or wrong-scope causal predecessor cannot authorize an archive row", async () => {
  const f = await fixture(); unwrap(await f.owner.execute(archiveSchema));
  unwrap(await f.owner.execute("INSERT INTO feed_owner_imports VALUES (?, ?, ?, ?, ?)", ["different-source-space", base.source.namespace, base.source.snapshotId, JSON.stringify(base), base.frozenAt]));
  await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: next }));
  expect(unwrap(await f.owner.query("SELECT source_space_id, snapshot_id FROM feed_owner_imports")).rows).toEqual([["different-source-space", base.source.snapshotId]]);
  for (const publisher of base.publishers) for (const resource of [publisher.outputResource, publisher.responseResource]) {
    for (const table of await f.tables(resource)) expect(unwrap(await f.handle(resource).query(`SELECT * FROM "${table}"`)).rows).toEqual([]);
  }
});

test("causal deletion metadata remains archived without deleting earlier canonical cards or response history", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: next });
  const saved = (await archive(f)).map(parseJSON);
  expect(saved.map((value) => field(field(value, "source"), "snapshotId"))).toEqual([base.source.snapshotId, next.source.snapshotId]);
  expect(field(field(saved[1], "source"), "previousSnapshotId")).toBe(base.source.snapshotId);
  expect(field(saved[1], "deletions")).toEqual(next.deletions);
  const removed = base.cards.find((card) => card.record.kind === "order")!;
  const publisher = base.publishers.find((publisher) => publisher.publisherId === removed.publisherId)!;
  expect(unwrap(await listFeedCardHistory(f.handle(publisher.outputResource))).cards).toContainEqual(removed.canonicalCard);
  for (const publisher of base.publishers) expect(unwrap(await listFeedResponses(f.handle(publisher.responseResource))).map((response) => response.responseId).sort()).toEqual(agentEvents(base, publisher.publisherId).map((event) => event.response.responseId).sort());
});

test("a prepared pending deadline that is now expired never reaches a fresh local handoff", async () => {
  const f = await fixture(); await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: expired });
  expect(expired.deliveries.find((delivery) => delivery.dispatch === "resolved-pending")).toMatchObject({ dispatchBefore: "2000-01-03T00:00:00.000Z", state: "pending" });
  expect(await f.drainFresh("runtime-alpha")).toEqual({ notifications: [], ledger: [] });
});

test("partial canonical progress survives a private SQL failure and exact archive replay completes the remaining publisher", async () => {
  const f = await fixture();
  for (const publisher of base.publishers) unwrap(await initializeFeedDatabases({ output: f.handle(publisher.outputResource), responses: f.handle(publisher.responseResource) }));
  const alpha = base.publishers[0], beta = base.publishers[1];
  const event = base.ownerResponses.find((event) => event.eventKey.includes("approval-code/"))!;
  const card = base.cards.find((card) => card.identity.cardId === event.response.cardId)!;
  const origin = { sourceSpaceId: base.source.spaceId, namespace: base.source.namespace, snapshotId: base.source.snapshotId, sourceKey: event.sourceKey, eventKey: event.eventKey };
  unwrap(await restoreFeedRecords({ output: f.handle(alpha.outputResource), responses: f.handle(alpha.responseResource) }, {
    cards: [feedCardSchema.parse(card.canonicalCard)], responses: [{ response: newFeedResponseSchema.parse(event.response), payload: feedResponsePayloadSchema.parse(event.payload), origin, deliveries: [{ recipient: "runtime-alpha", state: "pending", dispatch: "resolved-pending", resolvedOwnerMapping: true, dispatchBefore: null, source: origin }] }],
  }));
  const prefix = unwrap(await listFeedResponses(f.handle(alpha.responseResource)));
  unwrap(await f.handle(beta.responseResource).execute(`CREATE TRIGGER fail_import_prefix BEFORE INSERT ON feed_response_origins BEGIN SELECT RAISE(ABORT, '${provenance.markers.code}'); END`));
  await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base }));
  expect(f.ordinary).toContainEqual(expect.objectContaining({ service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }) }));
  noPrivate(f.ordinary);
  expect(unwrap(await listFeedResponses(f.handle(alpha.responseResource)))).toEqual(expect.arrayContaining(prefix));
  expect(unwrap(await listFeedResponses(f.handle(beta.responseResource)))).toEqual([]);
  unwrap(await f.handle(beta.responseResource).execute("DROP TRIGGER fail_import_prefix"));
  await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  expect(await archive(f)).toEqual([JSON.stringify(base)]);
  await expectRemoteContents(f);
});

test("owner archive SQL failures remain failures without leaking bundle data to ordinary listeners or CLI errors", async () => {
  const f = await fixture(); unwrap(await f.owner.execute(archiveSchema));
  unwrap(await f.owner.execute(`CREATE TRIGGER fail_owner_archive BEFORE INSERT ON feed_owner_imports BEGIN SELECT RAISE(ABORT, '${provenance.markers.code}'); END`));
  await failure(importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base }));
  expect(f.ordinary).toContainEqual(expect.objectContaining({ service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }) }));
  noPrivate(f.ordinary);
  expect(await archive(f)).toEqual([]);
  unwrap(await f.owner.execute("DROP TRIGGER fail_owner_archive"));
  await importFeedPreparedBundle({ sql: f.sql, targetSpace, bundle: base });
  expect(await archive(f)).toEqual([JSON.stringify(base)]);
  await expectRemoteContents(f);
});
