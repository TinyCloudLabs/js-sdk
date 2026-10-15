import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkhDid } from "@tinycloud/sdk-core";
import { registerReplicationLoaders } from "./core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { mintCompactDelegation } from "./test-support/compact-delegation";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import type { ReplicationModuleLoaders } from "./replication/module-registry";
// @ts-ignore node-sdk moduleResolution "node" cannot read replica exports (see replica-contract.ts)
import * as replicaGate from "@tinycloud/replica/profile-gate";

const RESTORE_HOST = "http://127.0.0.1:1";
const OTHER_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const GATE_FILE = "replica-gate.json";

const storage = {
  kind: "sqlite" as const,
  async open() { throw new Error("gate tests must not open storage"); },
  async purge() {},
};

class StubRuntime {
  readonly control = {
    status: async () => [],
    sync: async () => {},
    purge: async () => ({ purged: [], failed: [] }),
    clearPending: async () => 0,
    close: async () => {},
  };
  constructor(_options: unknown) {}
  async bind() {}
  async unbind() {}
}

function loaders(): ReplicationModuleLoaders {
  return {
    runtime: () => import("./replication/runtime"),
    authority: () => import("./replication/authority"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  };
}

const dirs: string[] = [];

beforeEach(() => {
  registerReplicationLoaders({
    ...loaders(),
    runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
  });
});

afterEach(() => {
  registerReplicationLoaders(loaders());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc858-gate-"));
  dirs.push(dir);
  return dir;
}

function profileGuard(dir: string): <T>(section: () => Promise<T>) => Promise<T> {
  const lock = join(dir, ".replica-test-profile-lock");
  return async (section) => {
    await mkdir(lock);
    try {
      return await section();
    } finally {
      await rmdir(lock);
    }
  };
}

function replicatedNode(dir?: string): TinyCloudNode {
  return new TinyCloudNode({
    host: RESTORE_HOST,
    signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
    wasmBindings: new NodeWasmBindings(),
    replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: dir, profileGuard: dir ? profileGuard(dir) : undefined },
  });
}

describe("replica gate: restore", () => {
  test("restores when the persisted stamp matches the profile gate", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });

    expect(node.address).toBe(proof.address);
    expect(node.spaceId).toBe(proof.spaceId);
    expect(await node.replication!.status()).toEqual([]);
  });

  test("keeps a verified network restore when replica runtime binding fails", async () => {
    class FailingRuntime extends StubRuntime {
      override async bind() { throw new Error("replica runtime unavailable"); }
    }
    registerReplicationLoaders({
      ...loaders(),
      runtime: async () => ({ ReplicationRuntime: FailingRuntime }) as never,
    });
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const node = replicatedNode(dir);

    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.address).toBe(proof.address);
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({
      state: "gated",
      gate: "gate_unavailable",
      errorCode: "REPLICA_GATED",
    });
  });

  test("restores the network session but gates a stamp that predates sign-out", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    await replicaGate.denyGate(dir, { reason: "sign_out", principal }, async () => []);

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.address).toBe(proof.address);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "stamp_stale" });
    await expect(node.replication!.sync({ prefix: "notes/" })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("keeps the network session while rejecting malformed replica metadata", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const malformed = { ...replicaStamp, forged: true };
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp: malformed });

    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "stamp_stale" });
  });

  test("keeps an unstamped network session with replica gated", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession(proof);
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "not_established" });
  });

  test("keeps the network session while profile purge is pending", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    await replicaGate.denyGate(dir, { reason: "sign_out", principal }, async (principalHash) => [{
      id: "pending-partition",
      kind: "partition",
      partitionId: "partition-1",
      principalHash,
      recordedAt: 1,
    }]);

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "purge_pending" });
  });

  test("keeps the network session when the replica profile belongs to another principal", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(OTHER_ADDRESS, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "principal_mismatch" });
  });

  test("keeps the network session without a replica profile directory", async () => {
    const proof = await signedRestorableSession();

    const node = replicatedNode();
    await node.restoreSession(proof);
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "gate_unavailable" });
  });

  test("keeps a compact network session when replica-only scope verification throws", async () => {
    registerReplicationLoaders({
      ...loaders(),
      runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
      authority: async () => ({
        replicationScopeFromSignedSession: () => { throw new Error("replica scope unavailable"); },
      }) as never,
    });
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const delegateDid = manager.getDID("default").split("#", 1)[0]!;
    const imported = await mintCompactDelegation({
      audience: delegateDid,
      expSecs: Math.floor(Date.now() / 1000) + 3600,
      host: RESTORE_HOST,
    });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: profileDir() },
    });
    await node.restoreSession({
      delegationHeader: imported.delegation.delegationHeader,
      delegationCid: imported.delegation.cid,
      spaceId: imported.spaceId,
      jwk: JSON.parse(manager.jwk("default")!),
      verificationMethod: delegateDid,
    });
    expect(node.spaceId).toBe(imported.spaceId);
    expect(node.isSessionOnly).toBe(true);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "gate_unavailable" });
  });

  test("restores without a stamp when replication is disabled", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });

    await node.restoreSession(proof);

    expect(node.address).toBe(proof.address);
  });
});

function readGateFile(dir: string): { principalHash: string | null; lifecycleEpoch: number } {
  return JSON.parse(readFileSync(join(dir, GATE_FILE), "utf8"));
}

describe("replica gate: sign-out", () => {
  test("denies the gate for the leaving principal and bumps the lifecycle epoch", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    const before = readGateFile(dir);

    await node.signOut();

    const after = readGateFile(dir);
    expect(after.principalHash).toBeNull();
    expect(after.lifecycleEpoch).toBe(before.lifecycleEpoch + 1);
  });

  test("refuses an unlocked profile denial while still ending the network session", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: dir },
    });
    await node.restoreSession({ ...proof, replicaStamp });
    const before = readGateFile(dir);

    await expect(node.signOut()).rejects.toThrow("Replica gate was not denied");
    expect(node.restorableSession).toBeUndefined();
    expect(readGateFile(dir)).toEqual(before);
  });

  test("throws when the gate cannot be denied", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    writeFileSync(join(dir, GATE_FILE), "{not json");

    await expect(node.signOut()).rejects.toThrow("Replica gate was not denied");
  });

  test("leaves no gate behind when replication is disabled", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });
    await node.restoreSession(proof);

    await expect(node.signOut()).resolves.toBeUndefined();
  });
});
