import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { REGISTRY_NOT_FOUND_BODY, pkhDid } from "@tinycloud/sdk-core";
import { encodeDagCbor } from "../../sdk-core/src/delegations/cacao";
import { signedRestorableSession } from "./test-support/signed-restorable-session";
import { signedLocationRecordForTest } from "./test-support/restored-policy-node";

// TC-3522: after a renewal restore, delegations reach the end the node renewed the session to; a later restore without
// the lease is back to the signed end. Synthetic owner, node and renewal stamp; this file's fetch stands in for the node.
test("a renewed session delegates up to its renewed end, and a plain restore after it only up to the signed end", async () => {
  const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const proof = await signedRestorableSession({ privateKey });
  const ownerDid = pkhDid(proof.address!, proof.chainId!);
  const nodePublicKey = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
  const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...nodePublicKey]))}`;
  const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
  const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
  const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
  const host = "https://node.session-end.test";
  const registry = "https://registry.session-end.test";
  const record = await signedLocationRecordForTest({ ownerDid, ownerPrivateKey: privateKey, host, nodeDid, spaces: [proof.spaceId], sequence: 1 });
  let statusHistory: unknown[] = [];
  let effectiveExpiry = 0;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === registry) {
      if (url.pathname === `/v2/locations/${encodeURIComponent(proof.address!)}`) return Response.json({ record });
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    }
    if (url.origin !== host) throw new Error(`Unexpected test origin: ${url.origin}`);
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: nodeDid });
    if (url.pathname === "/.well-known/tinycloud/node-keys") {
      return Response.json({ nodeDid, shareInvitationPublicKey: "A".repeat(43), renewerDid,
        renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 1 });
    }
    if (url.pathname === "/delegate" && request.method === "POST") return Response.json({ activated: [proof.spaceId], skipped: [] });
    if (url.pathname === "/delegation/status" && request.method === "POST") {
      return Response.json({ cid: proof.delegationCid, status: "active", exists: true, active: true, revoked: false, expired: false,
        effective_expiry: effectiveExpiry, renewal_history: statusHistory });
    }
    throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
  }) as typeof fetch;

  try {
    const node = new TinyCloudNode({ host, signer: new PrivateKeySigner(privateKey), wasmBindings: new NodeWasmBindings(),
      tinycloudRegistryUrl: registry, autoDiscoverLocalNode: false });
    await node.restoreSession({ ...proof, tinycloudHosts: [host] });
    const signedEnd = Date.parse(proof.expiresAt!);
    const lease = await node.createRenewalLease(new Date(signedEnd + 4 * 60 * 60 * 1000));
    const stampEnd = Math.floor((signedEnd + 3 * 60 * 60 * 1000) / 1000);
    const signedBytes = encodeDagCbor({
      domain: "tinycloud/node/renewal-stamp/v1",
      unsigned: { type: "TinyCloudRenewalStamp", newEnd: new Date(stampEnd * 1000).toISOString().replace(".000Z", "Z"), nodeDid,
        version: 1, leaseCid: lease.leaseCid, originalCid: proof.delegationCid, renewerEpoch: 1, leaseGeneration: 1, previousStampCid: lease.leaseCid },
    });
    statusHistory = [{ cid: CID.createV1(0x55, createDigest(0x1e, blake3(signedBytes))).toString(), lease_cid: lease.leaseCid, generation: 1,
      previous_stamp_cid: lease.leaseCid, new_end: stampEnd, signed_bytes: Buffer.from(signedBytes).toString("base64url"),
      signature: Buffer.from(ed25519.sign(signedBytes, renewerSeed)).toString("base64url") }];
    effectiveExpiry = stampEnd;
    const peer = new NodeWasmBindings().createSessionManager().getDID("default").split("#")[0]!;
    const read = [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }];

    // Past the signed end, restored through the lease: a day-long delegation ends at the renewed end.
    Date.now = () => signedEnd + 60_000;
    await node.restoreSessionWithRenewal({ ...proof, tinycloudHosts: [host] }, lease.leaseAuthorization);
    expect(node.sessionEnd?.getTime()).toBe(stampEnd * 1000);
    const renewed = await node.delegateTo(peer, read, { expiry: "1d" });
    expect(renewed.delegation.expiry.getTime()).toBe(stampEnd * 1000);

    // Before the signed end, restored without the lease: the renewed end from the earlier restore no longer applies.
    Date.now = () => signedEnd - 10 * 60_000;
    await node.restoreSession({ ...proof, tinycloudHosts: [host] });
    expect(node.sessionEnd?.getTime()).toBe(signedEnd);
    const signed = await node.delegateTo(peer, read, { expiry: "1d" });
    expect(signed.delegation.expiry.getTime()).toBe(Math.floor(signedEnd / 1000) * 1000);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});
