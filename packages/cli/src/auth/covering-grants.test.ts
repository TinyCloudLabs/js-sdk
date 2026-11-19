import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { storedGrantsCovering } from "./covering-grants.js";

// TC-3153: `auth request --grant --fresh` lists the still-valid grants that already covered the request beside the new one.

const OWNER = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const NOW = Date.parse("2026-11-18T12:00:00Z");
const cid = (letter: string) => `bafkr4i${letter.repeat(52)}`;
const key = (path: string, action = "tinycloud.kv/get"): PermissionEntry => ({ service: "tinycloud.kv", space: "secrets", path, actions: [action] });
const stored = (letter: string, expiry: string | Date, permissions: PermissionEntry[]) => ({ delegation: { cid: cid(letter), expiry }, permissions });

describe("storedGrantsCovering", () => {
  const live = "2026-11-25T12:00:00.000Z";

  test("lists a live grant that holds everything requested, with its expiry", () => {
    expect(storedGrantsCovering([stored("a", live, [key("vault/KEY")])], [key("vault/KEY")], OWNER, NOW))
      .toEqual([{ cid: cid("a"), expiry: live }]);
  });

  test("leaves out an expired grant, a narrower one, one for another action, and one with an unreadable shape", () => {
    const entries = [
      stored("a", "2026-11-18T11:59:59.000Z", [key("vault/KEY")]),
      stored("b", live, [key("vault/OTHER")]),
      stored("c", live, [key("vault/KEY", "tinycloud.kv/put")]),
      { delegation: { cid: "not-a-cid", expiry: live }, permissions: [key("vault/KEY")] },
      { delegation: { cid: cid("d"), expiry: "never" }, permissions: [key("vault/KEY")] },
      { delegation: { cid: cid("e"), expiry: live }, permissions: "everything" },
      "garbage",
      null,
    ];
    expect(storedGrantsCovering(entries, [key("vault/KEY")], OWNER, NOW)).toEqual([]);
  });

  test("an expiry given as a Date counts; the same CID twice is listed once; the order is the stored order", () => {
    expect(storedGrantsCovering([
      stored("a", new Date(live), [key("vault/KEY")]),
      stored("b", live, [key("vault/KEY")]),
      stored("a", live, [key("vault/KEY")]),
    ], [key("vault/KEY")], OWNER, NOW).map((grant) => grant.cid)).toEqual([cid("a"), cid("b")]);
  });

  test("without an owner nothing is claimed to cover the request", () => {
    expect(storedGrantsCovering([stored("a", live, [key("vault/KEY")])], [key("vault/KEY")], undefined, NOW)).toEqual([]);
  });
});
