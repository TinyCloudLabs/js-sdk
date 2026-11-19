import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardMdChangedText, rememberCardMdVersion, seenCardMdVersion } from "./card-md.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("escape, control and bidi characters in card.md reach stderr as visible escapes; newlines and tabs stay", () => {
  const text = cardMdChangedText({ text: "a\u001b[2Jb\u009bc\u202ed\n\te", version: "abc" });
  expect(text).toBe("The owner's card.md changed (abc):\na\\u{1b}[2Jb\\u{9b}c\\u{202e}d\n\te");
  expect(text).not.toContain("\u001b");
});

test("the same escaping applies to the default's line and to the version", () => {
  const text = cardMdChangedText({ text: "x\u001b", version: "v\u001b", default: true });
  expect(text).toBe("The owner hasn't set a card.md, so this is the default (v\\u{1b}):\nx\\u{1b}");
});

test("an agent token with path separators cannot move the state file out of the profile directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-card-md-"));
  directories.push(dir);
  await rememberCardMdVersion(dir, "../../escape", "v1");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain("/");
  expect(await seenCardMdVersion(dir, "../../escape")).toBe("v1");
});
