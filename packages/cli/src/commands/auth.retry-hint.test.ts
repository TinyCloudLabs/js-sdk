import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

// TC-3153: `auth retry` re-checks stored permission requests, which only `auth request` without --grant writes. A stopped
// `auth request --grant` saves an approval request instead, and its resume is running the same command again. When retry
// finds nothing, its error must say so instead of leaving the agent with a dead end.

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-retry-hint-"));
process.env.TC_HOME = home;
const recordedErrors: unknown[] = [];
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number, public metadata?: Record<string, unknown>) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string }) => Object.assign(new Error(error.message), { code: error.code, exitCode: 1 }),
  handleError: (error: unknown) => { recordedErrors.push(error); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

const { ProfileManager } = await import("../config/profiles.js");
const { registerAuthCommand } = await import("./auth.js");

const profileName = "retry-hint";
beforeEach(async () => {
  recordedErrors.length = 0;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ defaultProfile: profileName, version: 1 });
  await ProfileManager.setProfile(profileName, {
    name: profileName, host: "https://node.example.test", did: "did:key:z6Mkexample", ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    chainId: 1, spaceName: "default", authMethod: "openkey", posture: "owner-openkey", operatorType: "human", createdAt: new Date().toISOString(),
  } as never);
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function retry(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>");
  registerAuthCommand(program);
  await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "retry", ...args], { from: "node" });
}

describe("auth retry with nothing stored", () => {
  test.each([["--last", ["--last"]], ["no request id", []]])("%s: REQUEST_NOT_FOUND names the resume path of a stopped --grant", async (_name, args) => {
    await retry(...args);
    expect(recordedErrors).toEqual([expect.objectContaining({
      code: "REQUEST_NOT_FOUND",
      exitCode: 4,
      message: expect.stringContaining("run the same command again"),
    })]);
    expect(String((recordedErrors[0] as { message: string }).message)).toContain("auth request ... --grant");
  });
});
