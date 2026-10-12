import { describe, expect, it } from "bun:test";

import type { SpaceInfo } from "../delegations/types";
import { SpaceService } from "./SpaceService";

const OWNER = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SPACES = ["default", "secrets"].map((name) => ({
  id: `tinycloud:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:${name}`,
  name,
  owner: OWNER,
}));

function listingService(isStorageFull: () => boolean) {
  const registered: SpaceInfo[] = [];
  const service = new SpaceService({
    hosts: ["https://node.test"],
    session: {
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy",
      spaceId: SPACES[0].id,
      verificationMethod: "did:key:test",
      jwk: {},
    },
    invoke: () => ({ Authorization: "Bearer invocation" }),
    fetch: async () => new Response(JSON.stringify(SPACES), { status: 200 }),
    onSpaceRegistered: (space) => {
      registered.push(space);
    },
    isStorageFull,
  });
  return { service, registered };
}

describe("SpaceService.list() on a full account", () => {
  it("registers listed spaces while storage has room", async () => {
    const { service, registered } = listingService(() => false);

    const listed = await service.list();

    expect(listed.ok).toBe(true);
    expect(registered.map((space) => space.name)).toEqual(["default", "secrets"]);
  });

  it("still lists, but sends no registration writes, once storage is known full", async () => {
    const { service, registered } = listingService(() => true);

    const listed = await service.list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.map((space) => space.name)).toEqual(["default", "secrets"]);
    expect(registered).toEqual([]);
  });
});
