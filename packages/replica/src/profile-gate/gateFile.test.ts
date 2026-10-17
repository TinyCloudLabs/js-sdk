import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import type { ReplicaPurgeIntent } from "@tinycloud/sdk-services/kv/replication";
import {
  denyGate,
  assertGateAccess,
  clearGateIntent,
  establishSessionStamp,
  principalHashOf,
  identityHashOf,
  readFirstInstall,
  readGateState,
  recordFirstInstall,
  restoreSessionStamp,
  readGateSnapshot,
} from "./gateFile";
import { deferredGateToken, resumeDeferredGate } from "./gateFile";
import type { ReplicaGateAccess } from "@tinycloud/sdk-services/kv/replication";

const ALICE = "did:key:z6MkAlice";
const BOB = "did:key:z6MkBob";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp("/var/tmp/tc858-gate-");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function intent(partitionId: string, principalHash: string): ReplicaPurgeIntent {
  return { id: partitionId, kind: "partition", partitionId, principalHash, recordedAt: 1 };
}

async function expectGated(promise: Promise<unknown>, gate: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeDefined();
  expect(error).toMatchObject({ code: "REPLICA_GATED", gate });
}

async function readGateFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(join(dir, REPLICA_GATE_FILE)).text()) as Record<string, unknown>;
}

test("readonly gate snapshot never creates a missing gate", async () => {
  expect(await readGateSnapshot(dir)).toBeUndefined();
  expect(await readdir(dir)).toEqual([]);
});

test("guarded access rejects a stale stamp and pending intent before data access", async () => {
  const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
  const state = await readGateSnapshot(dir);
  const principalHash = await principalHashOf(state!.salt, ALICE);
  const identityKeyHash = await identityHashOf(state!.salt, "identity");
  const access: ReplicaGateAccess = { stamp, incarnation: stamp.incarnation, principalHash, identityKeyHash };
  expect(await assertGateAccess(dir, access, state!.salt)).toEqual(state);
  const pending: ReplicaPurgeIntent = {
    id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash, recordedAt: 1,
  };
  await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => [pending]);
  await expectGated(assertGateAccess(dir, access, state!.salt), "stamp_stale");
  expect((await readGateSnapshot(dir))!.pendingGenerations[identityKeyHash]).toBe(1);
});

test("deferred denial persists all intents, fences reads and validates resumed erasure after restart", async () => {
  const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
  const before = (await readGateSnapshot(dir))!;
  const hash = await identityHashOf(before.salt, "identity");
  const denied = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (principalHash) => [
    { id: `pending:${hash}`, kind: "pending", identityKeyHash: hash, principalHash, recordedAt: 1 },
    intent("partition", principalHash),
  ], undefined, { deferErase: true });
  expect(denied.status).toBe("denied");
  const token = await deferredGateToken(dir);
  expect(token).toEqual({ deniedEpoch: stamp.lifecycleEpoch + 1, principalHash: await principalHashOf(before.salt, ALICE) });
  expect((await readGateSnapshot(dir))?.pendingGenerations[hash]).toBe(1);
  expect((await readGateFile()).eraseDeferred).toBe(true);
  await expectGated(restoreSessionStamp(dir, ALICE, stamp), "purge_pending");
  await expectGated(clearGateIntent(dir, `pending:${hash}`), "purge_pending");

  await expectGated(resumeDeferredGate(dir, { ...token!, deniedEpoch: token!.deniedEpoch + 1 }), "stamp_stale");
  expect(await deferredGateToken(dir)).toEqual(token);
  expect(await resumeDeferredGate(dir, token!)).toBe(true);
  expect(await resumeDeferredGate(dir, token!)).toBe(false);
  expect(await deferredGateToken(dir)).toBeNull();
  expect((await readGateSnapshot(dir))?.pendingGenerations[hash]).toBe(1);
  await clearGateIntent(dir, `pending:${hash}`);
  expect((await readGateSnapshot(dir))?.intents).toHaveLength(1);
});

test("clearing an intent retains its generation and is idempotent", async () => {
  await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
  const state = await readGateSnapshot(dir);
  const identityKeyHash = await identityHashOf(state!.salt, "identity");
  await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (principalHash) => [
    { id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash, recordedAt: 1 },
  ]);
  await clearGateIntent(dir, `pending:${identityKeyHash}`);
  await clearGateIntent(dir, `pending:${identityKeyHash}`);
  const after = await readGateSnapshot(dir);
  expect(after!.intents).toEqual([]);
  expect(after!.pendingGenerations[identityKeyHash]).toBe(1);
});

