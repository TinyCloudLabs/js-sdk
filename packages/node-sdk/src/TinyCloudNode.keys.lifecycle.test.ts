import { expect, mock, test } from "bun:test";
import { makePkhSpaceId, pkhDid } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import { signedLocationRecordForTest, signedRegistryResponseForTest } from "./test-support/restored-policy-node";

const REGISTRY_ORIGIN = "https://registry.keys-lifecycle.test";

test("keys exposes only named-key operations and is safe to await", async () => {
  const node = new TinyCloudNode({ host: "https://one.example", wasmBindings: new NodeWasmBindings() });

  expect((node.keys as unknown as { then?: unknown }).then).toBeUndefined();
  expect(await node.keys).toBeDefined();
  expect((node.keys as unknown as Record<string, unknown>).unknown).toBeUndefined();
  for (const method of [
    "getPublicKey", "describeKey", "createKey", "blockKey", "unblockKey",
    "ensureKey", "encrypt", "decrypt", "decryptMany", "refreshNodeInfo",
  ]) {
    expect(typeof (node.keys as unknown as Record<string, unknown>)[method]).toBe("function");
  }
});

test("named-key calls use the restored host after sign-in", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  const proof = await signedRestorableSession();
  const ownerDid = pkhDid(proof.address, proof.chainId);
  const nodeDid = proof.verificationMethod.split("#", 1)[0]!;
  const route = (host: string, sequence: number) => signedLocationRecordForTest({
    ownerDid, ownerPrivateKey: PROOF_PRIVATE_KEY, host, nodeDid,
    spaces: [
      proof.spaceId,
      makePkhSpaceId(proof.address, proof.chainId, "secrets"),
      makePkhSpaceId(proof.address, proof.chainId, "public"),
    ],
    sequence,
  });
  let record = await route("https://one.example", 1);
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const metadata = signedRegistryResponseForTest(input, init, REGISTRY_ORIGIN, record);
    if (metadata) return metadata;
    if (url === "https://one.example/delegate" && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: [], skipped: [] }), { status: 200 });
    }
    if (url === "https://one.example/info" || url === "https://two.example/info") {
      return new Response(JSON.stringify({
        nodeId: nodeDid, features: ["encryption-named-keys-v1"],
      }), { status: 200 });
    }
    if (url === "https://one.example/.well-known/tinycloud/node-keys" ||
        url === "https://two.example/.well-known/tinycloud/node-keys") {
      return Response.json({ nodeDid });
    }
    if (url.startsWith("https://one.example/encryption/networks/") ||
        url.startsWith("https://two.example/encryption/networks/")) {
      return new Response("key_not_found: no such key", { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const node = new TinyCloudNode({
      tinycloudRegistryUrl: REGISTRY_ORIGIN,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
    });
    const auth = (node as any).auth;
    auth.tinycloudHosts = ["https://one.example"];
    auth.refreshNodeInfo = async () => { auth._nodeFeatures = ["encryption-named-keys-v1"]; };
    auth.ensureSpaceExists = async () => {};
    (node as any).scheduleAccountRegistrySync = () => {};
    (node as any).signRawNetworkAuthorization = mock(async () => ({
      authorization: "Bearer signed", invocationCid: "bafy-invocation",
    }));

    await node.signIn();
    await node.keys.describeKey("qa/test");
    expect(seen.some((url) => url.startsWith("https://one.example/encryption/networks/"))).toBe(true);

    record = await route("https://two.example", 2);
    await node.restoreSession({ ...proof, tinycloudHosts: ["https://two.example"] });
    seen.length = 0;
    await node.keys.describeKey("qa/test");
    expect(seen).toContain("https://two.example/info");
    expect(seen.some((url) => url.startsWith("https://two.example/encryption/networks/"))).toBe(true);
    expect(seen.some((url) => url.startsWith("https://one.example/"))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
