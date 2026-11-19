import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { CARD_MD_DEFAULT, CARD_MD_DEFAULT_VERSION } from "./card-md-default.js";

// The Feed (tinychat) pins this same literal for its copy of the text. If the default changes, both move together.
test("the bundled default is the Feed's default text", () => {
  expect(CARD_MD_DEFAULT_VERSION).toBe("ce089aab8391");
  expect(createHash("sha256").update(CARD_MD_DEFAULT, "utf8").digest("hex").slice(0, 12)).toBe("ce089aab8391");
});
