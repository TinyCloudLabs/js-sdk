import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { REGISTRY_NOT_FOUND_BODY, pkhDid } from "@tinycloud/sdk-core";
import { signedRestorableSession } from "./test-support/signed-restorable-session";
import { signedLocationRecordForTest } from "./test-support/restored-policy-node";
import type { ServiceHeaders } from "@tinycloud/sdk-services";

function authorizationValue(headers: ServiceHeaders): string {
  if (Array.isArray(headers)) {
    const authorization = headers.find(([name]) => name.toLowerCase() === "authorization")?.[1];
    if (authorization) return authorization;
  } else {
    const authorization = headers.Authorization ?? headers.authorization;
    if (authorization) return authorization;
  }
  throw new Error("Invocation has no Authorization header");
}

function claims(authorization: string) {
  const compact = authorization.replace(/^Bearer\s+/i, "");
  const payload = compact.split(".")[1];
  if (!payload) throw new Error("Authorization is not a compact token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    iss: string;
    att: Record<string, Record<string, unknown[]>>;
    prf: string[];
  };
}

describe("TinyCloudNode delegation status proof shape", () => {
  test("uses the SDK-RS proofless status invocation for the lease receipt's original CID", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const session = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(session.address, session.chainId);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;
    const renewerPublicKey = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.status-proof.test";
    const registry = "https://registry.status-proof.test";
    const record = await signedLocationRecordForTest({ ownerDid, ownerPrivateKey: privateKey, host, nodeDid, spaces: [session.spaceId], sequence: 1 });
    const wasm = new NodeWasmBindings();
    const statusInvocationCalls: Array<{ cid: string; audience: string }> = [];
    if (typeof wasm.invokeDelegationStatus !== "function") {
      throw new Error("Node WASM does not expose proofless delegation status invocation");
    }
    const signedStatusInvocation = wasm.invokeDelegationStatus.bind(wasm);
    wasm.invokeDelegationStatus = (sessionValue, cid, audience) => {
      statusInvocationCalls.push({ cid, audience });
      return signedStatusInvocation(sessionValue, cid, audience);
    };

    const statusRequests: Array<{ authorization: string; cid: string; url: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === registry) {
        if (url.pathname === `/v2/locations/${encodeURIComponent(session.address)}`) return Response.json({ record });
        return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      }
      if (url.origin !== host) throw new Error(`Unexpected origin ${url.origin}`);
      if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: nodeDid });
      if (url.pathname === "/.well-known/tinycloud/node-keys") {
        return Response.json({ nodeDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 1, shareInvitationPublicKey: "A".repeat(43) });
      }
      if (url.pathname === "/delegate" && request.method === "POST") return Response.json({ activated: [session.spaceId], skipped: [] });
      if (url.pathname === "/delegation/status" && request.method === "POST") {
        const body = await request.json();
        if (!body || typeof body !== "object" || !("cid" in body) || typeof body.cid !== "string") {
          throw new Error("Status request has no CID");
        }
        statusRequests.push({
          authorization: request.headers.get("authorization") ?? "",
          cid: body.cid,
          url: url.href,
        });
        return Response.json({ cid: session.delegationCid, status: "active", exists: true, active: true, revoked: false, expired: false, effective_expiry: Math.floor(Date.now() / 1000) + 600, renewal_history: [] });
      }
      throw new Error(`Unexpected route ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const node = new TinyCloudNode({ host, signer: new PrivateKeySigner(privateKey), wasmBindings: wasm, tinycloudRegistryUrl: registry, autoDiscoverLocalNode: false });
      await node.restoreSession({ ...session, tinycloudHosts: [host] });
      const lease = await node.createRenewalLease(new Date(Date.now() + 10 * 60_000));
      const result = await node.getDelegationStatus(lease.originalCid);
      const generic = node.invokeAny([{
        resource: `urn:cid:${session.delegationCid}`,
        service: "delegation",
        path: "status",
        action: "tinycloud.delegation/status",
      }]);

      if (!result.ok) throw new Error(result.error.message);
      expect(result.ok).toBe(true);
      expect(lease.originalCid).toBe(session.delegationCid);
      expect(statusRequests).toHaveLength(1);
      expect(statusRequests[0]?.cid).toBe(lease.originalCid);
      expect(statusRequests[0]?.url).toBe(`${host}/delegation/status`);
      expect(statusInvocationCalls).toEqual([{ cid: session.delegationCid, audience: nodeDid }]);

      const statusClaims = claims(statusRequests[0]!.authorization);
      const genericClaims = claims(authorizationValue(generic));
      expect(statusClaims.iss).toBe(session.verificationMethod.split("#")[0]);
      expect(statusClaims.att).toEqual(genericClaims.att);
      expect(statusClaims.att).toEqual({
        [`urn:cid:${session.delegationCid}`]: { "tinycloud.delegation/status": [{}] },
      });
      expect(statusClaims.prf).toEqual([]);
      expect(genericClaims.prf).toEqual([session.delegationCid]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
