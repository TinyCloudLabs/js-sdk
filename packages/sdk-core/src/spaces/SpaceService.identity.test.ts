import { describe, expect, it } from "bun:test";

import { buildSpaceUri, makePublicSpaceId, parseSpaceUri } from "./SpaceService";

const LOWER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CHECKSUM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("SpaceService identity utilities", () => {
  it("canonicalizes public space IDs", () => {
    expect(makePublicSpaceId(LOWER, 1)).toBe(
      `tinycloud:pkh:eip155:1:${CHECKSUM}:public`,
    );
  });

  it("canonicalizes parsed PKH space URIs", () => {
    expect(parseSpaceUri(`tinycloud:pkh:eip155:1:${LOWER}:photos`)).toEqual({
      owner: `did:pkh:eip155:1:${CHECKSUM}`,
      name: "photos",
      chainId: "1",
      address: CHECKSUM,
    });
  });

  it("canonicalizes space URIs built from owner DIDs", () => {
    expect(buildSpaceUri(`did:pkh:eip155:1:${LOWER}`, "photos")).toBe(
      `tinycloud:pkh:eip155:1:${CHECKSUM}:photos`,
    );
  });
});
