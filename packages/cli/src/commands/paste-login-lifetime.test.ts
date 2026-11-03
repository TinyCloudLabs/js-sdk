// TC-2276: the plain paste login (`auth login --paste`, `init --paste`, `auth rotate --paste`) tells OpenKey the owner may choose
// the lifetime (`expiryChangeable=true`), so the CLI accepts whatever lifetime the owner signed: past 10 years too, no upper cap
// (an artificial cap is a product decision this CLI does not make). It still refuses a signed lifetime of 60 seconds or less
// (OPENKEY_EXPIRY_TOO_SHORT) and one a signed message cannot carry; both are post-approval refusals, so the cleanup of TC-2363
// applies: no saved code, no key this login created, one notice. Paths that did not send the opt-in keep their --expiry ceiling
// (asserted in paste-logins.expiry.test.ts, auth.portable-proof.test.ts and scoped-login.test.ts).
// Real ProfileManager and real refreshOpenKeySession; only the OpenKey acquisition is simulated.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const recordedErrors: Array<{ code?: string; exitCode?: number; message?: string }> = [];
let pickedLifetimeMs = 0;
let tamper: "none" | "signature" | "no-expiry-line" | "injected-line" | "evil-cid" = "none";
/** After OpenKey answers, the CLI's clock reads this many ms BEHIND the real time (a skewed machine). */
let clockBehindMs = 0;
const EVIL_CID = "bafy\u001b[2J\nRefused nothing. Login OK";
let savedPendingCopies = 0;
/** The Expiration Time and CID of the grant the simulated OpenKey just made (what the owner is told). */
let grantedUntil = "";
let grantedCid = "";
const stderr: string[] = [];

const realBrowserAuth = await import("../auth/browser-auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const otherSigner = new PrivateKeySigner("1111111111111111111111111111111111111111111111111111111111111111");
const OTHER_ADDRESS = "0x000000000000000000000000000000000000dEaD";
let signedByOther = false;
/** Another tool puts a file of its own into the profile directory while the owner is approving. */
let foreignFileDuringAcquisition = false;
const OWNER_DID = `did:pkh:eip155:1:${address}`;
/** A statement that begins with its own `Expiration Time: ` line (the real line follows the statement). */
const injectExpiryLine = (siwe: string): string => {
  const lines = siwe.split("\n");
  lines[3] = `Expiration Time: 1999-01-01T00:00:00.000Z ${lines[3]}`;
  return lines.join("\n");
};

type Permission = { service: string; space: string; path: string; actions: string[] };
const DEFAULT_ABILITIES: Permission[] = [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }];

/** A real owner-signed session for the profile's own key, signing exactly `permissions`, with a lifetime chosen by the test. */
async function proofFor(did: string, jwk: Record<string, unknown>, lifetimeMs: number, permissions: Permission[] = DEFAULT_ABILITIES) {
  const now = Date.now();
  const sign = signedByOther ? otherSigner : signer;
  const signerAddress = signedByOther ? await otherSigner.getAddress() : address;
  const spaceName = permissions[0]!.space.split(":").at(-1)!;
  const spaceId = wasm.makeSpaceId(signerAddress, 1, spaceName);
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of permissions) (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
  const prepared = wasm.prepareSession({
    abilities, address: signerAddress, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + lifetimeMs).toISOString(),
  });
  const signature = await sign.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  grantedUntil = /Expiration Time: (.+)/.exec(prepared.siwe)![1]!;
  grantedCid = session.delegationCid;
  const { d: _private, ...publicJwk } = jwk;
  return {
    ...session, ...(tamper === "evil-cid" ? { delegationCid: EVIL_CID } : {}), jwk: publicJwk, verificationMethod: did, address: signerAddress, chainId: 1,
    spaceId,
    ownerDid: `did:pkh:eip155:1:${signerAddress}`,
    // A result with no readable proof at all: the CLI cannot say until when the grant lasts.
    ...(tamper === "no-expiry-line" ? {} : { siwe: tamper === "injected-line" ? injectExpiryLine(prepared.siwe) : prepared.siwe }),
    signature: tamper === "signature" ? await sign.signMessage("not the message that was approved") : signature,
  };
}

