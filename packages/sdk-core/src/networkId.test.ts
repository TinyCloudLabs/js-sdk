import { describe, expect, it } from "bun:test";

import { canonicalizeNetworkId, parseCanonicalNetworkId } from "./networkId";

const LOWER_OWNER_DID =
  "did:pkh:eip155:1:0xd559ccd9eb87c530a9a349262669386de93cf412";
const CHECKSUM_OWNER_DID =
  "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";

describe("canonicalizeNetworkId", () => {
  it("canonicalizes did:pkh:eip155 owner address casing", () => {
    expect(
      canonicalizeNetworkId(
        `urn:tinycloud:encryption:${LOWER_OWNER_DID}:default`,
      ),
    ).toBe(`urn:tinycloud:encryption:${CHECKSUM_OWNER_DID}:default`);
  });

  it("preserves non-PKH owner DIDs", () => {
    const networkId =
      "urn:tinycloud:encryption:did:key:z6MkfPN4DefaultPrincipalAaaaaaaaaaaaaaaaaaaaaaaaa:default";

    expect(canonicalizeNetworkId(networkId)).toBe(networkId);
  });

  it("returns parsed canonical owner DID and name", () => {
    expect(
      parseCanonicalNetworkId(
        `urn:tinycloud:encryption:${LOWER_OWNER_DID}:default`,
      ),
    ).toMatchObject({
      networkId: `urn:tinycloud:encryption:${CHECKSUM_OWNER_DID}:default`,
      ownerDid: CHECKSUM_OWNER_DID,
      name: "default",
    });
  });
});