describe("readGateState", () => {
  test("creates a gate with a fresh incarnation, 32-byte salt and no principal", async () => {
    const state = await readGateState(dir);
    expect(state.incarnation.length).toBeGreaterThan(0);
    expect(Buffer.from(state.salt, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(state.principalHash).toBeNull();
    expect(state.lifecycleEpoch).toBe(0);
    expect(state.deniedAt).toBeNull();
    expect(state.intents).toEqual([]);
    expect(state.firstInstall).toEqual({});
    expect(state.pendingGenerations).toEqual({});
  });

  test("returns the same incarnation and salt on every read", async () => {
    const first = await readGateState(dir);
    const second = await readGateState(dir);
    expect(second.incarnation).toBe(first.incarnation);
    expect(second.salt).toBe(first.salt);
  });

  test("never stores the plaintext principal", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const text = await Bun.file(join(dir, REPLICA_GATE_FILE)).text();
    expect(text).not.toContain(ALICE);
    expect(text).not.toContain(ALICE.toLowerCase());
  });

  test("fails closed on a corrupt file", async () => {
    await writeFile(join(dir, REPLICA_GATE_FILE), "{not json");
    await expectGated(readGateState(dir), "gate_unavailable");
  });

  test("rejects malformed intents before checking a pending file", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const state = await readGateFile();
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify({ ...state, intents: [null] }));
    await expectGated(restoreSessionStamp(dir, ALICE, stamp), "gate_unavailable");
  });

  test("fails closed on an unknown version", async () => {
    await readGateState(dir);
    const parsed = await readGateFile();
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify({ ...parsed, v: 99 }));
    await expectGated(readGateState(dir), "gate_unavailable");
  });

  test("fails closed when the salt is shorter than 32 bytes", async () => {
    await readGateState(dir);
    const parsed = await readGateFile();
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify({ ...parsed, salt: "AAAA" }));
    await expectGated(readGateState(dir), "gate_unavailable");
  });

  test("fails closed when the salt is not canonical base64url", async () => {
    await readGateState(dir);
    const parsed = await readGateFile();
    const salt = `${parsed.salt as string}+/`;
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify({ ...parsed, salt }));
    await expectGated(readGateState(dir), "gate_unavailable");
  });

  test("refuses a corrupt pending generation map instead of resetting the replay fence", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const state = await readGateFile();
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify({ ...state, pendingGenerations: null }));
    await expectGated(restoreSessionStamp(dir, ALICE, stamp), "gate_unavailable");
  });

  test("missing pending generation map cannot silently reset the replay fence", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const state = await readGateFile();
    delete state.pendingGenerations;
    await writeFile(join(dir, REPLICA_GATE_FILE), JSON.stringify(state));
    await expectGated(restoreSessionStamp(dir, ALICE, stamp), "gate_unavailable");
  });
  test("leaves no temp files behind after writes", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("principalHashOf", () => {
  test("is a lowercase 64-character hex digest", async () => {
    const salt = (await readGateState(dir)).salt;
    expect(await principalHashOf(salt, ALICE)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is case-insensitive over the principal", async () => {
    const salt = (await readGateState(dir)).salt;
    expect(await principalHashOf(salt, "did:key:ABC")).toBe(await principalHashOf(salt, "did:key:abc"));
  });

  test("depends on the salt", async () => {
    const salt = (await readGateState(dir)).salt;
    const other = Buffer.alloc(32, 7).toString("base64url");
    expect(await principalHashOf(salt, ALICE)).not.toBe(await principalHashOf(other, ALICE));
  });
});

describe("establishSessionStamp", () => {
  test("sets the principal hash on first sign-in without bumping the epoch", async () => {
    const before = await readGateState(dir);
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    expect(stamp).toEqual({ incarnation: before.incarnation, lifecycleEpoch: 0 });
    const after = await readGateState(dir);
    expect(after.principalHash).toBe(await principalHashOf(after.salt, ALICE));
  });

  test("returns the current stamp for the same principal in another case", async () => {
    const first = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const again = await establishSessionStamp(dir, ALICE.toUpperCase(), { siweIssuedAt: 2 });
    expect(again).toEqual(first);
  });

  test("rejects a different principal with principal_mismatch", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await expectGated(establishSessionStamp(dir, BOB, { siweIssuedAt: 2 }), "principal_mismatch");
  });
  test("rejects a non-finite or missing SIWE anchor without creating a gate file", async () => {
    for (const siweIssuedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: siweIssuedAt as number }), "not_established");
    }
    expect(await readdir(dir)).toEqual([]);
  });


  test("rejects a non-finite or missing SIWE anchor without creating a gate file", async () => {
    for (const siweIssuedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: siweIssuedAt as number }), "not_established");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  test("rejects a sign-in issued at or before deniedAt with stamp_stale", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const denied = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(denied.status).toBe("denied");
    const { deniedAt } = await readGateState(dir);
    expect(deniedAt).not.toBeNull();
    await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: deniedAt ?? 0 }), "stamp_stale");
    await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: (deniedAt ?? 0) - 1 }), "stamp_stale");
  });

  test("accepts a sign-in issued strictly after deniedAt when the clock reaches it", async () => {
    const originalNow = Date.now();
    try {
      await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
      await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
      const deniedAt = (await readGateState(dir)).deniedAt ?? 0;
      setSystemTime(new Date(deniedAt + 2));
      const stamp = await establishSessionStamp(dir, BOB, { siweIssuedAt: deniedAt + 1 });
      expect(stamp.lifecycleEpoch).toBe(1);
    } finally {
      setSystemTime(originalNow);
    }
  });

  test("rejects with purge_pending while any intent is outstanding", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (hash) => [intent("p1", hash)]);
    const deniedAt = (await readGateState(dir)).deniedAt ?? 0;
    await expectGated(establishSessionStamp(dir, BOB, { siweIssuedAt: deniedAt + 1 }), "purge_pending");
  });
});

