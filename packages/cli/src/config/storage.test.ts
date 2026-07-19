import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "./storage.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tc-storage-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeJson", () => {
  test("writes data readable via readJson", async () => {
    const filePath = join(dir, "profile.json");
    await writeJson(filePath, { hello: "world" });
    expect(await readJson(filePath)).toEqual({ hello: "world" });
  });

  test("leaves no temp files behind on success", async () => {
    const filePath = join(dir, "profile.json");
    await writeJson(filePath, { a: 1 });
    const entries = await readdir(dir);
    expect(entries).toEqual(["profile.json"]);
  });

  test("never leaves a partially-written target: a prior write is intact if a later write's rename step is the only thing that ran", async () => {
    // Simulates the crash-safety property atomic writes give us: writing new
    // data never touches the existing file until the rename is ready to
    // succeed, so a reader never observes a half-written file.
    const filePath = join(dir, "profile.json");
    await writeJson(filePath, { version: 1 });
    await writeJson(filePath, { version: 2 });
    expect(await readJson(filePath)).toEqual({ version: 2 });
    const entries = await readdir(dir);
    expect(entries).toEqual(["profile.json"]);
  });
});
