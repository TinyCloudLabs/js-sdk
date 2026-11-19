// TC-2997: `auth login --manifest` without `--device` and without `--expiry` asks OpenKey for a one-hour session over the
// approval link; builtin:share-publishing asks for seven days, since its Share links end with the session. An explicit
// `--expiry` decides over both, and a login without a manifest keeps its own default.
// Real ProfileManager and real refreshOpenKeySession; only the OpenKey acquisition is replaced, and it stops the login.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

type Acquisition = { expiry?: string | number; paste?: boolean; permissions?: unknown[] };
const acquisitions: Acquisition[] = [];
const recordedErrors: Array<{ code?: string; message?: string }> = [];

const realBrowserAuth = await import("../auth/browser-auth.js");
mock.module("../auth/browser-auth.js", () => ({
  ...realBrowserAuth,
  startAuthFlow: async (_did: string, options: Acquisition) => {
    acquisitions.push({ expiry: options.expiry, paste: options.paste, permissions: options.permissions });
    throw Object.assign(new Error("acquisition stopped by the test"), { code: "TEST_STOP" });
  },
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number, public metadata?: Record<string, unknown>) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string }) => Object.assign(new Error(error.message), { code: error.code, exitCode: 1 }),
  handleError: (error: unknown) => { recordedErrors.push(error as never); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

const originalHome = process.env.TC_HOME;
// Imported after mock.module and TC_HOME are set, so the CLI modules load the mocks and this test's home.
const home = await mkdtemp(join(tmpdir(), "tc-login-default-expiry-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { createKeyOnlyProfile } = await import("./init.js");
const { registerAuthCommand } = await import("./auth.js");

const HOST = "https://node.example.test";
const MANIFEST = `base64:${Buffer.from(JSON.stringify({
  app_id: "xyz.example.notes", name: "Notes", space: "default",
  permissions: [{ service: "tinycloud.kv", path: "notes/", actions: ["tinycloud.kv/get"] }],
})).toString("base64")}`;
let profileNumber = 0;
let profileName = "";

beforeEach(async () => {
  acquisitions.length = 0;
  recordedErrors.length = 0;
  profileName = `expiry-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await createKeyOnlyProfile(profileName, HOST);
});
afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function login(...args: string[]): Promise<Acquisition> {
  const program = new Command();
  program.option("-p, --profile <name>");
  registerAuthCommand(program);
  await program.parseAsync(["node", "tc", "--profile", profileName, "auth", "login", "--no-popup", ...args], { from: "node" });
  expect(recordedErrors.map((error) => error.code)).toEqual(["TEST_STOP"]);
  expect(acquisitions).toHaveLength(1);
  return acquisitions[0]!;
}

describe("auth login lifetime requested from OpenKey", () => {
  test("a manifest login without --expiry asks for one hour over the approval link", async () => {
    const request = await login("--manifest", MANIFEST);
    expect(request.paste).toBeUndefined();
    expect(request.expiry).toBe("3600s");
  });

  test("builtin:share-publishing without --expiry asks for seven days, so its Share links keep their 7-day life", async () => {
    const owner = "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD";
    expect((await login("--manifest", "builtin:share-publishing", "--owner", owner)).expiry).toBe(`${7 * 86_400}s`);
    acquisitions.length = 0;
    recordedErrors.length = 0;
    expect((await login("--manifest", "builtin:share-publishing", "--owner", owner, "--expiry", "1h")).expiry).toBe("3600s");
  });

  test("an explicit --expiry overrides the one-hour default", async () => {
    expect((await login("--manifest", MANIFEST, "--expiry", "7d")).expiry).toBe(`${7 * 86_400}s`);
    acquisitions.length = 0;
    recordedErrors.length = 0;
    expect((await login("--manifest", MANIFEST, "--expiry", "30m")).expiry).toBe("1800s");
  });

  test("a login without a manifest sends no lifetime, keeping its own default", async () => {
    expect((await login("--method", "openkey")).expiry).toBeUndefined();
  });
});
