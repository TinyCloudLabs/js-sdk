import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

let hasRevokeAuthority = false;
const authorityRequests: unknown[] = [];
const revokeCalls: unknown[][] = [];
const outputs: unknown[] = [];
const errors: unknown[] = [];
const targetSpaceId = "tinycloud:pkh:eip155:1:0xtarget:archive";
const fallbackSpaceId = "tinycloud:pkh:eip155:1:0xhistory:archive";
let revokeResult: unknown;
let grantHistory: any[];
let delegationListResult: any;
let delegationQueryResult: any;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "owner", host: "https://node.example.test" }),
    getProfile: async () => ({
      name: "owner",
      host: "https://node.example.test",
      spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
      authMethod: "local",
    }),
  },
}));
mock.module("../lib/permissions.js", () => ({
  readGrantHistory: async () => grantHistory,
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => ({
    hasRuntimePermissions: () => hasRevokeAuthority,
    delegationManager: {
      list: async () => delegationListResult,
      query: async () => delegationQueryResult,
      revoke: async (...args: unknown[]) => {
        revokeCalls.push(args);
        return revokeResult ?? { ok: true, data: undefined };
      },
    },
  }),
}));

mock.module("./auth.js", () => ({
  ensureDelegationAuthority: async (params: { requested: unknown[] }) => {
    authorityRequests.push(params);
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

async function runRevoke(cid = "bafy-device-grant"): Promise<void> {
  const program = new Command();
  registerDelegationCommand(program);
  await program.parseAsync(["node", "tc", "delegation", "revoke", cid], { from: "node" });
}
beforeEach(() => {
  hasRevokeAuthority = false;
  authorityRequests.length = 0;
  revokeCalls.length = 0;
  outputs.length = 0;
  revokeResult = undefined;
  errors.length = 0;
  grantHistory = [{
    ts: "2026-01-01T00:00:00.000Z",
    profile: "owner",
    source: "cli",
    delegationCid: "bafy-device-grant",
    addedCaps: [{ service: "tinycloud.kv", space: fallbackSpaceId, path: "", actions: ["tinycloud.kv/get"] }],
  }];
  delegationListResult = { ok: false, error: { code: "NETWORK_ERROR", message: "legacy list unavailable" } };
  delegationQueryResult = {
    ok: true,
    data: {
      items: [{
        cid: "bafy-device-grant",
        delegatorDid: "did:pkh:eip155:1:0xowner",
        delegateDid: "did:key:device",
        resources: [{ resource: `${targetSpaceId}/kv/target/` }],
      }],
    },
  };
});

describe("tc delegation revoke authority", () => {
  test("acquires only revoke authority before revoking when the session lacks it", async () => {
    await runRevoke();

    expect(authorityRequests).toHaveLength(1);
    expect(authorityRequests[0]).toMatchObject({
      ctx: { profile: "owner", host: "https://node.example.test" },
      requested: [{
        service: "tinycloud.delegation",
        space: targetSpaceId,
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }],
      reason: "Revoke delegation bafy-device-grant",
      yes: true,
    });
    expect(revokeCalls).toEqual([["bafy-device-grant", {
      targetSpaceId,
      targetDelegation: { delegatorDID: "did:pkh:eip155:1:0xowner", delegateDID: "did:key:device" },
    }]]);
    expect(outputs).toEqual([{ cid: "bafy-device-grant", revoked: true, targetSpaceSource: "node" }]);
    expect(errors).toEqual([]);
  });

  test("keeps using existing revoke authority without acquiring more", async () => {
    hasRevokeAuthority = true;

    await runRevoke();

    expect(authorityRequests).toEqual([]);
    expect(revokeCalls).toEqual([["bafy-device-grant", {
      targetSpaceId,
      targetDelegation: { delegatorDID: "did:pkh:eip155:1:0xowner", delegateDID: "did:key:device" },
    }]]);
    expect(outputs).toEqual([{ cid: "bafy-device-grant", revoked: true, targetSpaceSource: "node" }]);
    expect(errors).toEqual([]);
  });

  test("does not print revoked when the node rejects the target", async () => {
    hasRevokeAuthority = true;
    const failure = {
      ok: false,
      error: { code: "REVOCATION_FAILED", message: "403 - Unauthorized Revoker", status: 403 },
    };
    revokeResult = failure;

    await runRevoke();

    expect(revokeCalls).toEqual([["bafy-device-grant", {
      targetSpaceId,
      targetDelegation: { delegatorDID: "did:pkh:eip155:1:0xowner", delegateDID: "did:key:device" },
    }]]);
    expect(outputs).toEqual([]);
    expect(errors).toEqual([failure.error]);
  });

  test("prefers the live delegation record over stale local history", async () => {
    hasRevokeAuthority = true;

    await runRevoke();

    expect(revokeCalls[0]?.[1]).toEqual({
      targetSpaceId,
      targetDelegation: { delegatorDID: "did:pkh:eip155:1:0xowner", delegateDID: "did:key:device" },
    });
    expect(errors).toEqual([]);
    expect(outputs).toEqual([{ cid: "bafy-device-grant", revoked: true, targetSpaceSource: "node" }]);
  });

  test("uses the live target space when local history lists multiple spaces", async () => {
    hasRevokeAuthority = true;
    grantHistory = [{
      delegationCid: "bafy-device-grant",
      addedCaps: [
        { service: "tinycloud.kv", space: fallbackSpaceId, path: "first/", actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.kv", space: "tinycloud:pkh:eip155:1:0xsecond:archive", path: "second/", actions: ["tinycloud.kv/get"] },
      ],
    }];
    delegationListResult = { ok: false, error: { code: "NETWORK_ERROR", message: "legacy list unavailable" } };

    await runRevoke();

    expect(revokeCalls[0]?.[1]).toMatchObject({
      targetSpaceId,
      targetDelegation: { delegatorDID: "did:pkh:eip155:1:0xowner", delegateDID: "did:key:device" },
    });
    expect(outputs[0]).toMatchObject({ targetSpaceSource: "node" });
  });

  test("reports local grant-history fallback when the node cannot find the target", async () => {
    hasRevokeAuthority = true;
    delegationListResult = { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } };
    delegationQueryResult = { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } };

    await runRevoke();

    expect(revokeCalls[0]?.[1]).toEqual({ targetSpaceId: fallbackSpaceId });
    expect(outputs).toEqual([{
      cid: "bafy-device-grant",
      revoked: true,
      targetSpaceSource: "local-grant-history",
    }]);
  });
});
