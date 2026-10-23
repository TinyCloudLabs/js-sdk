import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  CaveatedDelegationUnsupportedError,
  SqlDelegatedCaveatsUnsupportedError,
  type IWasmBindings,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import type { PortableDelegation } from "./delegation";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SPACE_ID = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const HOST = "https://tinycloud.test";
const FEATURE = "sql-delegated-caveats-v1";

const profile = {
  mode: "constrained-statements",
  readOnly: true,
  statements: [{ name: "get", sql: "SELECT 1", fixedParams: [] }],
};

function makeFakeWasmBindings(): IWasmBindings {
  const fake = {
    invoke: mock(() => ({})),
    invokeAny: mock(() => ({})),
    prepareSession: mock(() => ({ siwe: "siwe" })),
    completeSessionSetup: mock(() => ({ delegationHeader: { Authorization: "token" }, delegationCid: "cid" })),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock(() => {
      throw new Error("no delegation may be minted in this test");
    }),
    parseRecapFromSiwe: mock(() => []),
    protocolVersion: () => 1,
    createSessionManager: () => ({
      createSessionKey: (id: string) => id,
      replaceSessionKey: (_jwk: object, keyId: string) => keyId,
      renameSessionKeyId: () => {},
      getDID: (keyId: string) => `did:key:${keyId}`,
      jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
    }),
  };
  return fake as unknown as IWasmBindings;
}

/** `features: undefined` is a node whose features are not known. */
function makeNode(features: string[] | undefined): TinyCloudNode {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: HOST,
    signer: signer as never,
    wasmBindings: makeFakeWasmBindings(),
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
  Object.assign(node, {
    auth: {
      nodeFeatures: features ?? [],
      nodeFeaturesKnown: features !== undefined,
      tinyCloudSession: {
        address: ADDRESS,
        chainId: 1,
        delegationHeader: { Authorization: "base-token" },
        delegationCid: "base-cid",
        jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
        sessionKey: "default",
        siwe,
        spaceId: SPACE_ID,
        verificationMethod: "did:key:default",
      },
    },
  });
  return node;
}

function sqlDelegation(
  caveats: Record<string, unknown>[] | undefined,
  extra: Partial<PortableDelegation> = {},
): PortableDelegation {
  return {
    cid: "sql-cid",
    delegationHeader: { Authorization: "sql-token" },
    spaceId: SPACE_ID,
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    resources: [{
      service: "sql",
      space: SPACE_ID,
      path: "data.sqlite",
      actions: ["tinycloud.sql/read"],
      ...(caveats === undefined ? {} : { caveats }),
    }],
    expiry: new Date(Date.now() + 60_000),
    delegateDID: "did:key:default",
    ownerAddress: ADDRESS,
    chainId: 1,
    ...extra,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function spyFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ activated: ["sql-cid"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("TinyCloudNode.supportsSqlDelegatedCaveats", () => {
  test("true only when the node announced the feature", () => {
    expect(makeNode([FEATURE, "sql"]).supportsSqlDelegatedCaveats).toBe(true);
    expect(makeNode(["sql"]).supportsSqlDelegatedCaveats).toBe(false);
    expect(makeNode([]).supportsSqlDelegatedCaveats).toBe(false);
  });

  test("false when the node's features are not known (fail closed)", () => {
    expect(makeNode(undefined).supportsSqlDelegatedCaveats).toBe(false);
  });
});

describe("delegated SQL caveat gate on useRuntimeDelegation", () => {
  const delegated: Record<string, unknown>[] = [{ tables: ["Notes"], readOnly: true }];

  test("feature absent: refused with a typed error and no request", async () => {
    const { calls } = spyFetch();
    const node = makeNode(["sql"]);
    const error = await node.useRuntimeDelegation(sqlDelegation(delegated)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect((error as SqlDelegatedCaveatsUnsupportedError).code).toBe("SQL_DELEGATED_CAVEATS_UNSUPPORTED");
    expect((error as Error).message).not.toContain("Notes");
    expect(calls).toEqual([]);
  });

  test("features unknown: refused with no request", async () => {
    const { calls } = spyFetch();
    await expect(makeNode(undefined).useRuntimeDelegation(sqlDelegation(delegated)))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("feature present: the delegation is sent", async () => {
    const { calls } = spyFetch();
    await makeNode([FEATURE]).useRuntimeDelegation(sqlDelegation(delegated));
    expect(calls).toEqual([`${HOST}/delegate`]);
  });

  test("feature present on this node but the delegation targets another host: refused, no request", async () => {
    const { calls } = spyFetch();
    await expect(
      makeNode([FEATURE]).useRuntimeDelegation(sqlDelegation(delegated, { host: "https://other.test" })),
    ).rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("the same host with a trailing slash is the same node", async () => {
    const { calls } = spyFetch();
    await makeNode([FEATURE]).useRuntimeDelegation(sqlDelegation(delegated, { host: `${HOST}/` }));
    expect(calls).toHaveLength(1);
  });

  test("an empty-only list of two entries needs the feature too", async () => {
    const { calls } = spyFetch();
    await expect(makeNode(["sql"]).useRuntimeDelegation(sqlDelegation([{}, {}])))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("a delegated caveat on the top-level caveats is gated too", async () => {
    const { calls } = spyFetch();
    const delegation = { ...sqlDelegation(undefined), caveats: delegated };
    await expect(makeNode(["sql"]).useRuntimeDelegation(delegation))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("no caveats, [] and [{}] are sent to a node without the feature", async () => {
    for (const caveats of [undefined, [], [{}]]) {
      const { calls } = spyFetch();
      await makeNode(["sql"]).useRuntimeDelegation(sqlDelegation(caveats));
      expect(calls).toEqual([`${HOST}/delegate`]);
    }
  });

  test("a constrained-statements profile is not gated", async () => {
    const { calls } = spyFetch();
    await makeNode(["sql"]).useRuntimeDelegation(sqlDelegation([profile]));
    expect(calls).toEqual([`${HOST}/delegate`]);
  });

  test("a delegated caveat on another service is not this gate", async () => {
    const { calls } = spyFetch();
    const delegation = sqlDelegation(undefined);
    delegation.resources = [{
      service: "kv",
      space: SPACE_ID,
      path: "a/",
      actions: ["tinycloud.kv/get"],
      caveats: [{ tables: ["Notes"] }],
    }];
    delegation.actions = ["tinycloud.kv/get"];
    await makeNode(["sql"]).useRuntimeDelegation(delegation);
    expect(calls).toEqual([`${HOST}/delegate`]);
  });
});

describe("delegated SQL caveat gate on minting paths", () => {
  const entry: PermissionEntry = {
    service: "tinycloud.sql",
    space: "default",
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    caveats: [{ tables: ["Notes"] }],
  };

  test("grantRuntimePermissions: feature absent gives the typed error, no request", async () => {
    const { calls } = spyFetch();
    await expect(makeNode(["sql"]).grantRuntimePermissions([entry]))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("grantRuntimePermissions: feature present still refuses a caveated mint, no request", async () => {
    const { calls } = spyFetch();
    await expect(makeNode([FEATURE]).grantRuntimePermissions([entry]))
      .rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("createSubDelegation: a delegated caveat on the parent is gated before any request", async () => {
    const { calls } = spyFetch();
    const node = makeNode(["sql"]);
    await expect(
      node.createSubDelegation(sqlDelegation([{ readOnly: true }]), {
        path: "data.sqlite",
        actions: ["tinycloud.sql/read"],
        delegateDID: "did:key:other",
      }),
    ).rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });
});
