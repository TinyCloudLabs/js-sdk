import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";

import { saltedHash } from "./saltedHash.js";

describe("saltedHash", () => {
  test("is lowercase hex HMAC-SHA-256 keyed with the base64url-decoded salt over the UTF-8 material", async () => {
    const salt = randomBytes(32).toString("base64url");
    const material = "tc-replication/v1\nhttps://node.example\nspace\ndid:pkh:eip155:1:0xabc\nnotes/ ✓";
    const expected = createHmac("sha256", Buffer.from(salt, "base64url")).update(material, "utf8").digest("hex");
    expect(await saltedHash(salt, material)).toBe(expected);
  });

  test("the same material under another salt gives an unrelated id", async () => {
    const material = "same identity";
    const a = await saltedHash(randomBytes(32).toString("base64url"), material);
    const b = await saltedHash(randomBytes(32).toString("base64url"), material);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("a salt that is not base64url is refused", async () => {
    await expect(saltedHash("not base64url!", "x")).rejects.toThrow();
  });
});
