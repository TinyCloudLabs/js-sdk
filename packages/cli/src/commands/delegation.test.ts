import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { DelegationManager } from "@tinycloud/sdk-core/delegations";
import type { ServiceSession } from "@tinycloud/sdk-services";

let hasRevokeAuthority = false;
const authorityRequests: unknown[] = [];
const revokeCalls: unknown[][] = [];
const outputs: unknown[] = [];
const errors: unknown[] = [];
const targetSpaceId = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:archive";
const fallbackSpaceId = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:archive";
let revokeResult: unknown;
let delegationManagerOverride: any;
let grantHistory: any[];
let storedDelegations: any[];
let authorityError: (Error & { code: string }) | undefined;
let delegationQueryResult: any;
let readGrantHistoryCalls: number;
let historyReadError: Error | undefined;
const parsedAuthorizationCalls: unknown[][] = [];

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "owner", host: "https://node.example.test" }),
    getProfile: async () => ({
      name: "owner",
      host: "https://node.example.test",
      ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
      spaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default",
      authMethod: "local",
    }),
  },
}));
mock.module("../lib/permissions.js", () => ({
  readGrantHistory: async () => {
    readGrantHistoryCalls++;
    if (historyReadError) throw historyReadError;
    return grantHistory;
  },
  loadLocalGrantArtifacts: async () => storedDelegations.map(({ delegation }) => ({ delegationCid: delegation.cid, delegation })),
}));
mock.module("@tinycloud/sdk-core", () => ({
  parseSignedCompactUcanAttenuation: (...args: unknown[]) => {
    parsedAuthorizationCalls.push(args);
    return {
      payload: {
        att: { [`${targetSpaceId}/kv/target`]: { "tinycloud.kv/get": [] } },
      },
    };
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    const delegationManager = delegationManagerOverride ?? {
      query: async () => delegationQueryResult,
      revoke: async (...args: unknown[]) => {
        revokeCalls.push(args);
        return revokeResult ?? { ok: true, data: undefined };
      },
    };
    return {
      accountSpaceId: targetSpaceId,
      hasRuntimePermissions: (permissions: Array<{ actions: string[] }>) =>
        permissions[0]?.actions.includes("tinycloud.delegation/list") === true || hasRevokeAuthority,
      restorableSession: { jwk: { kty: "OKP", x: "active-session-key" } },
      computeDelegationCid: () => "bafy-device-grant",
      delegationManager,
      revokeDelegation: async (...args: unknown[]) => {
        revokeCalls.push(args);
        if (delegationManagerOverride) return await delegationManagerOverride.revoke(...args);
        return revokeResult ?? { ok: true, data: undefined };
      },
    };
  },
}));

mock.module("./auth.js", () => ({
  ensureDelegationAuthority: async (params: { requested: unknown[] }) => {
    authorityRequests.push(params);
    if (authorityError && (params.requested[0] as { space?: string }).space?.startsWith("urn:cid:")) {
      throw authorityError;
    }
    hasRevokeAuthority = true;
  },
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (value: unknown) => outputs.push(value),
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {},
  cliErrorFromService: (error: unknown) => error,
  handleError: (error: unknown) => errors.push(error),
}));

// Import after registering module mocks so this command exercises isolated CLI boundaries.
const { registerDelegationCommand } = await import("./delegation.js");

async function runRevoke(cid = "bafy-device-grant", yes = false): Promise<void> {
  const program = new Command();
  registerDelegationCommand(program);
  await program.parseAsync([
    "node", "tc", "delegation", "revoke", cid,
    ...(yes ? ["--yes"] : []),
  ], { from: "node" });
}

beforeEach(() => {
  delegationManagerOverride = undefined;
  hasRevokeAuthority = false;
  authorityRequests.length = 0;
  revokeCalls.length = 0;
  outputs.length = 0;
  revokeResult = undefined;
  errors.length = 0;
  readGrantHistoryCalls = 0;
  historyReadError = undefined;
  authorityError = undefined;
  parsedAuthorizationCalls.length = 0;
  storedDelegations = [];
  grantHistory = [{
    ts: "2026-01-01T00:00:00.000Z",
    profile: "owner",
    source: "cli",
    delegationCid: "bafy-device-grant",
    addedCaps: [{ service: "tinycloud.kv", space: fallbackSpaceId, path: "", actions: ["tinycloud.kv/get"] }],
  }];
  delegationQueryResult = {
    ok: true,
    data: {
      items: [{
        cid: "bafy-device-grant",
        delegatorDid: "did:pkh:eip155:1:0xowner",
        delegateDid: "did:key:device",
        resources: [{ resource: `${fallbackSpaceId}/kv/target/` }],
      }],
      nextCursor: undefined,
    },
  };
});

