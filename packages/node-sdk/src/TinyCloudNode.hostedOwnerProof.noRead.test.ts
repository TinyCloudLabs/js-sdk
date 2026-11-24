// TC-4082: a session that holds no uncaveated kv/list or space/info has no read a hosted-owner proof could make. That is
// not a node refusal. A restore of it sends nothing to the node and keeps its stored record; a sign-in with the same
// recap is refused before it is signed.
import { afterEach, describe, expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { signedRestorableSession } from "./test-support/signed-restorable-session";

const REGISTRY = "https://registry.hosted-owner-no-read.test";
const HOST = "https://node.hosted-owner-no-read.test";
const key = "35".repeat(32);
const signer = new PrivateKeySigner(key);
const address = await signer.getAddress();
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/** An owner the registry has no record of; any request that is not to the registry is recorded. */
function harness(permissions: Array<{ service: string; path: string; actions: string[] }>, storage = new MemorySessionStorage()) {
  const toNode: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.origin === REGISTRY) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    toNode.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({
    host: HOST, newUserHost: HOST, tinycloudFallbackHosts: [HOST], tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false,
    wasmBindings: new NodeWasmBindings(), sessionStorage: storage, requireExistingAccount: true, allowHostedOwnerProof: true,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, enablePublicSpace: false, signer,
    manifest: { app_id: "tc4082-no-read", name: "No read", defaults: false, includePublicSpace: false, permissions },
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  return { node, storage, toNode };
}

const kvOnly = [{ service: "tinycloud.kv", path: "notes/", actions: ["get"] }];

describe("a session that holds no list or space/info read", () => {
  test("restoring it makes no request to the node and keeps its stored record", async () => {
    const proof = await signedRestorableSession({
      privateKey: key,
      abilities: { kv: { "notes/": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
    });
    const { node, storage, toNode } = harness(kvOnly);
    await storage.save(proof.address, {
      address: proof.address, chainId: proof.chainId, sessionKey: JSON.stringify(proof.jwk),
      siwe: proof.siwe, signature: proof.signature, expiresAt: proof.expiresAt,
      createdAt: new Date().toISOString(), version: "1.0", tinycloudHosts: [HOST],
      tinycloudSession: {
        delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
        spaceId: proof.spaceId, verificationMethod: proof.verificationMethod,
      },
    });
    await node.restoreSession({ ...proof, tinycloudHosts: [HOST] });
    // The restore is a hosted-owner candidate (unregistered owner, own space) but holds nothing to read with.
    const routed = await node.kv.get("notes/a");
    expect(routed.ok).toBe(false);
    expect(toNode).toEqual([]);
    expect(storage.exists(address)).toBe(true);
    // Asked again, it still answers without a request and still keeps the record.
    expect((await node.kv.get("notes/a")).ok).toBe(false);
    expect(toNode).toEqual([]);
    expect(storage.exists(address)).toBe(true);
  });

  test("signing in with it is refused before anything is signed or sent to the node", async () => {
    const { node, storage, toNode } = harness(kvOnly);
    const failure = await node.signIn().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: unknown }).code).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(toNode).toEqual([]);
    expect(storage.exists(address)).toBe(false);
  });
});