describe("restoreSessionStamp", () => {
  test("returns the persisted stamp when it matches the gate and principal", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    expect(await restoreSessionStamp(dir, ALICE, stamp)).toEqual(stamp);
  });

  test("returns not_established when no stamp was persisted", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await expectGated(restoreSessionStamp(dir, ALICE, undefined), "not_established");
  });

  test("returns stamp_stale after a deny moved the epoch", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    await expectGated(restoreSessionStamp(dir, ALICE, stamp), "stamp_stale");
  });

  test("returns principal_mismatch for another principal", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await expectGated(restoreSessionStamp(dir, BOB, stamp), "principal_mismatch");
  });

  test("never creates a gate file when none exists", async () => {
    await expectGated(restoreSessionStamp(dir, ALICE, undefined), "not_established");
    await expect(stat(join(dir, REPLICA_GATE_FILE))).rejects.toThrow();
  });

  test("returns purge_pending while intents are outstanding", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (hash) => [intent("p1", hash)]);
    await expectGated(restoreSessionStamp(dir, ALICE, stamp), "purge_pending");
  });
});

describe("denyGate", () => {
  test("precomputed principal hash is rechecked against the locked salt", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const state = await readGateState(dir);
    const principalHash = await principalHashOf(state.salt, ALICE);
    const wrongSalt = Buffer.alloc(32, 7).toString("base64url");
    const outcome = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => [], {
      salt: wrongSalt, principalHash,
    });
    expect(outcome.status).toBe("unguarded");
    expect((await readGateState(dir)).principalHash).toBe(principalHash);
  });

  test("returns stale and writes nothing when the principal does not match", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const before = await readGateState(dir);
    const outcome = await denyGate(dir, { reason: "sign_out", principal: BOB }, async () => [intent("x", "y")]);
    expect(outcome).toEqual({ status: "stale" });
    expect(await readGateState(dir)).toEqual(before);
  });

  test("returns stale when the gate has no principal", async () => {
    const outcome = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(outcome).toEqual({ status: "stale" });
  });

  test("sign_out clears the principal, bumps the epoch and sets deniedAt", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const before = await readGateState(dir);
    const outcome = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(outcome).toEqual({ status: "denied", lifecycleEpoch: stamp.lifecycleEpoch + 1, intents: 0 });
    const after = await readGateState(dir);
    expect(after.principalHash).toBeNull();
    expect(after.lifecycleEpoch).toBe(1);
    expect(after.deniedAt).not.toBeNull();
    expect(after.incarnation).toBe(before.incarnation);
    expect(after.salt).toBe(before.salt);
  });

  test("passes the old principal hash to collectIntents", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const { salt } = await readGateState(dir);
    let seen: string | undefined;
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (hash) => {
      seen = hash;
      return [];
    });
    expect(seen).toBe(await principalHashOf(salt, ALICE));
  });

  test("account switch clears the old gate; only a fresh post-deny sign-in binds the successor", async () => {
    const first = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const outcome = await denyGate(dir, { reason: "account_switch", principal: ALICE, next: BOB }, async () => []);
    expect(outcome.status).toBe("denied");
    const after = await readGateState(dir);
    expect(after.principalHash).toBeNull();
    await expectGated(restoreSessionStamp(dir, ALICE, first), "stamp_stale");
    const originalNow = Date.now();
    try {
      setSystemTime(new Date((after.deniedAt ?? 0) + 2));
      const second = await establishSessionStamp(dir, BOB, { siweIssuedAt: (after.deniedAt ?? 0) + 1 });
      expect(second.lifecycleEpoch).toBe(first.lifecycleEpoch + 1);
      expect((await readGateState(dir)).principalHash).toBe(await principalHashOf(after.salt, BOB));
    } finally {
      setSystemTime(originalNow);
    }
  });

  test("account_switch without next throws a TypeError", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await expect(denyGate(dir, { reason: "account_switch", principal: ALICE }, async () => [])).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  test("denial advances a pending identity generation once with its deduplicated intent", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const identityKeyHash = "a".repeat(64);
    const result = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (principalHash) => {
      const pending: ReplicaPurgeIntent = {
        id: `pending:${identityKeyHash}`,
        kind: "pending",
        identityKeyHash,
        principalHash,
        recordedAt: 1,
      };
      return [pending, pending];
    });
    expect(result).toMatchObject({ status: "denied", intents: 1 });
    const state = await readGateState(dir);
    expect(state.pendingGenerations).toEqual({ [identityKeyHash]: 1 });
    expect(state.intents).toHaveLength(1);
    expect(await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []))
      .toEqual({ status: "stale" });
    expect((await readGateState(dir)).pendingGenerations).toEqual(state.pendingGenerations);
  });

  test("clears every firstInstall anchor", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await recordFirstInstall(dir, HASH_A, 10);
    await recordFirstInstall(dir, HASH_B, 20);
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect((await readGateState(dir)).firstInstall).toEqual({});
  });

  test("returns unguarded instead of rejecting when the gate file is unreadable", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const outcome = await denyGate(join(blocker, "profile"), { reason: "sign_out", principal: ALICE }, async () => []);
    expect(outcome.status).toBe("unguarded");
  });
});

