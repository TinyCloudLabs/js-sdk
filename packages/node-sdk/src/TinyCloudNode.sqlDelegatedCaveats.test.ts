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

describe("invocation capabilities for caveated grants", () => {
  interface InvocationSeams {
    wasmBindings: { invoke: ReturnType<typeof mock>; invokeAny: ReturnType<typeof mock> };
    runtimePermissionGrants: unknown[];
    invokeWithRuntimePermissions(
      session: unknown,
      service: string,
      path: string,
      action: string,
    ): unknown;
    invokeAnyWithRuntimePermissions(
      session: unknown,
      entries: Array<Record<string, unknown>>,
    ): unknown;
  }

  const PATH = "data.sqlite";
  const baseSession = { spaceId: SPACE_ID, delegationHeader: { Authorization: "base" } };

  /** A node holding one delegated grant of `service`/`action` on PATH with `caveats`. */
  function nodeHolding(service: string, action: string, caveats: Record<string, unknown>[]): InvocationSeams {
    const seams = makeNode(["sql", FEATURE]) as unknown as InvocationSeams;
    seams.runtimePermissionGrants = [{
      session: {
        delegationHeader: { Authorization: "grant" },
        delegationCid: "grant-cid",
        spaceId: SPACE_ID,
        verificationMethod: "did:key:default",
        jwk: { kty: "OKP" },
      },
      delegation: { cid: "grant-cid" },
      operations: [{ spaceId: SPACE_ID, service, path: PATH, action, caveats }],
      expiresAt: new Date(Date.now() + 60_000),
      provenance: "delegated",
    }];
    return seams;
  }

  /** What each invocation seam put on the capability, as a list of caveat lists (undefined = none). */
  function caveatsSent(seams: InvocationSeams, service: string, action: string): unknown[] {
    seams.invokeWithRuntimePermissions(baseSession, service, PATH, action);
    seams.invokeAnyWithRuntimePermissions(baseSession, [{ spaceId: SPACE_ID, service, path: PATH, action }]);
    const single = seams.wasmBindings.invoke.mock.calls.length > 0
      ? undefined
      : (seams.wasmBindings.invokeAny.mock.calls[0]?.[1] as Array<{ caveats?: unknown }>)[0]?.caveats;
    const multi = (seams.wasmBindings.invokeAny.mock.calls.at(-1)?.[1] as Array<{ caveats?: unknown }>)[0]?.caveats;
    return [single, multi];
  }

  const DROPPED: ReadonlyArray<readonly [string, Record<string, unknown>[]]> = [
    ["delegated form", [{ tables: ["Notes"], columns: ["id"], readOnly: true }]],
    ["readOnly only", [{ readOnly: true }]],
    ["tables: []", [{ tables: [] }]],
    ["empty-only [{},{}]", [{}, {}]],
  ];

  for (const [label, caveats] of DROPPED) {
    test(`sql grant with ${label}: no caveats on either invocation seam`, () => {
      const seams = nodeHolding("sql", "tinycloud.sql/read", caveats);
      const [single, multi] = caveatsSent(seams, "sql", "tinycloud.sql/read");
      expect(single).toBeUndefined();
      expect(multi).toBeUndefined();
      // The single-capability seam falls back to the plain binding, which has no caveat parameter.
      expect(seams.wasmBindings.invoke).toHaveBeenCalledTimes(1);
    });
  }

  test("a caller-supplied caveat equal to the grant's delegated form is dropped too", () => {
    const delegated = [{ tables: ["Notes"] }];
    const seams = nodeHolding("sql", "tinycloud.sql/read", delegated);
    seams.invokeAnyWithRuntimePermissions(baseSession, [
      { spaceId: SPACE_ID, service: "sql", path: PATH, action: "tinycloud.sql/read", caveats: delegated },
    ]);
    const entry = (seams.wasmBindings.invokeAny.mock.calls[0]?.[1] as Array<Record<string, unknown>>)[0]!;
    expect("caveats" in entry).toBe(false);
  });

  test("a constrained-statements profile is echoed exactly", () => {
    const seams = nodeHolding("sql", "tinycloud.sql/read", [profile]);
    const [single, multi] = caveatsSent(seams, "sql", "tinycloud.sql/read");
    expect(single).toEqual([profile]);
    expect(JSON.stringify(single)).toBe(JSON.stringify([profile]));
    expect(multi).toEqual([profile]);
    expect(JSON.stringify(multi)).toBe(JSON.stringify([profile]));
  });

  test("[{}] on a sql grant is echoed as before", () => {
    const seams = nodeHolding("sql", "tinycloud.sql/read", [{}]);
    const [single, multi] = caveatsSent(seams, "sql", "tinycloud.sql/read");
    expect(single).toEqual([{}]);
    expect(multi).toEqual([{}]);
  });

  test("other services keep their caveats, even in the delegated shape", () => {
    for (const caveats of [[{ kind: "prefix", value: "a/" }], [{ tables: ["Notes"] }], [{}, {}]]) {
      const seams = nodeHolding("kv", "tinycloud.kv/get", caveats);
      const [single, multi] = caveatsSent(seams, "kv", "tinycloud.kv/get");
      expect(single).toEqual(caveats);
      expect(multi).toEqual(caveats);
    }
  });

  test("the long service name is treated like the short one", () => {
    const seams = nodeHolding("sql", "tinycloud.sql/read", [{ tables: ["Notes"] }]);
    seams.invokeAnyWithRuntimePermissions(baseSession, [
      { spaceId: SPACE_ID, service: "tinycloud.sql", path: PATH, action: "tinycloud.sql/read" },
    ]);
    const entry = (seams.wasmBindings.invokeAny.mock.calls[0]?.[1] as Array<Record<string, unknown>>)[0]!;
    expect("caveats" in entry).toBe(false);
  });
});

