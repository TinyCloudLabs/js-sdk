/**
 * Unit tests for `createSqliteReplicaStorage` (TC-858 §6.3, §10.1-10.2,
 * amendment §1): the file pending store and its serialization, the identity
 * partition, grant install and `unconstrained`, the per-replica
 * `syncedThroughEpoch` fence, and purge across the device union. Real
 * `bun:sqlite` stores under a temp dir; transports and device keys are
 * faked through the internal seams — no WASM, no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519";
import type { ReplicaTransport } from "@tinycloud/replica";
import type {
  KVReplicaSpec,
  PendingWriteState,
  ReplicationIdentity,
} from "@tinycloud/sdk-services";

import {
  createSqliteReplicaStorage,
  type SqliteReplicaStorageOptions,
} from "./sqlite";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tc858-replica-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const HOST_A = "http://127.0.0.1:8000";
const HOST_B = "http://localhost:8000";
const SPACE_A = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const SPACE_B = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:other";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const DEVICE_DID = "did:key:zTestReplicaDevice";
const DELEGATE_DID = "did:key:zTestDelegateDevice";

function identity(over: Partial<ReplicationIdentity> = {}): ReplicationIdentity {
  return { host: HOST_A, space: SPACE_A, principal: PRINCIPAL, ...over };
}

/** Serializing test guard — what the CLI's profile lock provides. */
function serialGuard(): <T>(section: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (section) => {
    const run = tail.then(section);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function storageOptions(over: Partial<SqliteReplicaStorageOptions> = {}): SqliteReplicaStorageOptions {
  return {
    dir: dirs[dirs.length - 1]!,
    guard: serialGuard(),
    createDevice: async () => ({ did: DEVICE_DID, jwk: { kty: "OKP" } }),
    transportFor: () => fakeTransport,
    ...over,
  };
}

function spec(over: Partial<KVReplicaSpec> = {}): KVReplicaSpec {
  return {
    identity: identity(),
    space: SPACE_A,
    prefix: "notes",
    allowSecrets: false,
    ...over,
  };
}

/** A sync transport that answers one empty page then stops. */
const fakeTransport: ReplicaTransport = {
  async syncPage({ prefix }) {
    return {
      changes: [],
      more: false,
      cursor: "1",
      source: { nodeDid: "did:key:zTestNode", space: SPACE_A, prefix },
      authority: { notBefore: null, expiresAt: null, retainUntil: null },
    };
  },
  async fetchContent() {
    return new Map();
  },
};

// --- Signed test UCANs (EdDSA did:key issuers, like real device grants) ---

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

function didKeyOf(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed.set([0xed, 0x01]);
  prefixed.set(publicKey, 2);
  return `did:key:z${base58Encode(prefixed)}`;
}

const issuerSecret = ed25519.utils.randomPrivateKey();
const issuerDid = didKeyOf(ed25519.getPublicKey(issuerSecret));

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/**
 * Mint a verifiable compact UCAN: Ed25519 did:key issuer, `aud` the replica
 * device, covering `<space>/kv/notes` (and `<space>/kv/other` when given).
 */
async function mintUcan(input: {
  audience: string;
  space?: string;
  prefixes?: string[];
  exp?: number;
  prf?: string[];
  caveats?: Record<string, unknown>;
}): Promise<string> {
  const space = input.space ?? SPACE_A;
  const prefixes = input.prefixes ?? ["notes"];
  const att: Record<string, Record<string, unknown>> = {};
  for (const prefix of prefixes) {
    att[`${space}/kv/${prefix}`] = {
      "tinycloud.kv/get": input.caveats ?? {},
      "tinycloud.kv/sync": {},
    };
  }
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuerDid,
        aud: input.audience,
        exp: input.exp ?? Math.floor(Date.now() / 1000) + 86_400,
        att,
        prf: input.prf ?? ["bafyParentCid"],
      }),
    ),
  );
  const signature = await ed25519.sign(
    new TextEncoder().encode(`${header}.${payload}`),
    issuerSecret,
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

async function partitionDirs(root: string): Promise<string[]> {
  return readdir(root);
}

// ---------------------------------------------------------------------------
// FilePendingWriteStore (§6.3)
// ---------------------------------------------------------------------------

describe("FilePendingWriteStore (§6.3)", () => {
  test("durable: records written by update are visible to a fresh store instance", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const store = storage.pendingWrites!(identity());
    expect(store.durable).toBe(true);
    const opId = await store.update((state) => {
      state.records.push({
        opId: "op1",
        seq: ++state.seq,
        key: "notes/a",
        op: "put",
        state: "in_flight",
        epoch: null,
        at: new Date().toISOString(),
        settledAt: null,
      });
      state.committedEpoch += 1;
      return "op1";
    });
    expect(opId).toBe("op1");

    const reopened = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity());
    const state = await reopened.read();
    expect(state.v).toBe(2);
    expect(state.committedEpoch).toBe(1);
    expect(state.seq).toBe(1);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ opId: "op1", key: "notes/a", state: "in_flight" });
  });

  test("two contending updates serialize: the second observes the first", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const store = storage.pendingWrites!(identity());
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    // The first update blocks on the gate mid-mutate; the second is issued
    // while it waits. A real guard queues the second's read-modify-write
    // behind the first — an unguarded store would let it read the empty
    // state and both would write seq=1.
    const first = store.update((state) => {
      state.seq += 1;
      started.resolve();
      return gate.promise.then(() => state.seq);
    });
    await started.promise;
    const second = store.update((state) => {
      state.seq += 1;
      return state.seq;
    });
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([1, 2]);
    expect((await store.read()).seq).toBe(2);
  });

  test("a mutate that throws leaves the file untouched", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity());
    await store.update((state) => {
      state.seq += 1;
    });
    await expect(
      store.update((state) => {
        state.seq += 100;
        throw new Error("mutate failed");
      }),
    ).rejects.toThrow("mutate failed");
    expect((await store.read()).seq).toBe(1);
  });

  test("a pending.json naming another identity is STORAGE_ERROR, never silently shared", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity());
    await store.read(); // creates the partition
    const [idDir] = await partitionDirs(dir);
    const other: PendingWriteState = {
      v: 2,
      identity: identity({ host: HOST_B }),
      committedEpoch: 3,
      seq: 4,
      records: [],
    };
    await writeFile(join(dir, idDir!, "pending.json"), JSON.stringify(other));
    await expect(store.read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("corrupt pending.json is STORAGE_ERROR", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity());
    await store.read();
    const [idDir] = await partitionDirs(dir);
    await writeFile(join(dir, idDir!, "pending.json"), "{not json");
    await expect(store.read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("no guard → pendingWrites is still the durable file store, never memory", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage({ dir });
    // Review: a missing guard must NEVER silently give the runtime volatile
    // pending state — the file store is always present and durable.
    const store = storage.pendingWrites?.(identity());
    expect(store?.durable).toBe(true);
    await store!.update((state) => {
      state.committedEpoch = 3;
    });
    const reopened = createSqliteReplicaStorage({ dir }).pendingWrites!(identity());
    expect((await reopened.read()).committedEpoch).toBe(3);
  });

  test("concurrent update() calls on one store all survive — in-process serialization", async () => {
    const dir = await makeDir();
    // No guard: the fix must serialize in process even when no cross-process
    // profile lock is supplied (review: unguarded concurrent writes lost
    // records).
    const store = createSqliteReplicaStorage({ dir }).pendingWrites!(identity());
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await createSqliteReplicaStorage({ dir })
      .pendingWrites!(identity())
      .read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  test("concurrent update() calls across store instances on the same path all survive", async () => {
    const dir = await makeDir();
    const first = createSqliteReplicaStorage({ dir }).pendingWrites!(identity());
    const second = createSqliteReplicaStorage({ dir }).pendingWrites!(identity());
    const N = 50;
    // Interleave the two instances: both must share the file's in-process
    // chain, not race independent read-modify-writes.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? first : second).update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await first.read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  test("concurrent updates across a symlinked root and its real path all survive — canonical lock key", async () => {
    const dir = await makeDir();
    const alias = join(await makeDir(), "alias");
    await symlink(dir, alias, "dir");
    // The regression (Sol P2): lock keyed by resolve() is lexical — a store
    // through the symlink and one through the real path ran independent
    // read-modify-write chains on one file and lost records (80 → 60).
    const real = createSqliteReplicaStorage({ dir }).pendingWrites!(identity());
    const linked = createSqliteReplicaStorage({ dir: alias }).pendingWrites!(identity());
    const N = 80;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? real : linked).update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await real.read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity partition isolation (§6.3 regressions)
// ---------------------------------------------------------------------------

describe("identity partition isolation (§6.3)", () => {
  test("same principal+key, different host or space: independent pending state", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const hostA = storage.pendingWrites!(identity({ host: HOST_A }));
    const hostB = storage.pendingWrites!(identity({ host: HOST_B }));
    const spaceB = storage.pendingWrites!(identity({ space: SPACE_B }));

    await hostA.update((state) => {
      state.committedEpoch = 9;
      state.records.push({
        opId: "a1",
        seq: ++state.seq,
        key: "notes/a",
        op: "put",
        state: "committed",
        epoch: 1,
        at: new Date().toISOString(),
        settledAt: null,
      });
    });
    await hostB.update((state) => {
      state.committedEpoch = 2;
    });
    // B's sync clearing B's committed records never touches A's (amendment §1).
    await hostB.update((state) => {
      state.records.length = 0;
    });

    expect((await hostA.read()).committedEpoch).toBe(9);
    expect((await hostA.read()).records).toHaveLength(1);
    expect((await hostB.read()).committedEpoch).toBe(2);
    expect((await hostB.read()).records).toHaveLength(0);
    expect((await spaceB.read()).committedEpoch).toBe(0);
    expect((await spaceB.read()).records).toHaveLength(0);
  });

  test("canonicalization: HTTPS://host:443 and https://host share one partition", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const loud = storage.pendingWrites!(
      identity({ host: "HTTPS://NODE.EXAMPLE:443/" }),
    );
    const quiet = storage.pendingWrites!(identity({ host: "https://node.example" }));
    await loud.update((state) => {
      state.committedEpoch = 5;
    });
    expect((await quiet.read()).committedEpoch).toBe(5);

    const eip55 = storage.pendingWrites!(
      identity({
        space: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000AB:default",
        principal: "did:pkh:eip155:1:0x00000000000000000000000000000000000000ab",
      }),
    );
    const lower = storage.pendingWrites!(
      identity({
        space: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000ab:default",
        principal: "did:pkh:eip155:1:0x00000000000000000000000000000000000000ab",
      }),
    );
    await eip55.update((state) => {
      state.committedEpoch = 7;
    });
    expect((await lower.read()).committedEpoch).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Replica handles: open, grants, fence, purge
// ---------------------------------------------------------------------------

describe("sqlite replica handle", () => {
  test("open creates the §6.3 partition layout; delegate posture never writes device.jwk", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    expect(handle.deviceDid).toBe(DEVICE_DID);
    const [idDir] = await partitionDirs(dir);
    expect(existsSync(join(dir, idDir!, "identity.json"))).toBe(true);
    expect(existsSync(join(dir, idDir!, "device.jwk"))).toBe(true);
    expect(existsSync(join(dir, idDir!, "replicas"))).toBe(true);
    await handle.close();

    // Delegate posture: spec.device is used verbatim, device.jwk untouched.
    const dir2 = await makeDir();
    const delegate = await createSqliteReplicaStorage({
      ...storageOptions(),
      dir: dir2,
    }).open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    expect(delegate.deviceDid).toBe(DELEGATE_DID);
    const [idDir2] = await partitionDirs(dir2);
    expect(existsSync(join(dir2, idDir2!, "device.jwk"))).toBe(false);
    await delegate.close();
  });

  test("installGrant → pending info with parentCid and unconstrained; caveated grants reject", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    expect(await handle.grant()).toBeNull();

    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const ucan = await mintUcan({ audience: DEVICE_DID, exp, prf: ["bafyParentCid"] });
    const info = await handle.installGrant(ucan);
    expect(info.parentCid).toBe("bafyParentCid");
    expect(info.expiresAt).toBe(exp * 1000);
    expect(info.unconstrained).toBe(true);
    expect(info.state).toBe("pending");
    expect((await handle.grant())!.state).toBe("pending");

    const caveated = await mintUcan({
      audience: DEVICE_DID,
      caveats: { maxValueSize: [1000] },
    });
    await expect(handle.installGrant(caveated)).rejects.toMatchObject({
      code: "GRANT_NOT_COVERING",
    });
    await handle.close();
  });

  test("a grant for a different device audience rejects", async () => {
    const dir = await makeDir();
    const handle = await createSqliteReplicaStorage(storageOptions()).open(spec());
    const foreign = await mintUcan({ audience: "did:key:zSomeoneElse" });
    await expect(handle.installGrant(foreign)).rejects.toMatchObject({
      code: "GRANT_AUDIENCE_MISMATCH",
    });
    await handle.close();
  });

  test("sync persists syncedThroughEpoch on success only; status and reads report it", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));

    const result = await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 7 });
    expect(result).toMatchObject({ status: "synced", syncedThroughEpoch: 7 });
    const status = await handle.status();
    expect(status.syncedThroughEpoch).toBe(7);
    expect(status.grant).toMatchObject({ state: "active", unconstrained: true });
    const read = await handle.get("notes/a");
    expect(read.status).toBe("absent");
    expect(read.meta.syncedThroughEpoch).toBe(7);
    await handle.close();

    // The fence survives reopening the handle (amendment §1: durable).
    const reopened = await storage.open(spec());
    expect((await reopened.status()).syncedThroughEpoch).toBe(7);
    await reopened.close();
  });

  test("a failed sync leaves the prior fence unchanged", async () => {
    const dir = await makeDir();
    let fail = false;
    const transport: ReplicaTransport = {
      async syncPage({ prefix }) {
        if (fail) throw new Error("node unreachable");
        return fakeTransport.syncPage({ prefix, limit: 100 });
      },
      fetchContent: fakeTransport.fetchContent,
    };
    const storage = createSqliteReplicaStorage(storageOptions({ transportFor: () => transport }));
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));
    await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 3 });

    fail = true;
    await expect(
      handle.sync({ signal: new AbortController().signal, syncStartEpoch: 99 }),
    ).rejects.toThrow("node unreachable");
    expect((await handle.status()).syncedThroughEpoch).toBe(3);
    await handle.close();
  });

  test("two replicas of one identity fence independently (amendment §1 regression)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const ucan = await mintUcan({
      audience: DEVICE_DID,
      prefixes: ["notes", "other"],
    });
    const notes = await storage.open(spec({ prefix: "notes" }));
    const other = await storage.open(spec({ prefix: "other" }));
    await notes.installGrant(ucan);
    await other.installGrant(ucan);

    // Replica "notes" syncs at identity epoch 7; "other" stays fenced at 0 —
    // a shared fence would wrongly prove "other" caught up.
    await notes.sync({ signal: new AbortController().signal, syncStartEpoch: 7 });
    expect((await notes.status()).syncedThroughEpoch).toBe(7);
    expect((await other.status()).syncedThroughEpoch).toBe(0);

    // After "other" syncs later at epoch 9, each reports its own fence.
    await other.sync({ signal: new AbortController().signal, syncStartEpoch: 9 });
    expect((await notes.status()).syncedThroughEpoch).toBe(7);
    expect((await other.status()).syncedThroughEpoch).toBe(9);
    await notes.close();
    await other.close();
  });

  test("verbatim space case: EIP-55 then lowercase is CONFIG_MISMATCH (§6.3 row 17)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const mixed = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000A1:default";
    const handle = await storage.open(
      spec({ identity: identity({ space: mixed }), space: mixed }),
    );
    await handle.close();
    const lower = mixed.toLowerCase();
    await expect(
      storage.open(spec({ identity: identity({ space: lower }), space: lower })),
    ).rejects.toMatchObject({ code: "REPLICA_CONFIG_MISMATCH" });
  });

  test("secrets space refuses without allowSecrets (§10.1)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const secretsSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
    await expect(
      storage.open(spec({ space: secretsSpace, identity: identity({ space: secretsSpace }) })),
    ).rejects.toMatchObject({ code: "SECRETS_OPT_IN_REQUIRED" });
    const vault = await storage.open(spec({ prefix: "vault/keys", allowSecrets: false })).catch((e) => e);
    expect(vault).toMatchObject({ code: "SECRETS_OPT_IN_REQUIRED" });
  });

  test("closed handle rejects reads", async () => {
    const dir = await makeDir();
    const handle = await createSqliteReplicaStorage(storageOptions()).open(spec());
    await handle.close();
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
    await expect(handle.status()).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
  });
});

