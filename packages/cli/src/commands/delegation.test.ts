import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

let hasRevokeAuthority = false;
const authorityRequests: unknown[] = [];
const revokeCalls: string[] = [];
const outputs: unknown[] = [];
const errors: unknown[] = [];

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

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => ({
    hasRuntimePermissions: () => hasRevokeAuthority,
    delegationManager: {
      revoke: async (cid: string) => {
        revokeCalls.push(cid);
        return { ok: true, data: undefined };
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
  errors.length = 0;
});

describe("tc delegation revoke authority", () => {
  test("acquires only revoke authority before revoking when the session lacks it", async () => {
    await runRevoke();

    expect(authorityRequests).toHaveLength(1);
    expect(authorityRequests[0]).toMatchObject({
      ctx: { profile: "owner", host: "https://node.example.test" },
      requested: [{
        service: "tinycloud.delegation",
        space: "tinycloud:pkh:eip155:1:0xowner:default",
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }],
      reason: "Revoke delegation bafy-device-grant",
      yes: true,
    });
    expect(revokeCalls).toEqual(["bafy-device-grant"]);
    expect(outputs).toEqual([{ cid: "bafy-device-grant", revoked: true }]);
    expect(errors).toEqual([]);
  });

  test("keeps using existing revoke authority without acquiring more", async () => {
    hasRevokeAuthority = true;

    await runRevoke();

    expect(authorityRequests).toEqual([]);
    expect(revokeCalls).toEqual(["bafy-device-grant"]);
    expect(outputs).toEqual([{ cid: "bafy-device-grant", revoked: true }]);
    expect(errors).toEqual([]);
  });
});
