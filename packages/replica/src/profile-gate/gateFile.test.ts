import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import type { ReplicaPurgeIntent } from "@tinycloud/sdk-services/kv/replication";
import {
  denyGate,
  establishSessionStamp,
  principalHashOf,
  readFirstInstall,
  readGateState,
  recordFirstInstall,
  restoreSessionStamp,
} from "./gateFile";

const ALICE = "did:key:z6MkAlice";
const BOB = "did:key:z6MkBob";

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

  test("rejects a sign-in issued at or before deniedAt with stamp_stale", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const denied = await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(denied.status).toBe("denied");
    const { deniedAt } = await readGateState(dir);
    expect(deniedAt).not.toBeNull();
    await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: deniedAt ?? 0 }), "stamp_stale");
    await expectGated(establishSessionStamp(dir, ALICE, { siweIssuedAt: (deniedAt ?? 0) - 1 }), "stamp_stale");
  });

  test("accepts a sign-in issued after deniedAt", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    const deniedAt = (await readGateState(dir)).deniedAt ?? 0;
    const stamp = await establishSessionStamp(dir, BOB, { siweIssuedAt: deniedAt + 1 });
    expect(stamp.lifecycleEpoch).toBe(1);
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

  test("account_switch moves the principal hash to the next principal, case-insensitively", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    const outcome = await denyGate(dir, { reason: "account_switch", principal: ALICE, next: BOB.toUpperCase() }, async () => []);
    expect(outcome.status).toBe("denied");
    const after = await readGateState(dir);
    expect(after.principalHash).toBe(await principalHashOf(after.salt, BOB));
  });

  test("account_switch without next throws a TypeError", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await expect(denyGate(dir, { reason: "account_switch", principal: ALICE }, async () => [])).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  test("deduplicates intents by id across denies", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await denyGate(dir, { reason: "account_switch", principal: ALICE, next: BOB }, async (hash) => [intent("p1", hash)]);
    const second = await denyGate(dir, { reason: "account_switch", principal: BOB, next: ALICE }, async (hash) => [
      intent("p1", hash),
      intent("p2", hash),
    ]);
    expect(second).toMatchObject({ status: "denied", intents: 2 });
    const after = await readGateState(dir);
    expect(after.intents.map((entry) => entry.id)).toEqual(["p1", "p2"]);
  });

  test("clears every firstInstall anchor", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await recordFirstInstall(dir, "hash-a", 10);
    await recordFirstInstall(dir, "hash-b", 20);
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
    expect(await recordFirstInstall(dir, "hash-a", 10)).toBe(10);
    expect(await recordFirstInstall(dir, "hash-a", 99)).toBe(10);
    expect(await readFirstInstall(dir, "hash-a")).toBe(10);
  });

  test("readFirstInstall returns undefined without creating the gate", async () => {
    expect(await readFirstInstall(dir, "hash-a")).toBeUndefined();
    await expect(stat(join(dir, REPLICA_GATE_FILE))).rejects.toThrow();
  });

  test("a deny clears the anchor, so the next record starts over", async () => {
    await establishSessionStamp(dir, ALICE, { siweIssuedAt: 1 });
    await recordFirstInstall(dir, "hash-a", 10);
    await denyGate(dir, { reason: "sign_out", principal: ALICE }, async () => []);
    expect(await readFirstInstall(dir, "hash-a")).toBeUndefined();
    expect(await recordFirstInstall(dir, "hash-a", 50)).toBe(50);
  });
});
