import { beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode, type DelegatedAccess } from "@tinycloud/node-sdk";
import type { IKVService, KVChange, KVChangesResponse } from "@tinycloud/sdk-services";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "./setup";

/**
 * Live acceptance for the `tinycloud.kv/sync` change feed (TC-732 / TC-736)
 * against a node that advertises `kv-sync-v1`. A device holding the
 * `get,list,metadata,sync` bundle on `notes/` follows the feed from an empty
 * cursor and sees puts, an overwrite and a delete in commit order, while a
 * write to the sibling `notes-secret/` never appears and never moves the
 * cursor.
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SPACE_NAME = "default";
const ROOT = `kv-changes-test/${RUN_ID}`;
const NOTES = `${ROOT}/notes/`;
const SECRET_SIBLING = `${ROOT}/notes-secret/x`;
const TEST_TIMEOUT = 30000;

async function drain(
  kv: IKVService,
  cursor: string | undefined,
  limit: number,
): Promise<{ changes: KVChange[]; pages: KVChangesResponse[] }> {
  const pages: KVChangesResponse[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const page = await kv.changes({ prefix: NOTES, cursor, limit });
    if (!page.ok) throw new Error(`${page.error.code}: ${page.error.message}`);
    pages.push(page.data);
    cursor = page.data.cursor;
    if (!page.data.more) return { changes: pages.flatMap((p) => p.changes), pages };
  }
  throw new Error("change feed did not catch up in 50 pages");
}

describe("KV change feed (tinycloud.kv/sync)", () => {
  let alice: TinyCloudNode;
  let device: DelegatedAccess;
  let readOnly: DelegatedAccess;
  let deviceDelegationCid: string;
  let nodeDid: string;
  let bootstrapCursor: string;
  let caughtUpCursor: string;
  let overwriteEtag: string;

  beforeAll(async () => {
    await checkServerHealth();
    const info = (await (await fetch(`${SERVER_URL}/info`)).json()) as {
      nodeId: string;
      features: string[];
    };
    if (!info.features.includes("kv-sync-v1")) {
      throw new Error(`${SERVER_URL} does not advertise kv-sync-v1; build tinycloud-node with TC-732`);
    }
    nodeDid = info.nodeId;

    alice = new TinyCloudNode({
      host: SERVER_URL,
      privateKey: TEST_KEY,
      autoBootstrapAccount: false,
      autoCreateSpace: true,
      includeAccountRegistryPermissions: false,
      manifest: {
        app_id: "kv-changes-test",
        name: "KV change feed acceptance",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space: SPACE_NAME,
        permissions: [{
          service: "tinycloud.kv",
          space: SPACE_NAME,
          path: `${ROOT}/`,
          actions: ["get", "put", "list", "del", "metadata", "sync"],
        }, {
          // Lets the session revoke the device grant it issues.
          service: "tinycloud.delegation",
          space: SPACE_NAME,
          path: "",
          actions: ["revoke"],
        }],
      },
    });
    await alice.signIn();
    await alice.hostOwnedSpace(SPACE_NAME);

    const deviceNode = new TinyCloudNode({ host: SERVER_URL, autoBootstrapAccount: false, autoCreateSpace: true });
    const delegated = await alice.delegateTo(deviceNode.did.split("#", 1)[0]!, [{
      service: "tinycloud.kv",
      space: SPACE_NAME,
      path: NOTES,
      actions: ["get", "list", "metadata", "sync"],
    }]);
    expect(delegated.prompted).toBe(false);
    deviceDelegationCid = delegated.delegation.cid;
    device = await deviceNode.useDelegation(delegated.delegation);

    const readerNode = new TinyCloudNode({ host: SERVER_URL, autoBootstrapAccount: false, autoCreateSpace: true });
    const readerGrant = await alice.delegateTo(readerNode.did.split("#", 1)[0]!, [{
      service: "tinycloud.kv",
      space: SPACE_NAME,
      path: NOTES,
      actions: ["get", "list", "metadata"],
    }]);
    readOnly = await readerNode.useDelegation(readerGrant.delegation);
  }, TEST_TIMEOUT);

  test("a device bootstraps from an empty cursor", async () => {
    const page = await device.kv.changes({ prefix: NOTES });
    if (!page.ok) throw new Error(`${page.error.code}: ${page.error.message}`);
    expect(page.data.changes).toEqual([]);
    expect(page.data.more).toBe(false);
    expect(page.data.source).toEqual({ nodeDid, space: alice.spaceId!, prefix: NOTES });
    expect(page.data.authority.expiresAt).not.toBeNull();
    expect(page.data.authority.retainUntil).toBeNull();
    bootstrapCursor = page.data.cursor;
  }, TEST_TIMEOUT);

  test("puts, an overwrite and a delete arrive in commit order across limit-1 pages", async () => {
    const kv = alice.space(SPACE_NAME).kv;
    expect((await kv.put(`${NOTES}a`, "a1")).ok).toBe(true);
    expect((await kv.put(`${NOTES}b`, "b1")).ok).toBe(true);
    const overwrite = await kv.put(`${NOTES}a`, "a2");
    expect(overwrite.ok).toBe(true);
    if (!overwrite.ok) throw new Error("unreachable");
    overwriteEtag = overwrite.data.headers.etag!;
    expect((await kv.delete(`${NOTES}b`)).ok).toBe(true);
    expect((await kv.put(SECRET_SIBLING, "never in the feed")).ok).toBe(true);

    const { changes, pages } = await drain(device.kv, bootstrapCursor, 1);
    // Each key appears once, with its latest state, ordered by that state's commit.
    expect(changes).toEqual([
      { key: `${NOTES}a`, deleted: false, etag: overwriteEtag, metadata: expect.any(Object) },
      { key: `${NOTES}b`, deleted: true },
    ]);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    caughtUpCursor = pages[pages.length - 1]!.cursor;

    // Content is fetched with kv/get and matches the feed's ETag.
    const content = await device.kv.get<string>("a", { raw: true });
    expect(content.ok).toBe(true);
    if (!content.ok) throw new Error("unreachable");
    expect(content.data.data).toBe("a2");
    expect(content.data.headers.etag).toBe(overwriteEtag);
  }, TEST_TIMEOUT);

  test("an empty poll returns the request cursor byte for byte, even after an out-of-scope write", async () => {
    const first = await device.kv.changes({ prefix: NOTES, cursor: caughtUpCursor });
    if (!first.ok) throw new Error(`${first.error.code}: ${first.error.message}`);
    expect(first.data).toMatchObject({ changes: [], more: false, cursor: caughtUpCursor });

    expect((await alice.space(SPACE_NAME).kv.put(SECRET_SIBLING, "still outside")).ok).toBe(true);
    const second = await device.kv.changes({ prefix: NOTES, cursor: caughtUpCursor });
    if (!second.ok) throw new Error(`${second.error.code}: ${second.error.message}`);
    expect(second.data).toMatchObject({ changes: [], more: false, cursor: caughtUpCursor });
  }, TEST_TIMEOUT);

  test("a fresh bootstrap skips keys deleted before it", async () => {
    const { changes } = await drain(device.kv, undefined, 500);
    expect(changes).toEqual([
      { key: `${NOTES}a`, deleted: false, etag: overwriteEtag, metadata: expect.any(Object) },
    ]);
  }, TEST_TIMEOUT);

  test("a prefixed view follows its prefix and returns relative keys", async () => {
    const page = await alice.space(SPACE_NAME).kv.withPrefix(`${ROOT}/notes`).changes({ cursor: bootstrapCursor });
    if (!page.ok) throw new Error(`${page.error.code}: ${page.error.message}`);
    expect(page.data.changes.map((change) => change.key)).toEqual(["a", "b"]);
    expect(page.data.source.prefix).toBe(NOTES);
    // No retention grant was presented, so no retention is attested.
    expect(page.data.authority.retainUntil).toBeNull();
  }, TEST_TIMEOUT);

  test("get,list,metadata without sync is refused", async () => {
    const page = await readOnly.kv.changes({ prefix: NOTES });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("unreachable");
    expect(page.error.code).toBe("AUTH_UNAUTHORIZED");
    expect(page.error.meta?.status).toBe(401);
  }, TEST_TIMEOUT);

  test("a cursor the node did not mint requires a reset", async () => {
    const tampered = `${caughtUpCursor.slice(0, 10)}${caughtUpCursor[10] === "A" ? "B" : "A"}${caughtUpCursor.slice(11)}`;
    const page = await device.kv.changes({ prefix: NOTES, cursor: tampered });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("unreachable");
    expect(page.error.code).toBe("KV_SYNC_RESET_REQUIRED");
    expect(page.error.meta?.reason).toBe("cursor-invalid");
  }, TEST_TIMEOUT);

  test("a revoked device grant is a typed revocation error", async () => {
    const revoked = await alice.revokeDelegation(deviceDelegationCid);
    if (!revoked.ok) throw new Error(`revoke failed: ${JSON.stringify(revoked.error)}`);
    const page = await device.kv.changes({ prefix: NOTES, cursor: caughtUpCursor });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("unreachable");
    expect(page.error.code).toBe("AUTH_DELEGATION_REVOKED");
  }, TEST_TIMEOUT);
});
