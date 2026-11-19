import { describe, expect, test } from "bun:test";
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

/** A registry queue that runs `whileHeld` when the restore reaches it, then drains. */
function heldRegistryTail(whileHeld: () => void) {
  let reached = false;
  return {
    get reached() { return reached; },
    tail: {
      then(resolve: () => void) {
        reached = true;
        whileHeld();
        resolve();
      },
    },
  };
}

describe("restore re-checks expiry at commit (TC-2936)", () => {
  test("a session that expires while the registry queue drains is not installed", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      host: "https://commit-expiry.test",
      wasmBindings: new NodeWasmBindings(),
      tinycloudRegistryUrl: null,
      autoBootstrapAccount: false,
    });
    const originalNow = Date.now;
    const held = heldRegistryTail(() => {
      const expired = Date.parse(proof.expiresAt!) + 1_000;
      Date.now = () => expired;
    });
    Reflect.set(node, "accountRegistryTail", held.tail);
    try {
      await expect(node.restoreSession({ ...proof, tinycloudHosts: ["https://commit-expiry.test"] }))
        .rejects.toThrow("expired");
      expect(held.reached).toBe(true);
      expect(node.restorableSession).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  test("a renewed session whose effective expiry passes before commit is not installed", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const proof = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(proof.address!, proof.chainId!);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;
    const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
    const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.commit-renewal.test";
    const registry = "https://registry.commit-renewal.test";
    const record = await signedLocationRecordForTest({
      ownerDid, ownerPrivateKey: privateKey, host, nodeDid, spaces: [proof.spaceId], sequence: 1,
    });
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
      if (url.pathname === "/delegation/status" && request.method === "POST") {
        return Response.json({
          cid: proof.delegationCid, status: "active", exists: true, active: true, revoked: false, expired: false,
          effective_expiry: effectiveExpiry, renewal_history: statusHistory,
        });
      }
      throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const config = {
        host,
        signer: new PrivateKeySigner(privateKey),
        wasmBindings: new NodeWasmBindings(),
        tinycloudRegistryUrl: registry,
        autoDiscoverLocalNode: false,
      };
      const owner = new TinyCloudNode(config);
      await owner.restoreSession({ ...proof, tinycloudHosts: [host] });
      const originalExpiry = Date.parse(proof.expiresAt!);
      const lease = await owner.createRenewalLease(new Date(originalExpiry + 4 * 60 * 60 * 1000));
      const stampEnd = Math.floor((originalExpiry + 3 * 60 * 60 * 1000) / 1000);
      const signedBytes = encodeDagCbor({
        domain: "tinycloud/node/renewal-stamp/v1",
        unsigned: {
          type: "TinyCloudRenewalStamp",
          newEnd: new Date(stampEnd * 1000).toISOString().replace(".000Z", "Z"),
          nodeDid,
          version: 1,
          leaseCid: lease.leaseCid,
          originalCid: proof.delegationCid,
          renewerEpoch: 1,
          leaseGeneration: 1,
          previousStampCid: lease.leaseCid,
        },
      });
      const stampCid = CID.createV1(0x55, createDigest(0x1e, blake3(signedBytes))).toString();
      statusHistory = [{
        cid: stampCid,
        lease_cid: lease.leaseCid,
        generation: 1,
        previous_stamp_cid: lease.leaseCid,
        new_end: stampEnd,
        signed_bytes: Buffer.from(signedBytes).toString("base64url"),
        signature: Buffer.from(ed25519.sign(signedBytes, renewerSeed)).toString("base64url"),
      }];
      effectiveExpiry = stampEnd;
      Date.now = () => originalExpiry + 60_000;

      const node = new TinyCloudNode(config);
      const held = heldRegistryTail(() => {
        Date.now = () => stampEnd * 1000 + 1_000;
      });
      Reflect.set(node, "accountRegistryTail", held.tail);

      await expect(node.restoreSessionWithRenewal({ ...proof, tinycloudHosts: [host] }, lease.leaseAuthorization))
        .rejects.toThrow("expired");
      expect(held.reached).toBe(true);
      expect(node.restorableSession).toBeUndefined();
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
});
