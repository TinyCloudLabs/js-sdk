import { afterEach, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, ManifestValidationError, type Manifest } from "@tinycloud/sdk-core";
import { canonicalOpenKeyManifestSha256Hex, NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { unregisteredLocationRegistryResponse } from "../test-support/unregistered-location-registry";

const registry = "https://registry.manifest-owner.test";
const ownerA = new PrivateKeySigner("1".padStart(64, "0"));
const ownerB = new PrivateKeySigner("2".padStart(64, "0"));
let previousFetch: typeof fetch;
beforeEach(() => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const metadata = unregisteredLocationRegistryResponse(input, registry, init);
    if (metadata) return metadata;
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = previousFetch; });

// The template of the shared TC-3714 vector (the OpenKey side pins the same bytes and digest).
const template = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.example.vector",
  name: "Vector App",
  permissions: [
    { service: "tinycloud.kv", space: "applications", path: "/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default", actions: ["tinycloud.encryption/decrypt"], skipPrefix: true },
    { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default/share/", actions: ["tinycloud.encryption/decrypt"] },
  ],
} satisfies Manifest;
const TEMPLATE_DIGEST = "09c461675f972127f9ecf1b3eb59bbc911dcb0ab06c4b5633e9e9358af1f3ff6";

function authorizationFor(manifest: Manifest, signer: PrivateKeySigner) {
  return new NodeUserAuthorization({
    signer: { getAddress: () => signer.getAddress(), getChainId: async () => 1, signMessage: message => signer.signMessage(message) },
    wasmBindings: new NodeWasmBindings(), sessionStorage: new MemorySessionStorage(), requireExistingAccount: false,
    tinycloudRegistryUrl: registry, tinycloudHosts: ["https://tinycloud.test"],
    domain: "example.com", uri: "https://example.com", signStrategy: { type: "auto-sign" },
    manifest,
  });
}

async function prepare(manifest: Manifest, signer: PrivateKeySigner) {
  const auth = authorizationFor(manifest, signer);
  const identity = { address: await signer.getAddress(), chainId: 1, keyId: "k", keyType: "MANAGED" as const, requestId: "r" };
  return auth.prepareOpenKeySignIn(undefined, identity);
}

test("two owners send the same template digest and each request names its own owner", async () => {
  const a = await prepare(template, ownerA);
  const b = await prepare(template, ownerB);
  expect(a.request.presentation?.manifestDigest).toBe(TEMPLATE_DIGEST);
  expect(b.request.presentation?.manifestDigest).toBe(TEMPLATE_DIGEST);
  const ownerDidA = `did:pkh:eip155:1:${await ownerA.getAddress()}`;
  const ownerDidB = `did:pkh:eip155:1:${await ownerB.getAddress()}`;
  expect(a.request.presentation?.owner).toBe(ownerDidA);
  expect(b.request.presentation?.owner).toBe(ownerDidB);
  const resourcesA = Object.keys(extractRecapAttenuations(a.request.siwe));
  const resourcesB = Object.keys(extractRecapAttenuations(b.request.siwe));
  expect(resourcesA.some(r => r.includes(`urn:tinycloud:encryption:${ownerDidA}:default`))).toBe(true);
  expect(resourcesB.some(r => r.includes(`urn:tinycloud:encryption:${ownerDidB}:default`))).toBe(true);
  expect(resourcesA.some(r => r.includes("{owner}"))).toBe(false);
  expect(resourcesA.some(r => r.includes(ownerDidB))).toBe(false);
});

test("a manifest without the token sends the digest it always sent and no owner", async () => {
  const fixed: Manifest = { app_id: "xyz.tinycloud.example.fixed", name: "Fixed", permissions: [{ service: "tinycloud.kv", space: "applications", path: "/", actions: ["tinycloud.kv/get"] }] };
  const pending = await prepare(fixed, ownerA);
  expect(pending.request.presentation?.manifestDigest).toBe(canonicalOpenKeyManifestSha256Hex(fixed));
  expect(pending.request.presentation?.owner).toBeUndefined();
});

test("the token anywhere but a permission path stops the sign-in before OpenKey is asked", async () => {
  const inName: Manifest = { ...template, name: "{owner}" };
  await expect(prepare(inName, ownerA)).rejects.toBeInstanceOf(ManifestValidationError);
  const inKey = { ...template, "{owner}": "x" } as Manifest;
  await expect(prepare(inKey, ownerA)).rejects.toBeInstanceOf(ManifestValidationError);
  const inSpace: Manifest = { ...template, permissions: [{ ...template.permissions[0]!, space: "{owner}" }, ...template.permissions.slice(1)] };
  await expect(prepare(inSpace, ownerA)).rejects.toBeInstanceOf(ManifestValidationError);
});