describe("tc delegation revoke authority", () => {
  test("requests only the target CID capability and acquires it for one command", async () => {
    await runRevoke();

    expect(authorityRequests).toHaveLength(1);
    expect(authorityRequests[0]).toMatchObject({
      requested: [{
        service: "tinycloud.delegation",
        space: "urn:cid:bafy-device-grant",
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }],
      reason: "Revoke delegation bafy-device-grant",
      yes: false,
      persist: false,
    });
    expect(revokeCalls).toEqual([["bafy-device-grant"]]);
    expect(outputs).toEqual([{
      cid: "bafy-device-grant",
      revoked: true,
      targetSpaceSource: "node",
      authorityScopeSource: "cid-resource",
      authorityScopeReason: "The revoke authority is scoped to the exact delegation CID.",
    }]);
    expect(errors).toEqual([]);
  });

  test("--yes is forwarded as explicit consent", async () => {
    await runRevoke("bafy-device-grant", true);

    expect(authorityRequests[0]).toMatchObject({ yes: true, persist: false });
    expect(revokeCalls).toEqual([["bafy-device-grant"]]);
    expect(errors).toEqual([]);
  });

  test("surfaces node query errors without reading local history", async () => {
    delegationQueryResult = { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } };
    await runRevoke();

    expect(readGrantHistoryCalls).toBe(0);
    expect(authorityRequests).toEqual([]);
    expect(revokeCalls).toEqual([]);
    expect(errors).toEqual([{ code: "NETWORK_ERROR", message: "offline" }]);
  });

  test("does not read corrupt history when the node has the target", async () => {
    historyReadError = new Error("corrupt history");
    hasRevokeAuthority = true;
    await runRevoke();

    expect(readGrantHistoryCalls).toBe(0);
    expect(revokeCalls).toEqual([["bafy-device-grant"]]);
    expect(errors).toEqual([]);
  });

  test("reads local grant history only after a successful empty node query", async () => {
    delegationQueryResult = { ok: true, data: { items: [], nextCursor: undefined } };
    await runRevoke();

    expect(readGrantHistoryCalls).toBe(1);
    expect(authorityRequests[0]).toMatchObject({
      requested: [{
        service: "tinycloud.delegation",
        space: "urn:cid:bafy-device-grant",
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }],
      persist: false,
    });
    expect(outputs).toEqual([{
      cid: "bafy-device-grant",
      revoked: true,
      targetSpaceSource: "local-grant-history",
      authorityScopeSource: "cid-resource",
      authorityScopeReason: "The revoke authority is scoped to the exact delegation CID.",
    }]);
  });
  test("falls back only to a matching owner-signed CID-bound space", async () => {
    authorityError = Object.assign(new Error("invalid ReCap resource URI urn:cid:bafy-device-grant"), {
      code: "RAW_RECAP_RESOURCE_UNSUPPORTED",
    });
    storedDelegations = [{
      delegation: {
        cid: "bafy-device-grant",
        delegationHeader: { Authorization: "signed-target" },
        spaceId: fallbackSpaceId,
        resources: [{ service: "kv", space: fallbackSpaceId, path: "forged/", actions: ["tinycloud.kv/get"] }],
      },
      permissions: [],
    }];

    await runRevoke();

    expect(authorityRequests.map((request) => (request as any).requested[0].space)).toEqual([
      "urn:cid:bafy-device-grant",
      "default",
    ]);
    expect(authorityRequests.every((request) => (request as any).persist === false)).toBe(true);
    expect(parsedAuthorizationCalls).toEqual([["signed-target", "bafy-device-grant"]]);
    expect(revokeCalls).toEqual([["bafy-device-grant", { targetSpaceId }]]);
    expect(outputs).toEqual([{
      cid: "bafy-device-grant",
      revoked: true,
      targetSpaceSource: "local-signed-grant-artifact",
      authorityScopeSource: "local-signed-grant-artifact",
      authorityScopeReason:
        "The WASM ReCap parser rejected urn:cid resources; the fallback space came from an owner-signed local grant whose Authorization recomputes to this CID.",
    }]);
    expect(errors).toEqual([]);
  });

  test("reports a target absent from node and local sources", async () => {
    delegationQueryResult = { ok: true, data: { items: [], nextCursor: undefined } };
    grantHistory = [];
    storedDelegations = [];
    await runRevoke();

    expect(readGrantHistoryCalls).toBe(1);
    expect(revokeCalls).toEqual([]);
    expect(String(errors[0])).toContain("TARGET_NOT_FOUND");
  });

  test("routes no-options SDK revoke through the CID resource", async () => {
    const targetCid = "bafy-device-grant";
    const requests: string[] = [];
    const signedOperations: Array<Array<{ resource?: string; spaceId?: string; action: string }>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path === "/delegation/query") {
          return Response.json({
            schemaVersion: 2,
            items: [{
              cid: targetCid,
              direction: "granted",
              delegatorDid: "did:key:owner-session",
              delegateDid: "did:key:device",
              resources: [{ resource: `${targetSpaceId}/kv/target/`, actions: ["tinycloud.kv/get"], caveats: [{}] }],
              parents: [],
              issuedAt: null,
              notBefore: null,
              expiresAt: null,
              status: "active",
            }],
          });
        }
        if (path === "/invoke") return Response.json([]);
        if (path === "/revoke") return Response.json({ revoked: true, cid: targetCid });
        return new Response("not found", { status: 404 });
      },
    });
    const manager = new DelegationManager({
      hosts: [`http://127.0.0.1:${server.port}`],
      session: { spaceId: targetSpaceId } as ServiceSession,
      invoke: () => ({ Authorization: "query" }),
      invokeAny: (_session, entries) => {
        signedOperations.push(entries.map((entry) => ({
          resource: entry.resource,
          spaceId: entry.spaceId,
          action: entry.action,
        })));
        return { Authorization: "signed" };
      },
    });
    delegationManagerOverride = manager;
    hasRevokeAuthority = true;

    try {
      await runRevoke(targetCid);
      expect(requests).toEqual(["POST /delegation/query", "POST /revoke"]);
      expect(signedOperations.at(-1)).toEqual([{
        resource: `urn:cid:${targetCid}`,
        spaceId: undefined,
        action: "tinycloud.delegation/revoke",
      }]);
      expect(revokeCalls).toEqual([[targetCid]]);
      expect(errors).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
