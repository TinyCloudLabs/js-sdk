import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkhDid } from "@tinycloud/sdk-core";
import { registerReplicationLoaders } from "./core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
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

function replicatedNode(dir?: string): TinyCloudNode {
  return new TinyCloudNode({
    host: RESTORE_HOST,
    signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
    wasmBindings: new NodeWasmBindings(),
    replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: dir },
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
  });

  test("refuses a stamp that predates a sign-out", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    await replicaGate.denyGate(dir, { reason: "sign_out", principal }, async () => []);

    await expect(replicatedNode(dir).restoreSession({ ...proof, replicaStamp })).rejects.toMatchObject({
      gate: "stamp_stale",
    });
  });

  test("refuses a session with no persisted stamp", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    await expect(replicatedNode(dir).restoreSession(proof)).rejects.toMatchObject({
      gate: "not_established",
    });
  });

  test("refuses while a purge is pending for the profile", async () => {
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

    await expect(replicatedNode(dir).restoreSession({ ...proof, replicaStamp })).rejects.toMatchObject({
      gate: "purge_pending",
    });
  });

  test("refuses a profile bound to another principal", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(OTHER_ADDRESS, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    await expect(replicatedNode(dir).restoreSession({ ...proof, replicaStamp })).rejects.toMatchObject({
      gate: "principal_mismatch",
    });
  });

  test("refuses replicated restore without a profile directory", async () => {
    const proof = await signedRestorableSession();

    await expect(replicatedNode().restoreSession(proof)).rejects.toMatchObject({
      gate: "gate_unavailable",
    });
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
