/**
 * TC-3731: a fresh TinyCloudNode given a manifest whose permission paths hold `{owner}`
 * signs in without a prior bind. The owner comes from the signer, the request the signer
 * approves names the resolved path, and the digest sent to OpenKey covers the template.
 */

import { afterEach, beforeEach, expect, mock, test, type Mock } from "bun:test";
import {
  CaveatedDelegationUnsupportedError,
  type IWasmBindings,
  type ISessionManager,
  type Manifest,
} from "@tinycloud/sdk-core";

import { canonicalOpenKeyManifestSha256Hex } from "./authorization/NodeUserAuthorization";
import { TinyCloudNode } from "./TinyCloudNode";
import { unregisteredLocationRegistryResponse } from "./test-support/unregistered-location-registry";

const REGISTRY_ORIGIN = "https://registry.manifest-owner-node.test";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const OWNER_DID = "did:pkh:eip155:1:0x1234567890AbcdEF1234567890aBcdef12345678";

function sessionManager(): ISessionManager {
  const keys = new Set<string>(["default"]);
  return {
    createSessionKey: (id) => (keys.add(id), id),
    replaceSessionKey: (_jwk, id) => (keys.add(id), id),
    renameSessionKeyId: (oldId, newId) => {
      keys.delete(oldId);
      keys.add(newId);
    },
    getDID: (id) => `did:key:z6MkTest-${id}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function fakeWasm() {
  const prepareSession = mock((params: Record<string, unknown>) => ({
    siwe: "fake-siwe",
    jwk: params.jwk,
    spaceId: params.spaceId,
    verificationMethod: "did:key:z6MkTestSession",
  }));
  const wasm = {
    invoke: mock(async () => ({})),
    invokeAny: mock(async () => ({})),
    prepareSession,
    completeSessionSetup: mock(() => ({ delegationHeader: { Authorization: "Bearer fixture" }, delegationCid: "bafyfake" })),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) => `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: mock(() => ({})),
    parseRecapFromSiwe: mock(() => []),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: sessionManager,
  } satisfies IWasmBindings;
  return { wasm, prepareSession };
}

function signerSpy() {
  const getAddress = mock(async () => ADDRESS);
  const getChainId = mock(async () => 1);
  return {
    signer: { getAddress, getChainId, signMessage: mock(async () => "0x" + "ff".repeat(65)) },
    reads: () => getAddress.mock.calls.length + getChainId.mock.calls.length,
  };
}

const template: Manifest = {
  app_id: "xyz.tinycloud.example.owner-node",
  name: "Owner node",
  defaults: false,
  permissions: [
    { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default", actions: ["tinycloud.encryption/decrypt"], skipPrefix: true },
  ],
};

let fetchMock: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const metadata = unregisteredLocationRegistryResponse(input, REGISTRY_ORIGIN, init);
    if (metadata) return metadata;
    throw new Error("network is closed in this test");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function nodeFor(manifest: Manifest, wasm: IWasmBindings, signer: ReturnType<typeof signerSpy>["signer"]) {
  return new TinyCloudNode({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    wasmBindings: wasm,
    signer,
    host: "https://tinycloud.test",
    autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false,
    manifest,
  });
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

test("signIn on a fresh node asks the signer to approve the resolved path", async () => {
  const { wasm, prepareSession } = fakeWasm();
  const { signer } = signerSpy();
  await rejection(() => nodeFor(template, wasm, signer).signIn());
  expect(prepareSession).toHaveBeenCalledTimes(1);
  const params = JSON.stringify(prepareSession.mock.calls[0]![0]);
  expect(params).toContain(`urn:tinycloud:encryption:${OWNER_DID}:default`);
  expect(params).not.toContain("{owner}");
});

test("signInWithOpenKey on a fresh node sends the template digest and the owner hint", async () => {
  const { wasm } = fakeWasm();
  const { signer } = signerSpy();
  let sent: { presentation?: { manifestDigest?: string; owner?: string } } | undefined;
  const stop = new Error("stop after the request");
  const error = await rejection(() =>
    nodeFor(template, wasm, signer).signInWithOpenKey(async (request) => {
      sent = request;
      throw stop;
    }),
  );
  expect(error).toBe(stop);
  expect(sent?.presentation?.manifestDigest).toBe(canonicalOpenKeyManifestSha256Hex(template));
  expect(sent?.presentation?.owner).toBe(OWNER_DID);
});

test("a caveated template is refused before any signer read", async () => {
  const { wasm, prepareSession } = fakeWasm();
  const { signer, reads } = signerSpy();
  const caveated: Manifest = {
    ...template,
    permissions: [{ ...template.permissions![0]!, caveats: [{ kind: "prefix", prefix: "notes/" }] }],
  };
  const error = await rejection(() => nodeFor(caveated, wasm, signer).signIn());
  expect(error).toBeInstanceOf(CaveatedDelegationUnsupportedError);
  expect(reads()).toBe(0);
  expect(prepareSession).not.toHaveBeenCalled();
});
