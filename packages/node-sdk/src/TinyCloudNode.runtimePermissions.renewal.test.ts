import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { pkhDid, SessionExpiredError, type PermissionEntry } from "@tinycloud/sdk-core";
import type { RenewalStampHistoryEntry } from "@tinycloud/sdk-core/delegations/renewal";
import { encodeDagCbor } from "../../sdk-core/src/delegations/cacao";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { signedLocationRecordForTest, signedRegistryResponseForTest } from "./test-support/restored-policy-node";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

afterEach(() => {
  setSystemTime();
  mock.restore();
});

async function setup({ invalidStamp = false } = {}) {
  const host = "https://node.runtime-renewal.test";
  const registry = "https://registry.runtime-renewal.test";
  const proof = await signedRestorableSession();
  const session = { ...proof, tinycloudHosts: [host] };
  const signedEnd = Date.parse(proof.expiresAt);
  const renewedEnd = Math.floor((signedEnd + 3 * 60 * 60_000) / 1000) * 1000;
  const leaseEnd = renewedEnd + 60 * 60_000;
  const nodeKey = crypto.getRandomValues(new Uint8Array(32));
  const renewerKey = crypto.getRandomValues(new Uint8Array(32));
  const renewerPublicKey = ed25519.getPublicKey(renewerKey);
  const nodeDid = `did:key:${base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(nodeKey)]))}`;
  const renewerDid = `did:key:${base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
  const record = await signedLocationRecordForTest({
    ownerDid: pkhDid(proof.address, proof.chainId),
    ownerPrivateKey: PROOF_PRIVATE_KEY,
    host,
    nodeDid,
    spaces: [proof.spaceId],
    sequence: 1,
  });
  const status = {
    cid: proof.delegationCid,
    status: "active",
    exists: true,
    active: true,
    revoked: false,
    expired: false,
    effective_expiry: renewedEnd / 1000,
    renewal_history: [] as RenewalStampHistoryEntry[],
  };
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const registryResponse = signedRegistryResponseForTest(input, init, registry, record);
    if (registryResponse) return registryResponse;
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== host) throw new Error(`Unexpected test origin: ${url.origin}`);
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: nodeDid });
    if (url.pathname === "/.well-known/tinycloud/node-keys") {
      return Response.json({
        nodeDid,
        shareInvitationPublicKey: "A".repeat(43),
        renewerDid,
        renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"),
        renewerEpoch: 1,
      });
    }
    if (url.pathname === "/delegate" && request.method === "POST") {
      return Response.json({ activated: [proof.spaceId], skipped: [] });
    }
    if (url.pathname === "/delegation/status" && request.method === "POST") return Response.json(status);
    throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
  });
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const wasmBindings = new NodeWasmBindings();
  const node = new TinyCloudNode({ host, wasmBindings, tinycloudRegistryUrl: registry, autoDiscoverLocalNode: false });
  const owner = new TinyCloudNode({ host, signer, wasmBindings, tinycloudRegistryUrl: registry, autoDiscoverLocalNode: false });
  await owner.restoreSession(session);
  const lease = await owner.createRenewalLease(new Date(leaseEnd));
  const signedBytes = encodeDagCbor({
    domain: "tinycloud/node/renewal-stamp/v1",
    unsigned: {
      type: "TinyCloudRenewalStamp",
      newEnd: new Date(renewedEnd).toISOString().replace(".000Z", "Z"),
      nodeDid,
      version: 1,
      leaseCid: lease.leaseCid,
      originalCid: proof.delegationCid,
      renewerEpoch: 1,
      leaseGeneration: 1,
      previousStampCid: lease.leaseCid,
    },
  });
  const signature = invalidStamp ? Buffer.alloc(64) : ed25519.sign(signedBytes, renewerKey);
  status.renewal_history.push({
    cid: CID.createV1(0x55, createDigest(0x1e, blake3(signedBytes))).toString(),
    lease_cid: lease.leaseCid,
    generation: 1,
    previous_stamp_cid: lease.leaseCid,
    new_end: renewedEnd / 1000,
    signed_bytes: Buffer.from(signedBytes).toString("base64url"),
    signature: Buffer.from(signature).toString("base64url"),
  });
  await node.restoreSession(session);
  const signMessage = mock((siwe: string) => signer.signMessage(siwe));
  const permission: PermissionEntry = {
    service: "tinycloud.encryption",
    path: `${node.getDefaultEncryptionNetworkId()}/secrets/example`,
    actions: ["tinycloud.encryption/decrypt"],
  };
  setSystemTime(new Date(signedEnd + 60_000));
  const restoreWithLease = () => node.restoreSessionWithRenewal(session, lease.leaseAuthorization);
  return { node, permission, signMessage, restoreWithLease, signedEnd, renewedEnd, leaseEnd };
}

async function expectExpired({ node, permission, signMessage }: Awaited<ReturnType<typeof setup>>, end: number) {
  const attempt = node.grantRuntimePermissions([permission], { signMessage });
  await expect(attempt).rejects.toBeInstanceOf(SessionExpiredError);
  await expect(attempt).rejects.toHaveProperty("expiredAt", new Date(end));
  expect(signMessage).not.toHaveBeenCalled();
}

test("a lease-restored session signs an exact-key runtime grant capped at the verified renewed end", async () => {
  const { node, permission, signMessage, restoreWithLease, renewedEnd } = await setup();
  await restoreWithLease();

  const grants = await node.grantRuntimePermissions([permission], { expiry: "1d", signMessage });

  expect(signMessage).toHaveBeenCalledTimes(1);
  expect(signMessage.mock.calls[0]![0]).toContain(`Expiration Time: ${new Date(renewedEnd).toISOString()}`);
  expect(grants).toHaveLength(1);
  expect(grants[0]!.expiry.getTime()).toBe(renewedEnd);
  expect(grants[0]!.resources).toEqual([expect.objectContaining({
    path: permission.path,
    actions: permission.actions,
  })]);
});

test("the signed end still applies without a verified renewal", async () => {
  const context = await setup();
  await expectExpired(context, context.signedEnd);
});

test("an invalid renewal signature leaves the runtime grant bound to the signed end", async () => {
  const context = await setup({ invalidStamp: true });
  await expect(context.restoreWithLease()).rejects.toThrow("Renewal stamp signature is invalid");
  await expectExpired(context, context.signedEnd);
});

test("an ended lease and renewal can no longer authorize a runtime grant", async () => {
  const context = await setup();
  await context.restoreWithLease();
  setSystemTime(new Date(context.leaseEnd + 60_000));
  await expect(context.restoreWithLease()).rejects.toThrow("Renewal lease has expired");
  await expectExpired(context, context.renewedEnd);
});
