import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { groupPermissionsBySpace } from "./auth.js";

// Same eip155 address in EIP-55 checksummed (OpenKey) vs lowercase (CLI) form.
const ADDR_CHECKSUM = "0xd559CCd9be5C5dbF8068dee29A91DF2c2d4D7B49";
const ADDR_LOWER = ADDR_CHECKSUM.toLowerCase();
const SPACE_CHECKSUM = `tinycloud:pkh:eip155:1:${ADDR_CHECKSUM}:applications`;
const SPACE_LOWER = `tinycloud:pkh:eip155:1:${ADDR_LOWER}:applications`;

function cap(service: string, space: string, path: string, actions: string[]): PermissionEntry {
  return { service, space, path, actions } as PermissionEntry;
}

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
