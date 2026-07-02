import { describe, expect, it } from "bun:test";
import type { Result, ServiceError } from "@tinycloud/sdk-services";

import {
  SpaceService,
  SpaceErrorCodes,
  type SpaceServiceConfig,
  type HostSpaceFunction,
} from "./SpaceService";

const OWNER_DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const PRIMARY_SPACE_ID =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";

const session = {
  delegationHeader: { Authorization: "Bearer test" },
  delegationCid: "bafy-test",
  spaceId: PRIMARY_SPACE_ID,
  verificationMethod: "did:key:z6MkTest",
  jwk: {},
};

function makeConfig(overrides: Partial<SpaceServiceConfig> = {}): SpaceServiceConfig {
  return {
    hosts: ["https://node.tinycloud.xyz"],
    session,
    userDid: OWNER_DID,
    // The bare invoke path must never be exercised by create() anymore.
    invoke: () => {
      throw new Error("invoke must not be called by create()");
    },
    // Any network access from create() is a regression (it used to POST /invoke
    // with tinycloud.space/create).
    fetch: (async () => {
      throw new Error("fetch must not be called by create()");
    }) as unknown as SpaceServiceConfig["fetch"],
    ...overrides,
  };
}

describe("SpaceService.create host-activation", () => {
  it("returns NOT_INITIALIZED when no hostSpace function is injected", async () => {
    const spaces = new SpaceService(makeConfig());

    const result = await spaces.create("default");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SpaceErrorCodes.NOT_INITIALIZED);
    }
  });

  it("runs the injected hostSpace ceremony without hitting the network", async () => {
    const hostedSpaces: string[] = [];
    const hostSpace: HostSpaceFunction = async (spaceId) => {
      hostedSpaces.push(spaceId);
      return { ok: true, data: undefined } as Result<void, ServiceError>;
    };

    const spaces = new SpaceService(makeConfig({ hostSpace }));

    const result = await spaces.create("default");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The returned id is the primary session space id (the ceremony target).
      expect(result.data.id).toBe(PRIMARY_SPACE_ID);
      expect(result.data.type).toBe("owned");
    }
    // The ceremony was invoked with the full space id, and nothing else.
    expect(hostedSpaces).toEqual([PRIMARY_SPACE_ID]);
  });
});
