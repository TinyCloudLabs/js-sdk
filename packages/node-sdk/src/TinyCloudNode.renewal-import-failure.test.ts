import { expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { REGISTRY_NOT_FOUND_BODY, pkhDid } from "@tinycloud/sdk-core";
import { signedRestorableSession } from "./test-support/signed-restorable-session";
import { signedLocationRecordForTest } from "./test-support/restored-policy-node";
import { resolve } from "node:path";

const ISOLATED_CHILD = process.env.TC_2872_RENEWAL_IMPORT_FAILURE_CHILD === "1";

if (ISOLATED_CHILD) {
  mock.module("@tinycloud/sdk-core/delegations/renewal", () => {
    throw new Error("renewal verifier chunk unavailable");
  });

  test("refuses renewal restore when the lazy verifier import fails", async () => {
    const privateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const proof = await signedRestorableSession({ privateKey });
    const ownerDid = pkhDid(proof.address!, proof.chainId!);
    const nodeSeed = crypto.getRandomValues(new Uint8Array(32));
    const nodePublicKey = ed25519.getPublicKey(nodeSeed);
    const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...nodePublicKey]))}`;
    const renewerSeed = crypto.getRandomValues(new Uint8Array(32));
    const renewerPublicKey = ed25519.getPublicKey(renewerSeed);
    const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
    const host = "https://node.renewal-import-failure.test";
    const registry = "https://registry.renewal-import-failure.test";
    const record = await signedLocationRecordForTest({
      ownerDid,
      ownerPrivateKey: privateKey,
      host,
      nodeDid,
      spaces: [proof.spaceId],
      sequence: 1,
    });
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let statusRequests = 0;
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
        statusRequests++;
        return Response.json({});
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
      const lease = await owner.createOwnerDelegation({
        delegateDid: renewerDid,
        spaceId: proof.spaceId,
        expiresAt: new Date(originalExpiry + 4 * 60 * 60 * 1000),
        permissions: [{
          service: "tinycloud.delegation",
          path: `urn:cid:${proof.delegationCid}`,
          actions: ["tinycloud.delegation/renew"],
        }],
      });
      Date.now = () => originalExpiry + 60_000;

      const candidate = new TinyCloudNode({
        host,
        wasmBindings: new NodeWasmBindings(),
        tinycloudRegistryUrl: registry,
        autoDiscoverLocalNode: false,
      });
      await expect(candidate.restoreSessionWithRenewal(
        { ...proof, tinycloudHosts: [host] },
        lease.delegation.authHeader!,
      )).rejects.toThrow("renewal verifier chunk unavailable");
      expect(candidate.restorableSession).toBeUndefined();
      expect(statusRequests).toBe(0);
      console.log("RENEWAL_IMPORT_FAILURE_CONFIRMED");
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
} else {
  test("isolates the renewal verifier import-failure mock in a child process", () => {
    const child = Bun.spawnSync(
      [process.execPath, "test", "--max-concurrency=1", import.meta.path],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, TC_2872_RENEWAL_IMPORT_FAILURE_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    if (child.exitCode !== 0) {
      throw new Error(`isolated import-failure test exited ${child.exitCode}:\n${output}`);
    }
    expect(output).toContain("RENEWAL_IMPORT_FAILURE_CONFIRMED");
  });
}
