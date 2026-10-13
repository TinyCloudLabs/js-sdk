import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../bin/tc");
let dir: string;

function help(name: string): string {
  const result = spawnSync("node", [join(dir, name), "--help"], { encoding: "utf-8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("program name", () => {
  beforeAll(async () => {
    dir = await mkdtemp("/var/tmp/tc-program-name-");
    await symlink(BIN, join(dir, "tc"));
    await symlink(BIN, join(dir, "tinycloud"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("help usage follows the invoked bin name", () => {
    expect(help("tinycloud")).toContain("\nUsage: tinycloud [options] [command]\n");
    expect(help("tc")).toContain("\nUsage: tc [options] [command]\n");
  });
});