describe("firstInstall anchors", () => {
  test("recordFirstInstall keeps the first value", async () => {
    expect(await recordFirstInstall(dir, HASH_A, 10)).toBe(10);
    expect(await recordFirstInstall(dir, HASH_A, 99)).toBe(10);
    expect(await readFirstInstall(dir, HASH_A)).toBe(10);
  });

  test("readFirstInstall returns undefined without creating the gate", async () => {
    expect(await readFirstInstall(dir, HASH_A)).toBeUndefined();
    await expect(stat(join(dir, REPLICA_GATE_FILE))).rejects.toThrow();
  });

  test("a deny clears the anchor, so the next record starts over", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await recordFirstInstall(dir, HASH_A, 10);
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(await readFirstInstall(dir, HASH_A)).toBeUndefined();
    expect(await recordFirstInstall(dir, HASH_A, 50)).toBe(50);
  });
});

// I1 (#548 security review): the deny floor must survive loss of the gate file.
describe("deny floor beside the gate file", () => {
  async function deniedProfile(): Promise<{ deniedAt: number; lifecycleEpoch: number }> {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const outcome = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async (principalHash) => [
      intent(`${HASH_A}:${"c".repeat(26)}`, principalHash),
    ]);
    expect(outcome.status).toBe("denied");
    const { deniedAt, lifecycleEpoch } = await readGateState(dir);
    return { deniedAt: deniedAt!, lifecycleEpoch };
  }

  test("a first-use profile with no deny still creates its gate", async () => {
    const stamp = await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    expect(stamp.lifecycleEpoch).toBe(0);
    expect((await readGateState(dir)).principalHash).toBe(await principalHashOf((await readGateState(dir)).salt, ALICE));
  });

  test("a missing gate after a deny fails closed and is never recreated", async () => {
    const { deniedAt } = await deniedProfile();
    await rm(join(dir, REPLICA_GATE_FILE));
    const originalNow = Date.now();
    try {
      setSystemTime(new Date(deniedAt + 10));
      await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: deniedAt + 5 }), "gate_unavailable");
      await expectGated(readGateState(dir), "gate_unavailable");
      await expectGated(recordFirstInstall(dir, HASH_A, deniedAt + 6), "gate_unavailable");
      await expectGated(restoreSessionStamp(dir, ALICE, { incarnation: "x", lifecycleEpoch: 0 }), "gate_unavailable");
      await expectGated(readGateSnapshot(dir), "gate_unavailable");
      expect((await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => [])).status).toBe("unguarded");
    } finally {
      setSystemTime(originalNow);
    }
    await expect(stat(join(dir, REPLICA_GATE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a gate restored from before the latest deny fails closed", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const beforeDeny = await Bun.file(join(dir, REPLICA_GATE_FILE)).text();
    await deniedProfile();
    await writeFile(join(dir, REPLICA_GATE_FILE), beforeDeny);
    await expectGated(readGateState(dir), "gate_unavailable");
    await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 }), "gate_unavailable");
  });

  test("a malformed deny floor fails closed", async () => {
    const { lifecycleEpoch } = await deniedProfile();
    expect(lifecycleEpoch).toBe(1);
    const floor = (await readdir(dir)).filter((name) => name !== REPLICA_GATE_FILE);
    expect(floor).toHaveLength(1);
    await writeFile(join(dir, floor[0]!), "{\"epoch\":\"1\"}");
    await expectGated(readGateState(dir), "gate_unavailable");
  });
});
