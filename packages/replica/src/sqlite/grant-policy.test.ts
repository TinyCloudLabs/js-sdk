import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { isReplicaError, ReplicaErrorCode } from "../errors.js";
import { assertReadable, effectiveAuthority } from "../scope.js";
import { config, deviceGrant, NODE_DID, tempDir } from "../../test/fixtures.js";
import { loadSqlite } from "./driver.js";
import { SqliteReplicaStore } from "./store.js";
import type { GrantPolicyRecord } from "../types.js";

const T0 = Date.UTC(2030, 0, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T_EFFECTIVE = T0 + HOUR;
// Signed exp is well after the effective bound, so the bound alone must refuse.
const GRANT = deviceGrant({ prefix: "notes/", exp: Math.floor(T0 / 1000) + 30 * 86_400 });

const POLICY: GrantPolicyRecord = {
  installedAt: T0,
  effectiveExpiresAt: T_EFFECTIVE,
  consentDeadline: T0 + 7 * DAY,
  consentAnchorAt: T0,
  consentAnchorSource: "first_install",
};

const POLICY_COLUMNS = [
  "grant_installed_at",
  "grant_effective_expires_at",
  "grant_consent_deadline",
  "grant_consent_anchor_at",
  "grant_consent_anchor_source",
  "pending_grant_installed_at",
  "pending_grant_effective_expires_at",
  "pending_grant_consent_deadline",
  "pending_grant_consent_anchor_at",
  "pending_grant_consent_anchor_source",
];

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function grantWith(policy: Partial<typeof POLICY> = {}) {
  return { ...GRANT, policy: { ...POLICY, ...policy } };
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isReplicaError(error) ? error.code : error;
  }
}

async function newStore(): Promise<{ store: SqliteReplicaStore; dir: string }> {
  const dir = await tempDir();
  dirs.push(dir);
  const store = await SqliteReplicaStore.open(dir, { create: true });
  await store.init(config());
  return { store, dir };
}

async function rawDatabase(dir: string) {
  const opener = await loadSqlite();
  return opener(join(dir, "replica.db"));
}

function promotingPage(grant: ReturnType<typeof grantWith>) {
  return {
    changes: [],
    blobs: new Map(),
    cursor: "1",
    source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
    authority: null,
    coverage: "complete" as const,
    at: new Date().toISOString(),
    window: { notBefore: null, expiresAt: null },
    complete: true,
    retentionGrantCid: null,
    promoteGrant: grant,
  };
}

/** Installs and promotes `grant`; returns the sync lease that promoted it (still held). */
async function activate(store: SqliteReplicaStore, grant: ReturnType<typeof grantWith>) {
  await store.installGrant(grant);
  const lease = (await store.acquireSyncLease(60_000))!;
  await store.applyPage(lease, promotingPage(grant));
  return lease;
}

describe("grant policy persistence", () => {
  test("a v1 replica database migrates in place and reopens idempotently", async () => {
    const { store, dir } = await newStore();
    await store.installGrant(GRANT);
    await store.close();

    const db = await rawDatabase(dir);
    for (const column of POLICY_COLUMNS) db.exec(`ALTER TABLE replica DROP COLUMN ${column}`);
    db.exec("PRAGMA user_version = 1");
    db.close();

    const migrated = await SqliteReplicaStore.open(dir, { create: false });
    expect((await migrated.open())!.pendingGrant?.cid).toBe(GRANT.cid);
    const next = { ...deviceGrant({ prefix: "notes/", exp: Math.floor(T0 / 1000) + 31 * 86_400 }), policy: POLICY };
    await migrated.installGrant(next);
    expect((await migrated.open())!.pendingGrant?.policy).toEqual(POLICY);
    await migrated.close();

    const reopened = await SqliteReplicaStore.open(dir, { create: false });
    expect((await reopened.open())!.pendingGrant?.policy).toEqual(POLICY);
    await reopened.close();
  });

  test("policy is stored on the pending slot and copied to the active slot on promotion", async () => {
    const { store } = await newStore();
    await store.installGrant(grantWith());
    expect((await store.open())!.pendingGrant?.policy).toEqual(POLICY);

    const lease = (await store.acquireSyncLease(60_000))!;
    await store.applyPage(lease, promotingPage(grantWith()));

    const state = await store.open();
    expect(state!.grant?.policy).toEqual(POLICY);
    expect(state!.pendingGrant).toBeNull();
    await store.close();
  });

  test("a discarded pending grant leaves no policy columns behind", async () => {
    const { store, dir } = await newStore();
    await store.installGrant(grantWith());
    await store.discardPendingGrant(GRANT.cid, "revoked");
    await store.close();

    const db = await rawDatabase(dir);
    const row = db.get<Record<string, unknown>>(
      "SELECT pending_grant_installed_at, pending_grant_effective_expires_at, pending_grant_consent_deadline, pending_grant_consent_anchor_at, pending_grant_consent_anchor_source FROM replica WHERE id = 1",
    );
    db.close();
    expect(Object.values(row!).every((value) => value === null)).toBe(true);
  });

  test("reinstalling the same CID keeps its first installedAt", async () => {
    const { store } = await newStore();
    await store.installGrant(grantWith({ installedAt: T0 }));
    await store.installGrant(grantWith({ installedAt: T0 + 5_000 }));
    expect((await store.open())!.pendingGrant?.policy?.installedAt).toBe(T0);
    await store.close();
  });

  test("a read is refused at or after effectiveExpiresAt even before the signed exp", async () => {
    const { store } = await newStore();
    await activate(store, grantWith());

    expect((await store.status(T_EFFECTIVE - 1)).authority.state).toBe("valid");

    const expired = await store.status(T_EFFECTIVE);
    expect(expired.authority.state).toBe("expired");
    const authority = effectiveAuthority({ window: null, grant: grantWith(), revoked: null, policy: "whileGrantValid", now: T_EFFECTIVE });
    expect(authority.state).toBe("expired");
    expect(codeOf(() => assertReadable(authority, T_EFFECTIVE))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    await store.close();
  });

  test("a non-finite or partial stored bound fails closed", async () => {
    const infinite = await newStore();
    await activate(infinite.store, grantWith({ effectiveExpiresAt: Number.POSITIVE_INFINITY }));
    expect((await infinite.store.status(T0)).authority.state).toBe("expired");
    await infinite.store.close();

    const partial = await newStore();
    await activate(partial.store, grantWith());
    await partial.store.close();
    const db2 = await rawDatabase(partial.dir);
    db2.exec("UPDATE replica SET grant_consent_deadline = NULL WHERE id = 1");
    db2.close();
    const partialStore = await SqliteReplicaStore.open(partial.dir, { create: false });
    expect((await partialStore.status(T0)).authority.state).toBe("expired");
    await partialStore.close();
  });

  test("a purged replica leaves no grant policy behind", async () => {
    const { store, dir } = await newStore();
    const lease = await activate(store, grantWith());
    await store.destroy(lease);

    const fresh = await SqliteReplicaStore.open(dir, { create: true });
    await fresh.init(config());
    await fresh.installGrant(GRANT);
    const state = await fresh.open();
    expect(state!.grant).toBeNull();
    expect(state!.pendingGrant?.policy ?? null).toBeNull();
    await fresh.close();
  });
});
