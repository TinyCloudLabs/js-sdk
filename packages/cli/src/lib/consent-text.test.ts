import { describe, expect, test } from "bun:test";

import { permissionConsentLine, signExtrasQuestion } from "./consent-text.js";

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

describe("confirmation text", () => {
  test("a permission line shows request text escaped: no ANSI clear-screen, CR or bidi override reaches the prompt", () => {
    const line = permissionConsentLine({
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0xabc:applications",
      path: "xyz.test.recipes/\u001b[2J\u001b[H\u202ex/\raaaa",
      actions: ["tinycloud.kv/del", "tinycloud.kv/\u001b[2Kx"],
    });
    expect(line).not.toMatch(RAW_CONTROL);
    expect(line).toContain("\\u{1b}[2J");
    expect(line).toContain("\\u{202e}");
    expect(line).toContain("\\u{d}");
    expect(line).toContain("tinycloud.kv:applications:xyz.test.recipes/");
  });

  test("an ordinary permission is unchanged", () => {
    expect(permissionConsentLine({
      service: "tinycloud.kv",
      space: "tinycloud:pkh:eip155:1:0xabc:applications",
      path: "xyz.app/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    })).toBe("tinycloud.kv:applications:xyz.app/:get,list");
  });

  test("the signing question repeats no request text", () => {
    expect(signExtrasQuestion(1)).toContain("1 entry marked !");
    expect(signExtrasQuestion(3)).toContain("3 entries marked !");
    expect(signExtrasQuestion(2).replace(/\n/g, "")).not.toMatch(RAW_CONTROL);
  });
});