let replaceKeyDuringAcquisition: Record<string, unknown> | undefined;
/** The key changes AFTER the code was redeemed (and its copy saved) but before the commit. */
let replaceKeyAfterRedeem: Record<string, unknown> | undefined;
let sessionDuringAcquisition = false;
/** Sign exactly what the request asks for (an agent grant); otherwise the fixed `DEFAULT_ABILITIES`. */
let signRequest = false;
let observedDuringApproval: { key: string; session: boolean } | undefined;
let savePendingDelegation: typeof import("../auth/pending-code.js").savePendingDelegation;
const acquisitionFlow = async (did: string, options: Record<string, unknown>) => {
  // Another login commits a live session with this key while the owner is still approving.
  if (sessionDuringAcquisition) await ProfileManager.setSession(options.profileName as string, await proofFor(did, options.jwk as Record<string, unknown>, 30 * DAY));
  const delegation = await proofFor(did, options.jwk as Record<string, unknown>, pickedLifetimeMs, signRequest ? options.permissions as Permission[] : undefined);
  observedDuringApproval = {
    key: JSON.stringify(await ProfileManager.getKey(options.profileName as string)),
    session: (await ProfileManager.getSession(options.profileName as string)) !== null,
  };
  // Another login replaces the profile's key while the owner is still approving.
  if (replaceKeyDuringAcquisition !== undefined) await ProfileManager.setKey(options.profileName as string, replaceKeyDuringAcquisition);
  // What the real paste flow does right after it redeems a short code: keep the owner's approval locally, but only when the
  // key it is bound to is the profile's stored key (a key held in memory cannot be resumed).
  const stored = options.profileName === undefined ? null : await ProfileManager.getKey(options.profileName as string) as Record<string, unknown> | null;
  if (stored?.x === (options.jwk as Record<string, unknown>).x && pickedLifetimeMs > 0 && tamper !== "no-expiry-line") {
    await savePendingDelegation(options.profileName as string, "abcd-efgh", delegation as never);
    savedPendingCopies += 1;
  }
  if (replaceKeyAfterRedeem !== undefined) await ProfileManager.setKey(options.profileName as string, replaceKeyAfterRedeem);
  if (foreignFileDuringAcquisition) await writeFile(join(profilePath(profileName), "notes-from-another-tool.txt"), "keep me");
  if (clockBehindMs > 0) setSystemTime(new Date(Date.now() - clockBehindMs));
  return delegation;
};
mock.module("../auth/browser-auth.js", () => ({ ...realBrowserAuth, startAuthFlow: acquisitionFlow }));
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
const outputs: unknown[] = [];
mock.module("../output/formatter.js", () => ({
  operationWarnings: (value: unknown) => (Array.isArray(value) ? value : []),
  outputWarnings: () => {},
  isInteractive: () => false,
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, action: () => Promise<unknown>) => action(),
  outputJson: (value: unknown) => { outputs.push(value); },
  output: () => {},
  formatField: (label: string, value: unknown) => `${label}: ${value}`,
  formatTable: () => "",
}));

const originalHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-refusal-cleanup-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { registerInitCommand, createKeyOnlyProfile } = await import("./init.js");
const { registerOnboardCommand } = await import("./onboard.js");
const { registerAuthCommand, refreshOpenKeySession, ensureDelegationAuthority } = await import("./auth.js");
const { delegationFromInput } = await import("../auth/browser-auth.js");
({ savePendingDelegation } = await import("../auth/pending-code.js"));

const DAY = 86_400_000;
const HOST = "https://node.example.test";
const REVOKE_URL = "https://account.tinycloud.xyz/delegations";
// The exact wordings (no secrets): what the grant is, what happened to its key, and where to revoke it.
const deletedLine = (until: string = grantedUntil) =>
  `OpenKey granted this approval${until === "" ? "" : ` until ${until}`}, but this CLI did not use it and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.`;
const keptLine = (until: string = grantedUntil) =>
  `OpenKey granted this approval${until === "" ? "" : ` until ${until}`} and the key it belongs to still exists on this device (other grants may use it). Revoke it at account.tinycloud.xyz.`;
let profileNumber = 0;
let profileName = "";

