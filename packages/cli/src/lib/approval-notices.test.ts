import { describe, expect, test } from "bun:test";
import { approvalNotices } from "./approval-notices.js";

const entry = (space: string) => [{ service: "tinycloud.kv", space, path: "", actions: ["tinycloud.kv/get"] }];

describe("approvalNotices", () => {
  test("a two-space grant announces both approvals and numbers each prompt", () => {
    expect(approvalNotices([entry("tinycloud:pkh:eip155:1:0xabc:account"), entry("default")])).toEqual({
      intro: "This needs 2 approvals in OpenKey (account space, then default space).",
      prompts: ["Approval 1 of 2: account space...", "Approval 2 of 2: default space..."],
    });
  });

  test("a one-space grant needs no notice", () => {
    expect(approvalNotices([entry("default")])).toBeUndefined();
    expect(approvalNotices([])).toBeUndefined();
  });
});
