// TC-2276: in a paste login OpenKey creates the delegation to the profile's key BEFORE the CLI sees the code. When the CLI
// then refuses the signed message (an 11 year or 1 minute pick, a wrong owner, a bad proof ...) that delegation is live, so
// the refusal must also make it unusable: the profile's key and the saved copy of the approval are deleted, a profile this
// login created is removed, and ONE plain line says so. A key a live session still uses is NEVER deleted.
// Real ProfileManager and real refreshOpenKeySession; only the OpenKey acquisition is simulated (it also saves the redeemed
// code's local copy, as the real paste flow does).

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const recordedErrors: Array<{ code?: string; exitCode?: number; message?: string }> = [];
let pickedLifetimeMs = 0;
let tamper: "none" | "signature" = "none";
let savedPendingCopies = 0;
const stderr: string[] = [];

const realBrowserAuth = await import("../auth/browser-auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const OTHER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

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
  return {
    ...session, jwk: publicJwk, verificationMethod: did, address, chainId: 1,
    spaceId,
    ownerDid: `did:pkh:eip155:1:${address}`, siwe: prepared.siwe,
    signature: tamper === "signature" ? await signer.signMessage("not the message that was approved") : signature,
  };
}

let savePendingDelegation: typeof import("../auth/pending-code.js").savePendingDelegation;
mock.module("../auth/browser-auth.js", () => ({
  ...realBrowserAuth,
  startAuthFlow: async (did: string, options: Record<string, unknown>) => {
    const delegation = await proofFor(did, options.jwk as Record<string, unknown>, pickedLifetimeMs);
    // What the real paste flow does right after it redeems a short code: keep the owner's approval locally.
    if (options.profileName !== undefined && Date.parse(/Expiration Time: (.+)/.exec(delegation.siwe)![1]!) > Date.now()) {
      await savePendingDelegation(options.profileName as string, "abcd-efgh", delegation as never);
      savedPendingCopies += 1;
    }
    return delegation;
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
  handleError: (error: unknown) => { recordedErrors.push(error as never); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));
mock.module("../output/formatter.js", () => ({
  operationWarnings: (value: unknown) => (Array.isArray(value) ? value : []),
  outputWarnings: () => {},
  isInteractive: () => false,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, action: () => Promise<unknown>) => action(),
  outputJson: () => {},
  output: () => {},
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-paste-refusal-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { registerInitCommand, createKeyOnlyProfile } = await import("./init.js");
const { registerAuthCommand, refreshOpenKeySession } = await import("./auth.js");
({ savePendingDelegation } = await import("../auth/pending-code.js"));

const DAY = 86_400_000;
const HOST = "https://node.example.test";
// The exact lines (no secrets): the owner is told the approval was not used, what happened to its key, and where to remove it.
const DELETED_LINE = "The approval was not used and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.";
const KEPT_LINE = "The approval was not used, but this profile's key was kept because it is still in use, so the approval stays active until you remove it at account.tinycloud.xyz.";
let profileNumber = 0;
let profileName = "";
// (stderr capture: see `capturing` below)

beforeEach(async () => {
  recordedErrors.length = 0;
  stderr.length = 0;
  savedPendingCopies = 0;
  tamper = "none";
  profileName = `refusal-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ ...(await ProfileManager.getConfig()), defaultProfile: "default" });
});
afterAll(async () => {
  // (nothing to restore: stderr is captured per command)
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const files = (name: string) => ({
  key: existsSync(join(profilePath(name), "key.json")),
  pending: existsSync(join(profilePath(name), "pending-delegation-code.json")),
  session: existsSync(join(profilePath(name), "session.json")),
});
const lines = (text: string) => stderr.join("").split("\n").filter((line) => line === text);
/** stderr is captured only while a command runs (a global spy would also swallow bun's own report). */
async function capturing<T>(run: () => Promise<T>): Promise<T> {
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as never);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}
const runAuth = (...args: string[]) => {
  const program = new Command();
  program.option("-p, --profile <name>");
  registerAuthCommand(program);
  return capturing(() => program.parseAsync(["node", "tc", "--profile", profileName, "auth", ...args], { from: "node" }));
};
const login = (...extra: string[]) => runAuth("login", "--method", "openkey", "--paste", "--no-popup", ...extra);

// [refusal code, its exit code today (unchanged), how the signed result is made refusable, extra login args]
const REFUSALS: Array<[string, number, () => void, string[]]> = [
  ["OPENKEY_EXPIRY_EXCEEDED", 5, () => { pickedLifetimeMs = 11 * 365 * DAY; }, []],
  ["OPENKEY_EXPIRY_TOO_SHORT", 5, () => { pickedLifetimeMs = 30_000; }, []],
  ["AUTH_EXPIRED", 3, () => { pickedLifetimeMs = -30_000; }, []],
  ["OPENKEY_PROOF_INVALID", 3, () => { pickedLifetimeMs = 7 * DAY; tamper = "signature"; }, []],
  ["OPENKEY_OWNER_MISMATCH", 5, () => { pickedLifetimeMs = 7 * DAY; }, ["--owner", `did:pkh:eip155:1:${OTHER_ADDRESS}`]],
];

describe("tc auth login --paste: a refused approval leaves no usable key (the profile was created by this login)", () => {
  for (const [code, exitCode, arrange, extra] of REFUSALS) {
    test(`${code}: no key, no saved approval, no session, no profile; the plain line once; exit ${exitCode}`, async () => {
      arrange();
      await login(...extra);
      expect(recordedErrors).toEqual([expect.objectContaining({ code, exitCode })]);
      if (code !== "AUTH_EXPIRED") expect(savedPendingCopies).toBe(1);
      expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
      expect(await ProfileManager.profileExists(profileName)).toBe(false);
      expect(await ProfileManager.getKey(profileName)).toBeNull();
      expect(lines(DELETED_LINE)).toHaveLength(1);
      expect(lines(KEPT_LINE)).toHaveLength(0);
      // The default profile is what it was before this login created (and removed) the profile.
      expect((await ProfileManager.getConfig()).defaultProfile).toBe("default");
    });
  }

  test("a SUCCESSFUL paste login still keeps its key and session, and prints neither line", async () => {
    pickedLifetimeMs = 30 * DAY;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([]);
    expect(files(profileName)).toMatchObject({ key: true, session: true });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expect(lines(DELETED_LINE)).toHaveLength(0);
    expect(lines(KEPT_LINE)).toHaveLength(0);
  });
});

describe("tc init --paste: a refused approval removes the profile it created", () => {
  test("OPENKEY_EXPIRY_EXCEEDED: no key, no saved approval, no profile; the plain line once", async () => {
    pickedLifetimeMs = 11 * 365 * DAY;
    const program = new Command();
    program.option("-p, --profile <name>");
    registerInitCommand(program);
    await capturing(() => program.parseAsync(["node", "tc", "init", "--name", profileName, "--host", HOST, "--paste"], { from: "node" }));
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(false);
    expect(lines(DELETED_LINE)).toHaveLength(1);
    expect((await ProfileManager.getConfig()).defaultProfile).toBe("default");
  });
});

describe("a profile that already existed (key only, no session): the key and the saved approval go, the profile stays", () => {
  test("OPENKEY_EXPIRY_EXCEEDED", async () => {
    await createKeyOnlyProfile(profileName, HOST);
    pickedLifetimeMs = 11 * 365 * DAY;
    await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true }))).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 });
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expect(lines(DELETED_LINE)).toHaveLength(1);
  });

  for (const [code, scope] of [
    ["OPENKEY_GRANT_BROADENED", { service: "tinycloud.kv", space: "default", path: "example/", actions: ["tinycloud.kv/get"] }],
    ["OPENKEY_SCOPE_MISMATCH", { service: "tinycloud.kv", space: "other", path: "", actions: ["tinycloud.kv/get"] }],
  ] as const) {
    test(`a scoped (--manifest) login: ${code}`, async () => {
      await createKeyOnlyProfile(profileName, HOST);
      pickedLifetimeMs = 7 * DAY;
      await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, permissions: [scope as never] }))).rejects.toMatchObject({ code });
      expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
      expect(lines(DELETED_LINE)).toHaveLength(1);
    });
  }
});

describe("a profile with a LIVE session: its key is never deleted", () => {
  const signedIn = async () => {
    pickedLifetimeMs = 30 * DAY;
    await login();
    expect(recordedErrors).toEqual([]);
    const before = { key: JSON.stringify(await ProfileManager.getKey(profileName)), session: JSON.stringify(await ProfileManager.getSession(profileName)) };
    stderr.length = 0;
    savedPendingCopies = 0;
    return before;
  };

  test("an 11 year pick is refused, the key and the session stay byte for byte, the saved approval goes, the kept line is printed once", async () => {
    const before = await signedIn();
    pickedLifetimeMs = 11 * 365 * DAY;
    await login("--replace-session");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
    expect(lines(KEPT_LINE)).toHaveLength(1);
    expect(lines(DELETED_LINE)).toHaveLength(0);
  });

  // Only a SCOPED (--manifest) login re-checks the live session at the commit; it refuses a pick that would shorten it.
  test("a scoped login whose pick would SHORTEN the live session is refused at the commit (SESSION_IN_USE): same, key and session kept", async () => {
    const scope = [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }] as never;
    await createKeyOnlyProfile(profileName, HOST);
    pickedLifetimeMs = 30 * DAY;
    await capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, permissions: scope }));
    const before = { key: JSON.stringify(await ProfileManager.getKey(profileName)), session: JSON.stringify(await ProfileManager.getSession(profileName)) };
    stderr.length = 0;
    savedPendingCopies = 0;
    pickedLifetimeMs = 60 * 60_000;
    await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, permissions: scope }))).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
    expect(lines(KEPT_LINE)).toHaveLength(1);
    expect(lines(DELETED_LINE)).toHaveLength(0);
  });
});

describe("tc auth rotate --paste: the rotation already replaced the key and cleared the session, so a refusal deletes the new key", () => {
  test("OPENKEY_EXPIRY_EXCEEDED", async () => {
    pickedLifetimeMs = 30 * DAY;
    await login();
    expect(recordedErrors).toEqual([]);
    stderr.length = 0;
    pickedLifetimeMs = 11 * 365 * DAY;
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(lines(DELETED_LINE)).toHaveLength(1);
  });
});
