import { describe, expect, it } from "bun:test";
import type {
  IDataVaultService,
  IKVService,
  Result,
  ServiceError,
} from "@tinycloud/sdk-services";

import { SpaceService, type SpaceServiceConfig } from "./SpaceService";

const session = {
  delegationHeader: { Authorization: "Bearer test" },
  delegationCid: "bafy-test",
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  verificationMethod: "did:key:z6MkTest",
  jwk: {},
};

function makeConfig(
  calls: { kv: string[]; vault: string[] },
): SpaceServiceConfig {
  return {
    hosts: ["https://node.tinycloud.xyz"],
    session,
    invoke: () => ({}),
    userDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    createKVService: (spaceId) => {
      calls.kv.push(spaceId);
      return { spaceId } as unknown as IKVService;
    },
    createVaultService: (spaceId) => {
      calls.vault.push(spaceId);
      return { spaceId } as unknown as IDataVaultService;
    },
    createDelegation: async () =>
      ({
        ok: false,
        error: {
          code: "NOT_IMPLEMENTED",
          message: "not implemented",
          service: "delegation",
        },
      }) as Result<never, ServiceError>,
  };
}

describe("SpaceService space factories", () => {
  it("creates a space-scoped vault", () => {
    const calls = { kv: [] as string[], vault: [] as string[] };
    const spaces = new SpaceService(makeConfig(calls));

    const secrets = spaces.get("secrets");

    expect((secrets.kv as unknown as { spaceId: string }).spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
    );
    expect((secrets.vault as unknown as { spaceId: string }).spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
    );
    expect(calls).toEqual({
      kv: [
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      ],
      vault: [
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      ],
    });
  });

  it("caches space instances with their scoped services", () => {
    const calls = { kv: [] as string[], vault: [] as string[] };
    const spaces = new SpaceService(makeConfig(calls));

    expect(spaces.get("secrets")).toBe(spaces.get("secrets"));
    expect(calls.kv).toHaveLength(1);
    expect(calls.vault).toHaveLength(1);
  });
});
