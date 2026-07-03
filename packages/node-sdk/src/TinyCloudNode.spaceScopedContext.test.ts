import { describe, expect, mock, test } from "bun:test";

import {
  ServiceContext,
  type ISessionManager,
  type IWasmBindings,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

// Regression coverage for the account-index bootstrap fix: the space-scoped
// contexts built by `sqlForSpace`, `kvForSpace` (and `createSpaceScopedKVService`)
// must carry `invokeAny`, otherwise any space-scoped multi-ability SQL/KV op
// (e.g. the `CREATE TABLE` + `INSERT` migrations batch that
// `account.index.ensure()` runs against the space-scoped `account` DB) throws
// "does not support multi-resource invocations" client-side before any network
// call. See docs/specs/web-sdk-account-index-bootstrap-plan.md.

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const HOST = "https://tinycloud.test";
const PRIMARY_SPACE_ID = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const OTHER_SPACE_ID = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeFakeWasmBindings(
  invoke: IWasmBindings["invoke"],
): IWasmBindings {
  return {
    invoke,
    invokeAny: mock(() => ({})) as any,
    prepareSession: mock((cfg: any) => ({
      siwe: "runtime-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:runtime",
    })),
    completeSessionSetup: mock((cfg: any) => ({
      delegationHeader: { Authorization: "runtime-token" },
      delegationCid: "runtime-cid",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: cfg.verificationMethod,
    })),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock(() => ({
      delegation: "child-runtime-token",
      cid: "child-runtime-cid",
      delegateDid: "did:key:default",
      expiry: 0,
      resources: [],
    })),
    parseRecapFromSiwe: mock(() => []),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(),
      privateKey: new Uint8Array(),
    })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: makeFakeSessionManager,
  };
}

/**
 * Construct a TinyCloudNode and simulate a signed-in state by installing a
 * primary `_serviceContext` with a session — the exact preconditions
 * `sqlForSpace`/`kvForSpace` guard on. The space-scoped contexts those methods
 * build clone from this primary context but must additionally wire `invokeAny`
 * from the node's own `invokeAnyWithRuntimePermissions` class field.
 */
function makeSignedInNode(
  bindings: IWasmBindings,
): TinyCloudNode {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: HOST,
    signer: signer as any,
    wasmBindings: bindings,
  });

  const primaryContext = new ServiceContext({
    invoke: bindings.invoke,
    // The real primary context wires invokeAny; the space-scoped clones must
    // wire it too (that is what this test asserts). It is intentionally set
    // here so the clone path never silently reads it back from the parent.
    invokeAny: (node as any).invokeAnyWithRuntimePermissions,
    fetch: globalThis.fetch.bind(globalThis),
    hosts: [HOST],
  });
  primaryContext.setSession({
    delegationHeader: { Authorization: "base-token" },
    delegationCid: "base-cid",
    spaceId: PRIMARY_SPACE_ID,
    verificationMethod: "did:key:default",
    jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
  });
  (node as any)._serviceContext = primaryContext;
  return node;
}

describe("TinyCloudNode space-scoped context invokeAny wiring", () => {
  test("sqlForSpace builds a context that exposes a defined invokeAny", () => {
    const invoke = mock(() => ({ Authorization: "base-token" })) as any;
    const bindings = makeFakeWasmBindings(invoke);
    const node = makeSignedInNode(bindings);

    const sql = node.sqlForSpace(OTHER_SPACE_ID);
    const context = (sql as any).context;

    expect(context.invokeAny).toBeDefined();
    expect(typeof context.invokeAny).toBe("function");
    // The session's spaceId is overridden to the requested space.
    expect(context.session.spaceId).toBe(OTHER_SPACE_ID);
  });

  test("kvForSpace builds a context that exposes a defined invokeAny", () => {
    const invoke = mock(() => ({ Authorization: "base-token" })) as any;
    const bindings = makeFakeWasmBindings(invoke);
    const node = makeSignedInNode(bindings);

    const kv = node.kvForSpace(OTHER_SPACE_ID);
    const context = (kv as any).context;

    expect(context.invokeAny).toBeDefined();
    expect(typeof context.invokeAny).toBe("function");
    expect(context.session.spaceId).toBe(OTHER_SPACE_ID);
  });

  test("sqlForSpace invokeAny routes a multi-ability batch to the WASM binding", () => {
    // A non-no-op assertion: the wired invokeAny is the node's
    // invokeAnyWithRuntimePermissions, which (absent any runtime grant) forwards
    // straight to wasmBindings.invokeAny. A migration-style CREATE TABLE +
    // INSERT batch resolves to two abilities (sql/schema + sql/write) and must
    // reach the binding rather than throwing "multi-resource invocations".
    const invoke = mock(() => ({ Authorization: "base-token" })) as any;
    const bindings = makeFakeWasmBindings(invoke);
    const node = makeSignedInNode(bindings);

    const sql = node.sqlForSpace(OTHER_SPACE_ID);
    const context = (sql as any).context;

    context.invokeAny(
      context.session,
      [
        {
          spaceId: OTHER_SPACE_ID,
          service: "sql",
          path: "account",
          action: "tinycloud.sql/schema",
        },
        {
          spaceId: OTHER_SPACE_ID,
          service: "sql",
          path: "account",
          action: "tinycloud.sql/write",
        },
      ],
      [{}, {}],
    );

    expect(bindings.invokeAny as any).toHaveBeenCalledTimes(1);
  });
});
