import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { REGISTRY_NOT_FOUND_BODY, pkhDid, parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { encodeDagCbor } from "../../sdk-core/src/delegations/cacao";
import { signedRestorableSession } from "./test-support/signed-restorable-session";
import { signedLocationRecordForTest } from "./test-support/restored-policy-node";

describe("TinyCloudNode renewal lease registration", () => {
  test("signs and admits only the exact renewal capability for its active node identity", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const proof = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(proof.address, proof.chainId);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;
    const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
    const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.renewal.test";
    const registry = "https://registry.renewal.test";
    const record = await signedLocationRecordForTest({
      ownerDid,
      ownerPrivateKey: privateKey,
      host,
      nodeDid,
      spaces: [proof.spaceId],
      sequence: 1,
    });
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        url: url.href,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      if (url.origin === registry) {
        if (url.pathname === `/v2/locations/${encodeURIComponent(proof.address)}`) {
          return Response.json({ record });
        }
        return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      }
      if (url.origin !== host) throw new Error(`Unexpected test origin: ${url.origin}`);
      if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: nodeDid });
      if (url.pathname === "/.well-known/tinycloud/node-keys") {
        return Response.json({ nodeDid, shareInvitationPublicKey: "A".repeat(43), renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 1 });
      }
      if (url.pathname === "/delegate" && request.method === "POST") {
        return Response.json({ activated: [proof.spaceId], skipped: [] });
      }
      throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const node = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(privateKey),
        wasmBindings: new NodeWasmBindings(),
        tinycloudRegistryUrl: registry,
        autoDiscoverLocalNode: false,
      });
      await node.restoreSession({ ...proof, tinycloudHosts: [host] });
      const identity = await node.renewalNodeIdentity();
      expect(identity).toEqual({ nodeDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 1 });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const receipt = await node.createRenewalLease(expiresAt);
      const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ""), receipt.leaseCid);
      expect(receipt).toMatchObject({ originalCid: proof.delegationCid, leaseCid: lease.cid, leaseGeneration: 1, nodeIdentity: identity });
      expect(lease.issuer).toBe(ownerDid);
      expect(lease.audience).toBe(renewerDid);
      expect(lease.attenuation).toEqual({ [`urn:cid:${proof.delegationCid}`]: { "tinycloud.delegation/renew": [{}] } });
      expect(Date.parse(lease.expiresAt!)).toBe(expiresAt.getTime());
      expect(requests.some(({ url }) => url === `${host}/.well-known/tinycloud/node-keys`)).toBe(true);
      expect(requests.some(({ url }) => url === `${host}/delegate`)).toBe(true);
      const realNow = Date.now;
      Date.now = () => Date.parse(proof.expiresAt) + 1;
      try {
        const expiredLeaseError = await node.createRenewalLease(new Date(realNow() + 60 * 60 * 1000)).then(
          () => null,
          (error: unknown) => error,
        );
        expect(expiredLeaseError).toMatchObject({
          name: "RenewalLeaseOriginalExpiredError",
          code: "RENEWAL_LEASE_ORIGINAL_EXPIRED",
          message: "Cannot create a renewal lease after the original session expires",
        });
      } finally {
        Date.now = realNow;
      }


    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("verifies an expired signed session as a candidate without accepting a changed signature", async () => {
    const proof = await signedRestorableSession({ expired: true });
    const wasm = new NodeWasmBindings();
    const verified = wasm.validatePersistedSessionForRenewal({
      delegationHeader: proof.delegationHeader,
      delegationCid: proof.delegationCid,
      spaceId: proof.spaceId,
      jwk: proof.jwk,
      address: proof.address!,
      chainId: proof.chainId!,
      siwe: proof.siwe!,
      signature: proof.signature!,
    });
    expect(Date.parse(verified.expiresAt!)).toBeLessThan(Date.now());
    expect(() => wasm.validatePersistedSessionForRenewal({
      delegationHeader: proof.delegationHeader,
      delegationCid: proof.delegationCid,
      spaceId: proof.spaceId,
      jwk: proof.jwk,
      address: proof.address!,
      chainId: proof.chainId!,
      siwe: proof.siwe!,
      signature: "0x",
    })).toThrow();
  });
  test("does not commit an expired session when renewal verification fails", async () => {
    const proof = await signedRestorableSession({ expired: true });
    const node = new TinyCloudNode({
      host: "https://node.renewal.test",
      wasmBindings: new NodeWasmBindings(),
      autoDiscoverLocalNode: false,
    });
    await expect(node.restoreSessionWithRenewal({ ...proof, tinycloudHosts: ["https://node.renewal.test"] }, "")).rejects.toThrow();
    expect(node.restorableSession).toBeUndefined();
  });

  test("does not commit renewal restore when status is revoked, expired, or unavailable", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const proof = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(proof.address!, proof.chainId!);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodePublicKey = ed25519.getPublicKey(nodeSeed);
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...nodePublicKey]))}`;
    const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
    const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.renewal-refusal.test";
    const registry = "https://registry.renewal-refusal.test";
    const record = await signedLocationRecordForTest({
      ownerDid,
      ownerPrivateKey: privateKey,
      host,
      nodeDid,
      spaces: [proof.spaceId],
      sequence: 1,
    });
    let statusMode: "revoked" | "expired" | "unavailable" = "revoked";
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
        if (statusMode === "unavailable") return new Response("unavailable", { status: 503 });
        return Response.json({
          cid: proof.delegationCid,
          status: "active",
          exists: true,
          active: true,
          revoked: statusMode === "revoked",
          expired: statusMode === "expired",
          effective_expiry: Math.floor((Date.parse(proof.expiresAt!) + 4 * 60 * 60 * 1000) / 1000),
          renewal_history: [],
        });
      }
      throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const owner = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(privateKey),
        wasmBindings: new NodeWasmBindings(),
        tinycloudRegistryUrl: registry,
        autoDiscoverLocalNode: false,
      });
      await owner.restoreSession({ ...proof, tinycloudHosts: [host] });
      const originalExpiry = Date.parse(proof.expiresAt!);
      const lease = await owner.createRenewalLease(new Date(originalExpiry + 4 * 60 * 60 * 1000));
      Date.now = () => originalExpiry + 60_000;

      for (const mode of ["revoked", "expired", "unavailable"] as const) {
        statusMode = mode;
        const candidate = new TinyCloudNode({
          host,
          wasmBindings: new NodeWasmBindings(),
          tinycloudRegistryUrl: registry,
          autoDiscoverLocalNode: false,
        });
        await expect(candidate.restoreSessionWithRenewal(
          { ...proof, tinycloudHosts: [host] },
          lease.leaseAuthorization,
        )).rejects.toThrow();
        expect(candidate.restorableSession).toBeUndefined();
      }
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });

  test("restores an expired original only after verifying the node-admitted stamp chain", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const proof = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(proof.address!, proof.chainId!);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodePublicKey = ed25519.getPublicKey(nodeSeed);
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...nodePublicKey]))}`;
    const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
    const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.renewal.test";
    const registry = "https://registry.renewal.test";
    const record = await signedLocationRecordForTest({
      ownerDid,
      ownerPrivateKey: privateKey,
      host,
      nodeDid,
      spaces: [proof.spaceId],
      sequence: 1,
    });
    const requests: string[] = [];
    let statusHistory: unknown[] = [];
    let effectiveExpiry = 0;
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.href}`);
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
          cid: proof.delegationCid,
          status: "active",
          exists: true,
          active: true,
          revoked: false,
          expired: false,
          effective_expiry: effectiveExpiry,
          renewal_history: statusHistory,
        });
      }
      throw new Error(`Unexpected test route: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const node = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(privateKey),
        wasmBindings: new NodeWasmBindings(),
        tinycloudRegistryUrl: registry,
        autoDiscoverLocalNode: false,
      });
      await node.restoreSession({ ...proof, tinycloudHosts: [host] });
      const originalExpiry = Date.parse(proof.expiresAt!);
      const leaseExpiresAt = new Date(originalExpiry + 4 * 60 * 60 * 1000);
      const lease = await node.createRenewalLease(leaseExpiresAt);
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

      await node.restoreSessionWithRenewal(
        { ...proof, tinycloudHosts: [host] },
        lease.leaseAuthorization,
      );

      expect(node.restorableSession?.delegationCid).toBe(proof.delegationCid);
      expect(await node.getRenewalEffectiveExpiry(lease.leaseAuthorization)).toBe(stampEnd);
      expect(requests.some((request) => request === `POST ${host}/delegation/status`)).toBe(true);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });

});