describe("purge across the device union (§10.2)", () => {
  test("erases the stored device and the session-device replica, keeps the partition", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const own = await storage.open(spec());
    const delegated = await storage.open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    await own.close();
    await delegated.close();

    const [idDir] = await partitionDirs(dir);
    const replicasBefore = await readdir(join(dir, idDir!, "replicas"));
    expect(replicasBefore.length).toBe(2);

    await storage.purge({
      identity: identity(),
      space: SPACE_A,
      prefix: "notes",
      sessionDeviceDid: DELEGATE_DID,
    });
    const replicasAfter = await readdir(join(dir, idDir!, "replicas"));
    expect(replicasAfter.length).toBe(0);
    expect(existsSync(join(dir, idDir!, "identity.json"))).toBe(true);
  });

  test("purge of a missing partition resolves; a session device alone is still purged", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    await expect(
      storage.purge({ identity: identity({ host: HOST_B }), space: SPACE_A, prefix: "notes" }),
    ).resolves.toBeUndefined();

    // A partition that never had device.jwk (pure delegate posture) still
    // gets its session-device replica erased.
    const delegated = await storage.open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    await delegated.close();
    const [idDir] = await partitionDirs(dir);
    expect(existsSync(join(dir, idDir!, "device.jwk"))).toBe(false);
    await storage.purge({
      identity: identity(),
      space: SPACE_A,
      prefix: "notes",
      sessionDeviceDid: DELEGATE_DID,
    });
    expect((await readdir(join(dir, idDir!, "replicas"))).length).toBe(0);
  });

  test("purge while another process holds the sync lease rejects BUSY", async () => {
    const { SqliteReplicaStore } = await import("@tinycloud/replica/sqlite");
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [idDir] = await partitionDirs(dir);
    const [replicaDir] = await readdir(join(dir, idDir!, "replicas"));

    // A foreign store handle holds the lease: purge must not remove the dir.
    const foreign = await SqliteReplicaStore.open(join(dir, idDir!, "replicas", replicaDir!), {
      create: false,
    });
    const lease = await foreign.acquireSyncLease(120_000);
    expect(lease).not.toBeNull();
    await expect(
      storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes" }),
    ).rejects.toMatchObject({ code: "REPLICA_BUSY" });
    expect(existsSync(join(dir, idDir!, "replicas", replicaDir!))).toBe(true);
    await foreign.releaseLease(lease!);
    await foreign.close();
  });

  test("a handle opened before purge is fenced: status, get and list reject RESET_REQUIRED", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));
    // The handle stays OPEN across the purge: generation fencing (the
    // browser wipe contract) must invalidate it — never unlink under it.
    await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes" });
    await expect(handle.status()).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    await expect(handle.list({ prefix: "notes/" })).rejects.toMatchObject({
      code: "RESET_REQUIRED",
    });
    await handle.close();
    // A fresh handle on the same dir re-initializes cleanly.
    const reopened = await storage.open(spec());
    expect(await reopened.grant()).toBeNull();
    await reopened.close();
  });

  test("a filesystem error that isn't ENOENT fails purge — pending protection stays", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [idDir] = await partitionDirs(dir);
    const replicasDir = join(dir, idDir!, "replicas");
    // EACCES on stat is not "absent": purge must fail, not remove.
    await chmod(replicasDir, 0o000);
    try {
      await expect(
        storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes" }),
      ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      await chmod(replicasDir, 0o700);
    }
    expect((await readdir(replicasDir)).length).toBe(1);
  });

  test("concurrent first opens of an identical spec both succeed", async () => {
    const dir = await makeDir();
    // Two unguarded storages — two "processes" racing the first init. The
    // existence check inside init's guarded write serializes them; the
    // unguarded pre-check raced and lost 9 times out of 10 (review).
    const a = createSqliteReplicaStorage(storageOptions({ guard: undefined }));
    const b = createSqliteReplicaStorage(storageOptions({ guard: undefined }));
    const [ha, hb] = await Promise.all([a.open(spec()), b.open(spec())]);
    expect(ha.deviceDid).toBe(DEVICE_DID);
    expect(hb.deviceDid).toBe(DEVICE_DID);
    await ha.close();
    await hb.close();
  });
});

