import { describe, expect, it } from "bun:test";

import {
  IdentityParseError,
  canonicalizeAddress,
  canonicalizeDid,
  canonicalizeDidUrl,
  didCacheKey,
  didEquals,
  makePkhSpaceId,
  parsePkhDid,
  pkhDid,
  principalDid,
  principalDidEquals,
} from "./identity";

const LOWER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const MIXED_BAD_CHECKSUM = "0xF39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CHECKSUM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("identity helpers", () => {
  it("canonicalizes EVM addresses to EIP-55", () => {
    expect(canonicalizeAddress(LOWER)).toBe(CHECKSUM);
    expect(canonicalizeAddress(MIXED_BAD_CHECKSUM)).toBe(CHECKSUM);
  });

  it("builds and parses canonical did:pkh identifiers", () => {
    const did = pkhDid(LOWER, 1);

    expect(did).toBe(`did:pkh:eip155:1:${CHECKSUM}`);
    expect(canonicalizeDid(`did:pkh:eip155:1:${LOWER}`)).toBe(did);
    expect(parsePkhDid(did)).toEqual({
      method: "pkh",
      namespace: "eip155",
      chainId: 1,
      address: CHECKSUM,
    });
  });

  it("canonicalizes did:pkh DID URLs without changing fragments", () => {
    expect(canonicalizeDidUrl(`did:pkh:eip155:1:${LOWER}#controller`)).toBe(
      `did:pkh:eip155:1:${CHECKSUM}#controller`,
    );
    expect(principalDid(`did:pkh:eip155:1:${LOWER}#controller`)).toBe(
      `did:pkh:eip155:1:${CHECKSUM}`,
    );
  });

  it("compares did:pkh identifiers canonically", () => {
    expect(didEquals(`did:pkh:eip155:1:${LOWER}`, `did:pkh:eip155:1:${CHECKSUM}`)).toBe(true);
    expect(
      principalDidEquals(
        `did:pkh:eip155:1:${LOWER}#controller`,
        `did:pkh:eip155:1:${CHECKSUM}#different`,
      ),
    ).toBe(true);
  });

  it("keeps did:key identifiers exact", () => {
    expect(canonicalizeDid("did:key:z6MkExampleAbcd")).toBe("did:key:z6MkExampleAbcd");
    expect(didEquals("did:key:z6MkExampleAbcd", "did:key:z6MkExampleabcd")).toBe(false);
    expect(didCacheKey("did:key:z6MkExampleAbcd#z6MkExampleAbcd")).toBe(
      "did:key:z6MkExampleAbcd",
    );
  });

  it("uses lowercase address keys only for did:pkh cache keys", () => {
    expect(didCacheKey(`did:pkh:eip155:1:${CHECKSUM}`)).toBe(
      `did:pkh:eip155:1:${LOWER}`,
    );
    expect(didCacheKey(`did:pkh:eip155:1:${CHECKSUM}#controller`, {
      preserveFragment: true,
    })).toBe(`did:pkh:eip155:1:${LOWER}#controller`);
  });

  it("constructs canonical PKH space IDs", () => {
    expect(makePkhSpaceId(LOWER, 1, "public")).toBe(
      `tinycloud:pkh:eip155:1:${CHECKSUM}:public`,
    );
  });

  it("rejects invalid addresses", () => {
    expect(() => canonicalizeAddress("0x1234")).toThrow(IdentityParseError);
  });
});
