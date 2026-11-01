// TC-2276 (PR B): which commands are PLAIN paste logins. `tc init --paste` is one (it opts in to a user-chosen lifetime and
// holds the signed one to the 10 year / 60 s policy bound); `tc onboard` with a pasted code is not (it never passes
// `paste`, so it keeps its 30 day ceiling). `auth rotate --paste` is pinned in `auth.test.ts`.
// Real ProfileManager, real refreshOpenKeySession and real link builder; only the OpenKey acquisition is simulated.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const recordedErrors: unknown[] = [];
const outputs: unknown[] = [];
type Seen = { did: string; options: Record<string, unknown> };
const seen: Seen[] = [];
let pickedLifetimeMs = 0;

const realBrowserAuth = await import("../auth/browser-auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();

/** A real owner-signed session for the profile's own key, with a lifetime chosen by the test. */
async function proofFor(did: string, jwk: Record<string, unknown>, lifetimeMs: number) {
  const now = Date.now();
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + lifetimeMs).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const { d: _private, ...publicJwk } = jwk;
  return { ...session, jwk: publicJwk, verificationMethod: did, address, chainId: 1, spaceId,
    ownerDid: `did:pkh:eip155:1:${address}`, siwe: prepared.siwe, signature };
}

mock.module("../auth/browser-auth.js", () => ({
  ...realBrowserAuth,
  startAuthFlow: async (did: string, options: Record<string, unknown>) => {
    seen.push({ did, options });
    return proofFor(did, options.jwk as Record<string, unknown>, pickedLifetimeMs);
  },
}));
mock.module("../auth/space-setup.js", () => ({ ensureSpaceSetup: async () => undefined }));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number, public metadata?: Record<string, unknown>) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
    Object.assign(new Error(error.message), { code: error.code, exitCode: 1, metadata: error.meta }),
  handleError: (error: unknown) => { recordedErrors.push(error); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));
mock.module("../output/formatter.js", () => ({
  operationWarnings: (value: unknown) => (Array.isArray(value) ? value : []),
  outputWarnings: () => {},
  isInteractive: () => false,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, action: () => Promise<unknown>) => action(),
  outputJson: (value: unknown) => { outputs.push(value); },
  output: (value: unknown) => { outputs.push(value); },
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-paste-logins-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { registerInitCommand } = await import("./init.js");
const { registerOnboardCommand } = await import("./onboard.js");

const DAY = 86_400_000;
const HOST = "https://node.example.test";
let profileNumber = 0;
let profileName = "";

beforeEach(async () => {
  recordedErrors.length = 0;
  outputs.length = 0;
  seen.length = 0;
  profileName = `paste-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
});
afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const run = (register: (program: Command) => void, ...args: string[]) => {
  const program = new Command();
  program.option("-p, --profile <name>");
  register(program);
  return program.parseAsync(["node", "tc", "--profile", profileName, ...args], { from: "node" });
};
const signedExpiry = (siwe: unknown) => /Expiration Time: (.+)/.exec(String(siwe))![1]!;

describe("tc init --paste is a plain paste login", () => {
  const init = () => run(registerInitCommand, "init", "--name", profileName, "--host", HOST, "--paste");

  test("sends the opt-in: its real link carries expiryChangeable=true", async () => {
    pickedLifetimeMs = 7 * DAY;
    await init();
    expect(recordedErrors).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.paste).toBe(true);
    expect(seen[0]!.options.expiryChangeable).toBe(true);
    const link = new URL(realBrowserAuth.buildAuthUrl(seen[0]!.did, seen[0]!.options as never));
    expect(link.searchParams.get("expiryChangeable")).toBe("true");
  });

  test("accepts a one-year pick and saves the signed expiry", async () => {
    pickedLifetimeMs = 365 * DAY;
    await init();
    expect(recordedErrors).toEqual([]);
    const saved = await ProfileManager.getSession(profileName) as { expiresAt?: string; siwe: string };
    expect(saved.expiresAt).toBe(signedExpiry(saved.siwe));
    expect(Date.parse(saved.expiresAt!) - Date.now()).toBeGreaterThan(364 * DAY);
  });

  test("refuses a pick beyond 10 years, naming the limit, and saves no session", async () => {
    pickedLifetimeMs = 11 * 365 * DAY;
    await init();
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", message: expect.stringContaining("more than 10 years") })]);
    expect(await ProfileManager.getSession(profileName)).toBeNull();
  });

  test("without --paste there is no plain link and no opt-in", async () => {
    pickedLifetimeMs = 7 * DAY;
    await run(registerInitCommand, "init", "--name", profileName, "--host", HOST);
    expect(seen[0]!.options.expiryChangeable).toBeUndefined();
  });
});

describe("tc onboard with a pasted code keeps its 30 day ceiling", () => {
  const onboardWithCode = async (lifetimeMs: number) => {
    // The code an owner would paste: the signed session for this profile's own key (the profile is created by onboard).
    await ProfileManager.ensureConfigDir();
    const { createKeyOnlyProfile } = await import("./init.js");
    const { did } = await createKeyOnlyProfile(profileName, HOST);
    const key = await ProfileManager.getKey(profileName) as Record<string, unknown>;
    const code = JSON.stringify(await proofFor(did, key, lifetimeMs));
    await run(registerOnboardCommand, "onboard", "--code", code);
  };

  test("a one-year signed expiry is refused with OPENKEY_EXPIRY_EXCEEDED (the old --expiry ceiling, no opt-in)", async () => {
    await onboardWithCode(365 * DAY);
    expect(recordedErrors).toEqual([expect.objectContaining({
      code: "OPENKEY_EXPIRY_EXCEEDED",
      message: expect.stringMatching(/outlives the requested --expiry\. Choose an earlier lifetime in OpenKey, or re-run with a longer --expiry\. No session was saved\.$/),
    })]);
    expect(await ProfileManager.getSession(profileName)).toBeNull();
    expect(seen).toEqual([]);
  });
});
