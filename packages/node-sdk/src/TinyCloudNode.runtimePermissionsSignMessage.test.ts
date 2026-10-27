import { describe, expect, mock, test } from "bun:test";
import { SiweMessage } from "siwe";
import type { IWasmBindings, ISigner, ISessionManager } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

/*
 * A session whose wallet provider cannot sign (an OpenKey session) grants a runtime permission by signing the prepared
 * SIWE through `options.signMessage`. The connected signer is never asked to sign.
 */

const OWNER_KEY = "0x" + "11".repeat(32);
const OTHER_KEY = "0x" + "22".repeat(32);
const LIST = [{ service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] }];

function unsupported(): Error {
  return Object.assign(new Error("Unsupported wallet method: personal_sign"), { name: "UnsupportedMethodError" });
}

async function setup() {
  const owner = new PrivateKeySigner(OWNER_KEY);
  const address = await owner.getAddress();
  const spaceId = `tinycloud:pkh:eip155:1:${address}:applications`;
  const prepared = new SiweMessage({
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
  const providerSign = mock(async (): Promise<string> => {
    throw unsupported();
  });
  const sessionManager: ISessionManager = {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
  // Only the bindings the grant path calls; the rest of the interface is not reached.
  const wasm = {
    createSessionManager: () => sessionManager,
    prepareSession: mock((cfg: { jwk: object; spaceId: string }) => ({ siwe: prepared, jwk: cfg.jwk, spaceId: cfg.spaceId, verificationMethod: "did:key:runtime" })),
    completeSessionSetup: mock((cfg: { jwk: object; spaceId: string; verificationMethod: string }) => ({
      delegationHeader: { Authorization: "runtime-token" },
      delegationCid: "runtime-cid",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: cfg.verificationMethod,
    })),
    ensureEip55: (value: string) => value,
    makeSpaceId: (a: string, chainId: number, name: string) => `tinycloud:pkh:eip155:${chainId}:${a}:${name}`,
  } as unknown as IWasmBindings;
  const providerSigner = { getAddress: async () => address, getChainId: async () => 1, signMessage: providerSign } satisfies ISigner;
  const node = new TinyCloudNode({ host: "https://tinycloud.test", signer: providerSigner, wasmBindings: wasm });
  // The signed-in session the grant is made for, installed directly because sign-in is not under test.
  const internals = node as unknown as { auth: unknown };
  internals.auth = {
    tinyCloudSession: {
      address,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe: prepared.replace("Runtime grant.", "Sign in."),
      spaceId,
      verificationMethod: "did:key:default",
    },
  };
  return { node, owner, prepared, providerSign, wasm };
}

async function withActivation<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ activated: ["runtime-cid"] }), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("grantRuntimePermissions with a caller-supplied message signer", () => {
  test("the connected signer's signMessage throwing UnsupportedMethodError fails without a message signer", async () => {
    const { node } = await setup();
    await expect(withActivation(() => node.grantRuntimePermissions(LIST))).rejects.toMatchObject({ name: "UnsupportedMethodError" });
  });

  test("signs through options.signMessage and never calls the connected signer", async () => {
    const { node, owner, prepared, providerSign } = await setup();
    const signMessage = mock((siwe: string) => owner.signMessage(siwe));

    const delegations = await withActivation(() => node.grantRuntimePermissions(LIST, { signMessage }));

    expect(signMessage).toHaveBeenCalledWith(prepared);
    expect(providerSign).not.toHaveBeenCalled();
    expect(delegations.map((d) => d.cid)).toEqual(["runtime-cid"]);
    expect(node.hasRuntimePermissions(LIST)).toBe(true);
  });

  test("a signature from another key is refused before the grant is stored or activated", async () => {
    const { node, wasm } = await setup();
    const other = new PrivateKeySigner(OTHER_KEY);
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await expect(node.grantRuntimePermissions(LIST, { signMessage: (siwe) => other.signMessage(siwe) })).rejects.toThrow(
        "does not match the account",
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(wasm.completeSessionSetup).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(node.hasRuntimePermissions(LIST)).toBe(false);
  });
});
