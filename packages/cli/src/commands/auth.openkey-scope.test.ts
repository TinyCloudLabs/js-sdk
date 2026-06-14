import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";

// Imports the real @tinycloud/node-sdk (workspace build), like auth.test.ts.
import {
  returnedSpaceMatchesExpected,
  portableFromOpenKeyDelegation,
  groupPermissionsBySpace,
} from "./auth.js";

// Same eip155 address in EIP-55 checksummed (OpenKey) vs lowercase (CLI) form.
const ADDR_CHECKSUM = "0xd559CCd9be5C5dbF8068dee29A91DF2c2d4D7B49";
const ADDR_LOWER = ADDR_CHECKSUM.toLowerCase();
const SPACE_CHECKSUM = `tinycloud:pkh:eip155:1:${ADDR_CHECKSUM}:applications`;
const SPACE_LOWER = `tinycloud:pkh:eip155:1:${ADDR_LOWER}:applications`;

function cap(service: string, space: string, path: string, actions: string[]): PermissionEntry {
  return { service, space, path, actions } as PermissionEntry;
}

describe("returnedSpaceMatchesExpected (case-insensitive address)", () => {
  test("checksummed returned vs lowercase expected matches", () => {
    expect(returnedSpaceMatchesExpected(SPACE_CHECKSUM, SPACE_LOWER)).toBe(true);
  });

  test("lowercase returned vs checksummed expected matches", () => {
    expect(returnedSpaceMatchesExpected(SPACE_LOWER, SPACE_CHECKSUM)).toBe(true);
  });

  test("bare space name still matches the URI suffix", () => {
    expect(returnedSpaceMatchesExpected(SPACE_CHECKSUM, "applications")).toBe(true);
  });

  test("a genuinely different space does not match", () => {
    const other = `tinycloud:pkh:eip155:1:${ADDR_LOWER}:other`;
    expect(returnedSpaceMatchesExpected(other, SPACE_LOWER)).toBe(false);
  });

  test("space NAME is case-sensitive — only-case NAME difference does NOT match", () => {
    // Same address, name "Applications" vs "applications" — must NOT be equal.
    const nameUpper = `tinycloud:pkh:eip155:1:${ADDR_CHECKSUM}:Applications`;
    expect(returnedSpaceMatchesExpected(nameUpper, SPACE_LOWER)).toBe(false);
    // Bare-name form likewise stays case-sensitive.
    expect(returnedSpaceMatchesExpected(SPACE_LOWER, "Applications")).toBe(false);
  });
});

describe("portableFromOpenKeyDelegation (scope mismatch)", () => {
  test("does NOT throw when OpenKey returns the checksummed form of the expected space", () => {
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
    ];
    const data = {
      spaceId: SPACE_CHECKSUM, // checksummed from OpenKey
      delegationCid: "bafyTEST",
      delegationHeader: { Authorization: "Bearer x" },
      verificationMethod: "did:key:zTest",
      address: ADDR_CHECKSUM,
      chainId: 1,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    };
    const portable = portableFromOpenKeyDelegation(data, permissions, "https://host");
    expect(portable.spaceId).toBe(SPACE_CHECKSUM);
    expect(portable.cid).toBe("bafyTEST");
  });

  test("two caps on the same space differing only by address casing are one expected space", () => {
    // sql cap lowercase, kv cap checksummed — both the same Listen space.
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
      cap("tinycloud.kv", SPACE_CHECKSUM, "xyz.tinycloud.listen/", ["get", "list"]),
    ];
    const data = {
      spaceId: SPACE_CHECKSUM,
      delegationCid: "bafyTEST2",
      delegationHeader: { Authorization: "Bearer x" },
      verificationMethod: "did:key:zTest",
      address: ADDR_CHECKSUM,
      chainId: 1,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    };
    // Must not throw OPENKEY_SCOPE_MISMATCH (expectedSpaces collapses to size 1).
    const portable = portableFromOpenKeyDelegation(data, permissions, "https://host");
    expect(portable.resources?.length).toBe(2);
  });

  test("still throws when OpenKey returns a genuinely different space", () => {
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
    ];
    const data = {
      spaceId: `tinycloud:pkh:eip155:1:${ADDR_LOWER}:somethingelse`,
      delegationCid: "bafyTEST3",
      delegationHeader: { Authorization: "Bearer x" },
      verificationMethod: "did:key:zTest",
      address: ADDR_LOWER,
      chainId: 1,
    };
    expect(() => portableFromOpenKeyDelegation(data, permissions, "https://host")).toThrow(
      /OpenKey returned delegation/,
    );
  });

  test("still throws when OpenKey returns the same address but a case-different NAME", () => {
    // Name is case-sensitive: expected "applications", returned "Applications".
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
    ];
    const data = {
      spaceId: `tinycloud:pkh:eip155:1:${ADDR_CHECKSUM}:Applications`,
      delegationCid: "bafyTEST4",
      delegationHeader: { Authorization: "Bearer x" },
      verificationMethod: "did:key:zTest",
      address: ADDR_CHECKSUM,
      chainId: 1,
    };
    expect(() => portableFromOpenKeyDelegation(data, permissions, "https://host")).toThrow(
      /OpenKey returned delegation/,
    );
  });

  test("still throws when OpenKey returns the same NAME but a different ADDRESS", () => {
    // Only the address segment is case-normalized; a genuinely different owner
    // address under the same ":applications" name must NOT match.
    const otherAddr = "0x1111111111111111111111111111111111111111";
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
    ];
    const data = {
      spaceId: `tinycloud:pkh:eip155:1:${otherAddr}:applications`,
      delegationCid: "bafyTEST5",
      delegationHeader: { Authorization: "Bearer x" },
      verificationMethod: "did:key:zTest",
      address: otherAddr,
      chainId: 1,
    };
    expect(() => portableFromOpenKeyDelegation(data, permissions, "https://host")).toThrow(
      /OpenKey returned delegation/,
    );
  });
});

describe("groupPermissionsBySpace (case-insensitive batching)", () => {
  test("same space differing by address casing batches into one group (one round-trip)", () => {
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "xyz.tinycloud.listen/conversations", ["read"]),
      cap("tinycloud.kv", SPACE_CHECKSUM, "xyz.tinycloud.listen/", ["get", "list"]),
    ];
    const groups = groupPermissionsBySpace(permissions);
    expect(groups.length).toBe(1);
    expect(groups[0]!.length).toBe(2);
  });

  test("genuinely different spaces stay in separate groups", () => {
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "a", ["read"]),
      cap("tinycloud.kv", `tinycloud:pkh:eip155:1:${ADDR_LOWER}:other`, "b", ["get"]),
    ];
    expect(groupPermissionsBySpace(permissions).length).toBe(2);
  });

  test("same address but case-different NAME is NOT merged (separate round-trips)", () => {
    // Name is case-sensitive: "applications" vs "Applications" are distinct spaces.
    const permissions = [
      cap("tinycloud.sql", SPACE_LOWER, "a", ["read"]),
      cap("tinycloud.kv", `tinycloud:pkh:eip155:1:${ADDR_CHECKSUM}:Applications`, "b", ["get"]),
    ];
    expect(groupPermissionsBySpace(permissions).length).toBe(2);
  });
});