describe("delegated SQL caveat gate on delegateTo, createDelegationViaWasmPath and useDelegation", () => {
  interface PrivateSeams {
    wasmBindings: { prepareSession: ReturnType<typeof mock> };
    createDelegationViaWasmPath(
      did: string,
      entries: PermissionEntry[],
      expirationTime: Date,
      session: unknown,
    ): Promise<unknown>;
    currentTinyCloudSession(): unknown;
  }

  const entry: PermissionEntry = {
    service: "tinycloud.sql",
    space: "default",
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    caveats: [{ tables: ["Notes"] }],
  };
  const emptyOnly: PermissionEntry = { ...entry, caveats: [{}, {}] };

  for (const [label, permission] of [["delegated form", entry], ["two empty entries", emptyOnly]] as const) {
    test(`delegateTo with ${label}: typed error, nothing signed or sent when the feature is absent`, async () => {
      const { calls } = spyFetch();
      for (const options of [undefined, { forceWalletSign: true }]) {
        const node = makeNode(["sql"]);
        await expect(node.delegateTo("did:key:other", [permission], options))
          .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
        expect((node as unknown as PrivateSeams).wasmBindings.prepareSession).not.toHaveBeenCalled();
      }
      expect(calls).toEqual([]);
    });

    test(`delegateTo with ${label}: features unknown is refused too`, async () => {
      const { calls } = spyFetch();
      await expect(makeNode(undefined).delegateTo("did:key:other", [permission]))
        .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
      expect(calls).toEqual([]);
    });

    test(`createDelegationViaWasmPath with ${label}: typed error when the feature is absent`, async () => {
      const { calls } = spyFetch();
      const node = makeNode(["sql"]) as unknown as PrivateSeams;
      await expect(
        node.createDelegationViaWasmPath("did:key:other", [permission], new Date(Date.now() + 60_000), node.currentTinyCloudSession()),
      ).rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
      expect(calls).toEqual([]);
    });
  }

  test("delegateTo and createDelegationViaWasmPath: with the feature the SDK's own caveated-mint refusal still applies, no request", async () => {
    const { calls } = spyFetch();
    const node = makeNode([FEATURE]);
    await expect(node.delegateTo("did:key:other", [entry], { forceWalletSign: true }))
      .rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    const seams = node as unknown as PrivateSeams;
    await expect(
      seams.createDelegationViaWasmPath("did:key:other", [entry], new Date(Date.now() + 60_000), seams.currentTinyCloudSession()),
    ).rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    expect(calls).toEqual([]);
  });

  test("useDelegation in wallet mode: refused before signing or any request when the feature is absent", async () => {
    const { calls } = spyFetch();
    const node = makeNode(["sql"]);
    await expect(node.useDelegation(sqlDelegation([{ tables: ["Notes"] }])))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    await expect(node.useDelegation(sqlDelegation([{}, {}])))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect((node as unknown as PrivateSeams).wasmBindings.prepareSession).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("useDelegation in wallet mode: the gate does not stop a caveat-free or profile delegation", async () => {
    for (const caveats of [undefined, [{}], [profile]]) {
      const { calls } = spyFetch();
      const result = await makeNode(["sql"]).useDelegation(sqlDelegation(caveats)).catch((caught: unknown) => caught);
      expect(result).not.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
      expect(calls).toEqual([`${HOST}/delegate`]);
    }
  });

  test("a flat caveat on a delegation that mixes kv and sql actions is checked against the sql action", async () => {
    const { calls } = spyFetch();
    const mixed = {
      ...sqlDelegation(undefined),
      actions: ["tinycloud.kv/get", "tinycloud.sql/read"],
      caveats: [{ tables: ["Notes"] }],
      resources: undefined,
    };
    await expect(makeNode(["sql"]).useRuntimeDelegation(mixed))
      .rejects.toBeInstanceOf(SqlDelegatedCaveatsUnsupportedError);
    expect(calls).toEqual([]);
  });
});
