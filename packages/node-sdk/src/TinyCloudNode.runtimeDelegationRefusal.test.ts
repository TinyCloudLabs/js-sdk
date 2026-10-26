/*
 * `useRuntimeDelegation` refuses a delegation that is expired or issued to another session key, before anything is sent
 * to the host, and reports a failed activation in a way callers can tell apart: a host that answers with a status keeps
 * it on `cause.status`; a host that cannot be reached carries `code: "ACTIVATION_TRANSPORT_FAILED"`. The web panel
 * keeps a stored grant on the second and removes it on the first.
 */
import { describe, expect, mock, test } from "bun:test";

import {
  SessionExpiredError,
  type ISessionManager,
  type IWasmBindings,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import type { PortableDelegation } from "./delegation";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const APPLICATIONS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;

function makeStubSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeStubWasmBindings(): IWasmBindings {
  return {
    invoke: mock(() => ({})) as never,
    invokeAny: mock(() => ({})) as never,
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) => `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock(() => ({})) as never,
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
    createSessionManager: makeStubSessionManager,
    computeCid: () => "bafy-test",
  };
}

function makeNode(): TinyCloudNode {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as never,
    wasmBindings: makeStubWasmBindings(),
  });
  const siwe = `tinycloud.test wants you to sign in with your Ethereum account:
${ADDRESS}

Sign in.

URI: https://tinycloud.test
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2026-05-05T00:00:00.000Z
Expiration Time: 2999-01-01T00:00:00.000Z`;
  Reflect.set(node, "auth", {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe,
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
      verificationMethod: "did:key:default",
    },
  });
  return node;
}

function delegation(over: Partial<PortableDelegation> = {}): PortableDelegation {
  return {
    cid: "runtime-cid",
    delegationHeader: { Authorization: "runtime-token" },
    spaceId: APPLICATIONS,
    path: "",
    actions: ["tinycloud.delegation/list"],
    resources: [{ service: "delegation", space: APPLICATIONS, path: "", actions: ["tinycloud.delegation/list"] }],
    expiry: new Date(Date.now() + 60_000),
    delegateDID: "did:key:default",
    ownerAddress: ADDRESS,
    chainId: 1,
    ...over,
  } as PortableDelegation;
}

async function withFetch(impl: () => Promise<Response>, fn: (calls: () => number) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const stub = mock(impl);
  globalThis.fetch = stub as never;
  try {
    await fn(() => stub.mock.calls.length);
  } finally {
    globalThis.fetch = original;
  }
}

const ok = () => Promise.resolve(new Response(JSON.stringify({ activated: ["runtime-cid"] }), { status: 200 }));

describe("TinyCloudNode.useRuntimeDelegation refusals", () => {
  test("a delegation issued to another session key is refused before anything is sent", async () => {
    const node = makeNode();
    await withFetch(ok, async (calls) => {
      await expect(node.useRuntimeDelegation(delegation({ delegateDID: "did:key:someone-else" }))).rejects.toThrow(
        /targets did:key:someone-else but this session key is did:key:default/,
      );
      expect(calls()).toBe(0);
    });
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });

  test("an expired delegation is refused before anything is sent", async () => {
    const node = makeNode();
    await withFetch(ok, async (calls) => {
      await expect(node.useRuntimeDelegation(delegation({ expiry: new Date(Date.now() - 1_000) }))).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
      expect(calls()).toBe(0);
    });
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });

  test("a delegation for this session key is activated and installed", async () => {
    const node = makeNode();
    await withFetch(ok, async (calls) => {
      await node.useRuntimeDelegation(delegation());
      expect(calls()).toBe(1);
    });
    expect(node.getRuntimePermissionDelegations().map((d) => d.cid)).toEqual(["runtime-cid"]);
  });

  test("a host that answers with a status keeps it on the error's cause", async () => {
    const node = makeNode();
    await withFetch(
      () => Promise.resolve(new Response("not allowed", { status: 403 })),
      async () => {
        const error = await node.useRuntimeDelegation(delegation()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: expect.stringContaining("Failed to activate runtime permission delegation"),
          cause: { status: 403 },
        });
        expect(error).not.toHaveProperty("code");
      },
    );
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });

  test("a host that cannot be reached is a transport failure", async () => {
    const node = makeNode();
    await withFetch(
      () => Promise.reject(new TypeError("Failed to fetch")),
      async () => {
        const error = await node.useRuntimeDelegation(delegation()).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "ACTIVATION_TRANSPORT_FAILED" });
      },
    );
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });
});
