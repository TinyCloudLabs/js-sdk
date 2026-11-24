import { describe, expect, mock, test } from "bun:test";
import { SiweMessage } from "siwe";
import type { IWasmBindings, ISigner, ISessionManager } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

/*
 * Which installed runtime grants a permission check counts (`grantCids`), and signing a new grant for permissions an
 * installed grant already covers (`reuseExisting: false`). Two apps asking for the same permission each need a grant
 * of their own, so a check made for one app cannot be satisfied by the other's grant.
 */

const OWNER_KEY = "0x" + "11".repeat(32);
const LIST = [{ service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] }];

function siweFor(address: string): string {
  return new SiweMessage({
    domain: "tinycloud.test",
    address,
    statement: "Runtime grant.",
    uri: "did:key:z6MkRuntime",
    version: "1",
    chainId: 1,
    nonce: "32891756",
    issuedAt: "2026-05-05T00:00:00.000Z",
    expirationTime: "2999-01-01T00:00:00.000Z",
  }).prepareMessage();
}

async function setup() {
  const owner = new PrivateKeySigner(OWNER_KEY);
  const address = await owner.getAddress();
  const sessionManager: ISessionManager = {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
  let issued = 0;
  const wasm = {
    createSessionManager: () => sessionManager,
    prepareSession: mock((cfg: { jwk: object; spaceId: string }) => ({
      siwe: siweFor(address),
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:runtime",
    })),
    completeSessionSetup: mock((cfg: { jwk: object; spaceId: string; verificationMethod: string }) => {
      issued += 1;
      return {
        delegationHeader: { Authorization: `runtime-token-${issued}` },
        delegationCid: `runtime-cid-${issued}`,
        jwk: cfg.jwk,
        spaceId: cfg.spaceId,
        verificationMethod: cfg.verificationMethod,
      };
    }),
    ensureEip55: (value: string) => value,
    makeSpaceId: (a: string, chainId: number, name: string) => `tinycloud:pkh:eip155:${chainId}:${a}:${name}`,
  } as unknown as IWasmBindings;
  const providerSigner = { getAddress: async () => address, getChainId: async () => 1, signMessage: owner.signMessage.bind(owner) } satisfies ISigner;
  const node = new TinyCloudNode({ host: "https://tinycloud.test", signer: providerSigner, wasmBindings: wasm });
  (node as unknown as { auth: unknown }).auth = {
    resolveResourceDestinations: async () => [{ url: "https://tinycloud.test" }],
    tinyCloudSession: {
      address,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe: siweFor(address).replace("Runtime grant.", "Sign in."),
      spaceId: `tinycloud:pkh:eip155:1:${address}:applications`,
      verificationMethod: "did:key:default",
    },
  };
  return { node, owner };
}

async function withActivation<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ activated: ["runtime-cid-1", "runtime-cid-2"] }), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("runtime grants and the apps they were approved for", () => {
  test("a second request for permissions an installed grant covers reuses it unless reuseExisting is false", async () => {
    const { node, owner } = await setup();
    const signMessage = mock((siwe: string) => owner.signMessage(siwe));

    const first = await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage }));
    const reused = await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage }));
    expect(first.map((d) => d.cid)).toEqual(["runtime-cid-1"]);
    expect(reused.map((d) => d.cid)).toEqual(["runtime-cid-1"]);
    expect(signMessage).toHaveBeenCalledTimes(1);

    const fresh = await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage, reuseExisting: false }));
    expect(fresh.map((d) => d.cid)).toEqual(["runtime-cid-2"]);
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  test("a check narrowed to some grant cids counts only those grants", async () => {
    const { node, owner } = await setup();
    const signMessage = mock((siwe: string) => owner.signMessage(siwe));
    await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage }));
    await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage, reuseExisting: false }));

    expect(node.hasRuntimePermissions(LIST)).toBe(true);
    expect(node.hasRuntimePermissions(LIST, { grantCids: ["runtime-cid-1"] })).toBe(true);
    expect(node.hasRuntimePermissions(LIST, { grantCids: ["runtime-cid-2"] })).toBe(true);
    expect(node.hasRuntimePermissions(LIST, { grantCids: ["runtime-cid-3"] })).toBe(false);
    expect(node.hasRuntimePermissions(LIST, { grantCids: [] })).toBe(false);
    expect(node.getRuntimePermissionDelegations(LIST, { grantCids: ["runtime-cid-2"] }).map((d) => d.cid)).toEqual(["runtime-cid-2"]);
    expect(node.getRuntimePermissionDelegations(LIST, { grantCids: [] })).toEqual([]);
  });
});
