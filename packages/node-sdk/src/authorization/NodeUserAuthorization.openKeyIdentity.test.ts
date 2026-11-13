import { afterEach, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { unregisteredLocationRegistryResponse } from "../test-support/unregistered-location-registry";

const registry = "https://registry.openkey-identity.test";
const owner = new PrivateKeySigner("1".padStart(64, "0"));
let previousFetch: typeof fetch;
beforeEach(() => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const metadata = unregisteredLocationRegistryResponse(input, registry, init);
    if (metadata) return metadata;
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") return Response.json({ activated: ["space"], skipped: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = previousFetch; });

async function fixture() {
  let accountReads = 0;
  const auth = new NodeUserAuthorization({
    signer: {
      getAddress: async () => { accountReads++; throw new Error("Unexpected reconnect"); },
      getChainId: async () => { accountReads++; throw new Error("Unexpected chain re-read"); },
      signMessage: message => owner.signMessage(message),
    },
    wasmBindings: new NodeWasmBindings(), sessionStorage: new MemorySessionStorage(),
    tinycloudRegistryUrl: registry, tinycloudHosts: ["https://tinycloud.test"],
    domain: "example.com", uri: "https://example.com", signStrategy: { type: "auto-sign" },
    defaultActions: { kv: { "notes/": ["tinycloud.kv/get"] } },
  });
  const identity = { address: await owner.getAddress(), chainId: 1, keyId: "server-selected-key",
    keyType: "MANAGED" as const, requestId: "request" };
  const pending = await auth.prepareOpenKeySignIn(undefined, identity);
  return { auth, pending, reads: () => accountReads };
}

async function signedResult(siwe: string, signer = owner) {
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, abilities] of Object.entries(extractRecapAttenuations(siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(abilities)) {
      const service = ability.split("/")[0]!;
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, actions] of grouped) permissions.push({ service, space, path, actions });
  }
  return { protocolVersion: 1 as const, address: await owner.getAddress(),
    signature: await signer.signMessage(siwe), signedMessage: siwe, selectedActionKeys, permissions };
}

test("pinned identity prepares, verifies and completes without reading a mutable signer", async () => {
  const { auth, pending, reads } = await fixture();
  const result = await signedResult(pending.request.siwe);
  expect(pending.request.keyId).toBe("server-selected-key");
  expect(pending.request.siwe).toContain(`URI: ${pending.prepared.verificationMethod}`);
  await auth.verifyPreparedOpenKeySignIn(pending, result, "https://example.com");
  expect(auth.tinyCloudSession).toBeUndefined();
  await auth.completeOpenKeySignIn(pending, Promise.resolve(result));
  expect(auth.tinyCloudSession?.address).toBe(await owner.getAddress());
  expect(reads()).toBe(0);
});

for (const [field, change] of Object.entries({
  nonce: (s: string) => s.replace(/^Nonce: .+$/m, "Nonce: anothernonce"),
  chain: (s: string) => s.replace("Chain ID: 1", "Chain ID: 2"),
  address: (s: string) => s.replace(/^0x[0-9a-fA-F]{40}$/m, "0x2222222222222222222222222222222222222222"),
  uri: (s: string) => s.replace(/^URI: .+$/m, "URI: did:key:another"),
  uppercaseDID: (s: string) => s.replace("URI: did:", "URI: DID:"),
  domain: (s: string) => s.replace("example.com wants", "other.example wants"),
})) {
  test(`the real verifier refuses signed ${field} substitution before activation`, async () => {
    const { auth, pending } = await fixture();
    await expect(auth.verifyPreparedOpenKeySignIn(pending, await signedResult(change(pending.request.siwe)), "https://example.com")).rejects.toThrow();
    expect(auth.tinyCloudSession).toBeUndefined();
  });
}

test("the real verifier refuses another key's signature despite the claimed pinned address", async () => {
  const { auth, pending } = await fixture();
  await expect(auth.verifyPreparedOpenKeySignIn(pending,
    await signedResult(pending.request.siwe, new PrivateKeySigner("2".padStart(64, "0"))), "https://example.com")).rejects.toThrow();
});

test("the DID session URI must match the request's public session JWK", async () => {
  const { auth, pending } = await fixture();
  pending.request.jwk.x = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  await expect(auth.verifyPreparedOpenKeySignIn(pending, await signedResult(pending.request.siwe), "https://example.com")).rejects.toThrow("JWK changed");
});

test("the real verifier refuses a correctly signed capability superset", async () => {
  const { auth, pending } = await fixture();
  const att = extractRecapAttenuations(pending.request.siwe);
  const resource = Object.keys(att).find(key => Object.keys(att[key]!).includes("tinycloud.kv/get"))!;
  expect(resource).toBeDefined();
  const unrequested = resource.replace(/0x[0-9a-fA-F]{40}/, "0x2222222222222222222222222222222222222222");
  expect(att[unrequested]).toBeUndefined();
  att[unrequested] = { "tinycloud.kv/get": [{}] };
  const recap = Buffer.from(JSON.stringify({ att })).toString("base64url");
  const changed = pending.request.siwe.replace(/urn:recap:[A-Za-z0-9_-]+/, `urn:recap:${recap}`);
  await expect(auth.verifyPreparedOpenKeySignIn(pending, await signedResult(changed), "https://example.com")).rejects.toThrow();
});