beforeEach(async () => {
  recordedErrors.length = 0;
  outputs.length = 0;
  stderr.length = 0;
  savedPendingCopies = 0;
  grantedUntil = "";
  grantedCid = "";
  tamper = "none";
  clockBehindMs = 0;
  signedByOther = false;
  foreignFileDuringAcquisition = false;
  replaceKeyDuringAcquisition = undefined;
  replaceKeyAfterRedeem = undefined;
  signRequest = false;
  sessionDuringAcquisition = false;
  observedDuringApproval = undefined;
  profileName = `refusal-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ ...(await ProfileManager.getConfig()), defaultProfile: "default" });
});
afterEach(() => { setSystemTime(); });
afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const files = (name: string) => ({
  key: existsSync(join(profilePath(name), "key.json")),
  pending: existsSync(join(profilePath(name), "pending-delegation-code.json")),
  session: existsSync(join(profilePath(name), "session.json")),
});
const text = () => stderr.join("");
const lines = (line: string) => text().split("\n").filter((candidate) => candidate === line);
/** Whole-notice assertions: ONE notice per refusal, naming the CID, saying it cannot be revoked here, and where to revoke it. */
const noticeCount = () => text().split("\n").filter((line) => line.includes("OpenKey granted this approval")).length;
function expectOneNotice(kind: "deleted" | "kept", options: { cid?: string; until?: string; rotation?: boolean } = {}): void {
  const until = options.until ?? grantedUntil;
  expect(noticeCount()).toBe(1);
  const notice = text().split("\n").find((line) => line.includes("OpenKey granted this approval"))!;
  // A rotation deletes the NEW key: "its key" would read as the login's key beside "Your current login and its key".
  expect(notice).toContain(kind === "deleted" ? (options.rotation ? deletedLine(until).replace("its key was deleted", "the new key was deleted") : deletedLine(until)) : keptLine(until));
  expect(notice).toContain("cannot revoke it");
  expect(notice).toContain(REVOKE_URL);
  const cid = options.cid ?? grantedCid;
  if (cid === "") expect(notice).not.toContain("Refused delegation:");
  else expect(notice).toContain(`Refused delegation: ${cid}.`);
}
const expectNoNotice = (): void => {
  expect(text()).not.toContain("OpenKey granted this approval");
  expect(text()).not.toContain("Refused delegation:");
  expect(text()).not.toContain(REVOKE_URL);
};
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

describe("plain paste login: the owner's lifetime is accepted as signed, however long", () => {
  for (const [years, lifetimeMs] of [[11, 11 * 365 * DAY], [30, 30 * 365 * DAY]] as const) {
    test(`a ${years} year pick (--expiry 7d) is ACCEPTED and stored as signed: no refusal, no notice, and auth status shows it`, async () => {
      pickedLifetimeMs = lifetimeMs;
      await login("--expiry", "7d");
      expect(recordedErrors).toEqual([]);
      expect(files(profileName)).toMatchObject({ key: true, session: true, pending: false });
      const saved = await ProfileManager.getSession(profileName) as { expiresAt?: string };
      expect(saved.expiresAt).toBe(grantedUntil);
      expect(Date.parse(saved.expiresAt!) - Date.now()).toBeGreaterThan(lifetimeMs - 60_000);
      expectNoNotice();
      outputs.length = 0;
      await runAuth("status");
      expect(outputs.at(-1)).toMatchObject({ authenticated: true, session: { state: "present", expiresAt: grantedUntil } });
    });
  }

  test("a rotation by paste accepts it too: the new session is stored as signed", async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    pickedLifetimeMs = 11 * 365 * DAY;
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(recordedErrors).toEqual([]);
    expect(((await ProfileManager.getSession(profileName)) as { expiresAt?: string }).expiresAt).toBe(grantedUntil);
  });
});

describe("plain paste login: a signed lifetime of 60 seconds or less is still refused, with the TC-2363 cleanup", () => {
  test("a profile this login created: OPENKEY_EXPIRY_TOO_SHORT (exit 5), no saved code, no key, no profile, ONE notice", async () => {
    pickedLifetimeMs = 30_000;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_TOO_SHORT", exitCode: 5 })]);
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(existsSync(profilePath(profileName))).toBe(false);
    expectOneNotice("deleted");
  });

  test("exactly 60 seconds is refused as well (the lifetime must be MORE than 60 s)", async () => {
    pickedLifetimeMs = 60_000;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_TOO_SHORT" })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
  });

  test("a key-only profile that already existed: its key stays, the saved code goes, the kept notice is printed once", async () => {
    await createKeyOnlyProfile(profileName, HOST);
    const before = JSON.stringify(await ProfileManager.getKey(profileName));
    pickedLifetimeMs = 30_000;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_TOO_SHORT" })]);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: false });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before);
    expectOneNotice("kept");
  });

  test("an approval that has already ended is still AUTH_EXPIRED: kept by design, no notice", async () => {
    pickedLifetimeMs = -30_000;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "AUTH_EXPIRED" })]);
    expectNoNotice();
  });
});

const { verifySignedSession } = await import("../auth/scoped-login.js");
describe("the verifier does not crash on a signed expiry a signed message cannot carry", () => {
  const data = {
    siwe: "siwe", signature: "0xsignature", address: "0xowner", chainId: 1, spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
    delegationCid: "bafkreiexample", delegationHeader: { Authorization: "Bearer x" }, verificationMethod: "did:key:example",
  };
  const withExpiry = (expiresAt: string) => {
    const spy = spyOn(NodeWasmBindings.prototype, "validatePersistedSession").mockImplementation((() => ({
      verifiedRecap: [{ service: "kv", space: data.spaceId, path: "", actions: ["tinycloud.kv/get"] }], expiresAt,
    })) as never);
    try { return verifySignedSession(data, { kty: "OKP" }, "did:key:example", { expiryChangeable: true }); } finally { spy.mockRestore(); }
  };

  test("year 10000 written as +010000: a clear OPENKEY_EXPIRY_UNREPRESENTABLE naming the latest date, not a RangeError", () => {
    expect(() => withExpiry("+010000-01-01T00:00:00.000Z")).toThrow(expect.objectContaining({
      code: "OPENKEY_EXPIRY_UNREPRESENTABLE", message: expect.stringContaining("9999-12-31"),
    }));
  });

  test("a five-digit year written plainly, and one past the Date range: a CLIError refusal, never a RangeError", () => {
    for (const expiresAt of ["10000-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "+999999-01-01T00:00:00.000Z"]) {
      let thrown: unknown;
      try { withExpiry(expiresAt); } catch (error) { thrown = error; }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect(thrown).toMatchObject({ code: expect.stringMatching(/^OPENKEY_/) });
    }
  });

  test("the last signable instant is accepted", () => {
    expect(withExpiry("9999-12-31T23:59:59.000Z").expiresAt).toBe("9999-12-31T23:59:59.000Z");
  });
});