describe("atomic-write durability", () => {
  test("every pending-state write fsyncs the parent directory after the rename", async () => {
    const dir = await makeDir();
    const synced: string[] = [];
    const dirSync = async (d: string): Promise<void> => {
      synced.push(d);
    };
    const storage = createSqliteReplicaStorage(storageOptions({ dirSync }));
    const store = storage.pendingWrites!(identity());
    await store.update((state) => {
      state.seq += 1;
    });
    // identity.json (partition) + pending.json each fsynced their parent.
    expect(synced.length).toBeGreaterThanOrEqual(2);
    expect(synced.some((d) => d.endsWith("pending.json") === false)).toBe(true);
    expect((await store.read()).seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §4.4 reuse rule inputs: a restored invocation sees the installed grant's
// parent and expiry without any mint (the controller's decision inputs).
// ---------------------------------------------------------------------------

describe("grant reuse across restored invocations (§4.4 inputs)", () => {
  test("ten reopens report the same installed parentCid/expiresAt after one sync", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const exp = Math.floor(Date.now() / 1000) + 240; // final 5 minutes of the parent
    const ucan = await mintUcan({ audience: DEVICE_DID, exp, prf: ["bafyParentX"] });

    const first = await storage.open(spec());
    await first.installGrant(ucan);
    await first.sync({ signal: new AbortController().signal, syncStartEpoch: 1 });
    await first.close();

    for (let invocation = 0; invocation < 10; invocation++) {
      const restored = await storage.open(spec());
      const grant = await restored.grant();
      // After promotion the grant is active; parent and expiry are stable —
      // §4.4's rule would mint zero times across these invocations.
      expect(grant).toMatchObject({
        state: "active",
        parentCid: "bafyParentX",
        expiresAt: exp * 1000,
        unconstrained: true,
      });
      await restored.close();
    }
  });
});
