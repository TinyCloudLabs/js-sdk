import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkspaceRoot } from "../src/clients/sut";

describe("defaultWorkspaceRoot", () => {
  const savedEnv = process.env.TC893_SUT_ROOT;
  const created: string[] = [];
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.TC893_SUT_ROOT; else process.env.TC893_SUT_ROOT = savedEnv;
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("returns the git top-level when invoked from a subdirectory", async () => {
    delete process.env.TC893_SUT_ROOT;
    const repo = await realpath(await mkdtemp(join(tmpdir(), "tc893-root-")));
    created.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const nested = join(repo, "tests", "replication-harness");
    await mkdir(nested, { recursive: true });
    expect(defaultWorkspaceRoot(nested)).toBe(repo);
  });

  test("TC893_SUT_ROOT wins over the git top-level", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "tc893-root-")));
    created.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    process.env.TC893_SUT_ROOT = "/tmp/tc893-override";
    expect(defaultWorkspaceRoot(repo)).toBe("/tmp/tc893-override");
  });
});
