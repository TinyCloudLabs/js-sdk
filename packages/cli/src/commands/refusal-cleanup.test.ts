// TC-2363: OpenKey creates the delegation to the profile's key BEFORE the CLI verifies it. When the CLI then refuses the
// signed message (wrong owner, scope, bad proof, an expiry above --expiry ...) that grant is LIVE, so a PERMANENT refusal:
//   - deletes the saved copy of the pasted code;
//   - deletes the key IF THIS SIGN-IN CREATED IT (a profile this login created, or a key held only in memory), keeps a key that
//     already existed (other grants or sessions use it);
//   - tells the owner, once and in plain words, which delegation it was, until when it is live, and where to revoke it.
// `auth rotate` stages its new key in memory: a refused rotation keeps the old key and the old login untouched.
// Refusals the resume design keeps on purpose (AUTH_EXPIRED, SESSION_IN_USE, PROFILE_CHANGED_DURING_LOGIN) change nothing.
// Real ProfileManager and real refreshOpenKeySession / ensureDelegationAuthority; only the OpenKey acquisition is simulated
// (it also saves the redeemed code's local copy, as the real paste flow does when the key it is bound to is stored).

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
function expectOneNotice(kind: "deleted" | "kept", options: { cid?: string; until?: string } = {}): void {
  const until = options.until ?? grantedUntil;
  expect(noticeCount()).toBe(1);
  const notice = text().split("\n").find((line) => line.includes("OpenKey granted this approval"))!;
  expect(notice).toContain(kind === "deleted" ? deletedLine(until) : keptLine(until));
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

// [refusal code, its exit code (unchanged), how the signed result is made refusable, extra login args]
const REFUSALS: Array<[string, number, () => void, string[]]> = [
  ["OPENKEY_PROOF_INVALID", 3, () => { pickedLifetimeMs = 7 * DAY; tamper = "signature"; }, ["--expiry", "7d"]],
  ["OPENKEY_OWNER_MISMATCH", 5, () => { pickedLifetimeMs = 6 * DAY; }, ["--expiry", "7d", "--owner", `did:pkh:eip155:1:${OTHER_ADDRESS}`]],
  ["OPENKEY_EXPIRY_EXCEEDED", 5, () => { pickedLifetimeMs = 6 * DAY; }, ["--expiry", "1d"]],
];

describe("tc auth login --paste: the profile and its key were created by this login, so a permanent refusal deletes them", () => {
  for (const [code, exitCode, arrange, extra] of REFUSALS) {
    test(`${code}: no key, no saved approval, no session, no profile; one dated deleted notice with the CID; exit ${exitCode}`, async () => {
      arrange();
      await login(...extra);
      expect(recordedErrors).toEqual([expect.objectContaining({ code, exitCode })]);
      expect(savedPendingCopies).toBe(1);
      expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
      expect(await ProfileManager.profileExists(profileName)).toBe(false);
      expect(await ProfileManager.getKey(profileName)).toBeNull();
      expect(grantedUntil).not.toBe("");
      expectOneNotice("deleted");
      expect(lines(keptLine())).toHaveLength(0);
      // The default profile is what it was before this login created (and removed) the profile.
      expect((await ProfileManager.getConfig()).defaultProfile).toBe("default");
    });
  }

  test("a result with no readable expiry: the notice says the grant was made, with no date", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "no-expiry-line";
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expectOneNotice("deleted", { until: "" });
    expect(text()).not.toContain(" until ");
  });

  test("the date is the result's own last Expiration Time line: an earlier line inside the statement does not stand in for it", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "injected-line";
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(grantedUntil).not.toBe("");
    expectOneNotice("deleted");
    expect(text()).not.toContain("1999");
  });

  test("a SUCCESSFUL paste login still keeps its key and session, and prints no notice", async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([]);
    expect(files(profileName)).toMatchObject({ key: true, session: true });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expect(files(profileName).pending).toBe(false);
    expectNoNotice();
  });
});

describe("tc init --paste: the profile and its key were created by this command, so a permanent refusal deletes them", () => {
  test("OPENKEY_PROOF_INVALID: no key, no saved approval, no profile; the dated deleted notice once", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    const program = new Command();
    program.option("-p, --profile <name>");
    registerInitCommand(program);
    await capturing(() => program.parseAsync(["node", "tc", "init", "--name", profileName, "--host", HOST, "--paste"], { from: "node" }));
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(false);
    expectOneNotice("deleted");
    expect((await ProfileManager.getConfig()).defaultProfile).toBe("default");
  });
});

describe("a profile this command created and removed leaves no directory and no listing", () => {
  const gone = async (name: string) => {
    expect(existsSync(profilePath(name)) ? readdirSync(profilePath(name)) : "no directory").toBe("no directory");
    expect(readdirSync(dirname(profilePath(name)))).not.toContain(name);
    expect(await ProfileManager.profileExists(name)).toBe(false);
  };

  test("auth login --paste, refused: the profile directory is gone and it is not listed", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    await gone(profileName);
  });

  test("init --paste, refused: same", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    const program = new Command();
    program.option("-p, --profile <name>");
    registerInitCommand(program);
    await capturing(() => program.parseAsync(["node", "tc", "init", "--name", profileName, "--host", HOST, "--paste"], { from: "node" }));
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    await gone(profileName);
  });

  test("onboard, refused: same", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    const program = new Command();
    program.option("-p, --profile <name>");
    registerOnboardCommand(program);
    await capturing(() => program.parseAsync(["node", "tc", "--profile", profileName, "onboard"], { from: "node" }));
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    await gone(profileName);
  });

  test("a profile that already existed (init --key-only, then a refused login) is NOT touched: directory, key and listing stay", async () => {
    await createKeyOnlyProfile(profileName, HOST);
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(existsSync(profilePath(profileName))).toBe(true);
    expect(readdirSync(dirname(profilePath(profileName)))).toContain(profileName);
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expect(files(profileName)).toMatchObject({ key: true });
  });

  test("a directory another tool put a file into meanwhile is left alone: only an empty directory is removed", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    foreignFileDuringAcquisition = true;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(readdirSync(profilePath(profileName)).filter((entry) => !entry.startsWith("."))).toEqual(["notes-from-another-tool.txt"]);
  });
});

describe("a signed lifetime that only exceeds the ceiling because the CLI's clock is behind is NOT a permanent refusal", () => {
  // OpenKey signs Issued At + the requested lifetime. The CLI's ceiling is its own clock + the lifetime + 30 s, so a clock 2 minutes
  // behind makes a default-lifetime approval look too long. Nothing in the approval itself is wrong: the saved approval stays.
  test("clock 2 min behind, lifetime exactly as requested: OPENKEY_EXPIRY_EXCEEDED, but the saved code, key, profile stay and no notice is printed", async () => {
    pickedLifetimeMs = DAY - 60_000; // the proof's Issued At is 60 s before it was made: Expiration = Issued At + 1 day
    clockBehindMs = 120_000;
    await login("--expiry", "1d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(files(profileName)).toMatchObject({ key: true, pending: true, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expectNoNotice();
  });

  test("the same clock, but a lifetime really above the request (6 days for 1 day): still permanent: cleaned up and announced", async () => {
    pickedLifetimeMs = 6 * DAY;
    clockBehindMs = 120_000;
    await login("--expiry", "1d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expectOneNotice("deleted");
  });
});

describe("the notice prints a CID only when it looks like one", () => {
  test("a result-supplied CID with an escape sequence and a newline prints no control character and no forged line", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "evil-cid";
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(noticeCount()).toBe(1);
    // eslint-disable-next-line no-control-regex
    expect(text()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(text().split("\n").some((line) => line.startsWith("Refused nothing"))).toBe(false);
    expect(text()).not.toContain("Refused delegation:");
    expect(text()).toContain(deletedLine());
  });

  test("dropCommittedDelegation ignores a CID that is not a CID: a record keyed on it stays", async () => {
    const { dropCommittedDelegation, pendingDelegationFor } = await import("../auth/pending-code.js");
    await createKeyOnlyProfile(profileName, HOST);
    const { generateKey } = await import("../auth/local-key.js");
    const sessionKey = (await generateKey()).jwk as Record<string, unknown>;
    pickedLifetimeMs = 7 * DAY;
    const odd = { ...(await proofFor("did:key:x", sessionKey, pickedLifetimeMs)), delegationCid: "not a cid\n" };
    await savePendingDelegation(profileName, "abcd-efgh", odd as never);
    await dropCommittedDelegation(profileName, { delegationCid: "not a cid\n" });
    expect(await pendingDelegationFor(profileName, "abcd-efgh")).toBeDefined();
    const real = await proofFor("did:key:x", sessionKey, pickedLifetimeMs);
    await savePendingDelegation(profileName, "wxyz-2345", real as never);
    await dropCommittedDelegation(profileName, { delegationCid: real.delegationCid });
    expect(await pendingDelegationFor(profileName, "wxyz-2345")).toBeUndefined();
  });
});

describe("tc onboard: the profile and its key were created by this command, so a permanent refusal deletes them", () => {
  test("OPENKEY_PROOF_INVALID: no key, no saved approval, no profile; the dated deleted notice once; the default profile is restored", async () => {
    pickedLifetimeMs = 7 * DAY;
    tamper = "signature";
    const program = new Command();
    program.option("-p, --profile <name>");
    registerOnboardCommand(program);
    await capturing(() => program.parseAsync(["node", "tc", "--profile", profileName, "onboard"], { from: "node" }));
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(files(profileName)).toEqual({ key: false, pending: false, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(false);
    expectOneNotice("deleted");
    expect((await ProfileManager.getConfig()).defaultProfile).toBe("default");
  });
});

describe("a key that ALREADY EXISTED (a profile this login did not create) is kept; only the saved approval goes", () => {
  test("a key-only profile, OPENKEY_EXPIRY_EXCEEDED: key, profile and no-session state stay, the kept notice is printed once", async () => {
    await createKeyOnlyProfile(profileName, HOST);
    const before = JSON.stringify(await ProfileManager.getKey(profileName));
    pickedLifetimeMs = 30 * DAY;
    await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, expiry: "7d" }))).rejects.toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 });
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: false });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before);
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expectOneNotice("kept");
    expect(lines(deletedLine())).toHaveLength(0);
  });

  for (const [code, scope] of [
    ["OPENKEY_GRANT_BROADENED", { service: "tinycloud.kv", space: "default", path: "example/", actions: ["tinycloud.kv/get"] }],
    ["OPENKEY_SCOPE_MISMATCH", { service: "tinycloud.kv", space: "other", path: "", actions: ["tinycloud.kv/get"] }],
  ] as const) {
    test(`a scoped (--manifest) login: ${code}: the key stays, the saved approval goes, one kept notice`, async () => {
      await createKeyOnlyProfile(profileName, HOST);
      pickedLifetimeMs = 6 * DAY;
      await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, expiry: "7d", permissions: [scope as never] }))).rejects.toMatchObject({ code });
      expect(files(profileName)).toEqual({ key: true, pending: false, session: false });
      expectOneNotice("kept");
      expect(lines(deletedLine())).toHaveLength(0);
    });
  }
});

describe("a key another login replaced while this approval was pending is not this login's to delete", () => {
  test("the profile created by this login keeps the key that is there now, the saved approval goes, the kept notice is printed once", async () => {
    pickedLifetimeMs = 6 * DAY;
    const { generateKey } = await import("../auth/local-key.js");
    const other = (await generateKey()).jwk as Record<string, unknown>;
    replaceKeyDuringAcquisition = other;
    await login("--expiry", "1d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED" })]);
    expect(((await ProfileManager.getKey(profileName)) as Record<string, unknown>).x).toBe(other.x);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: false });
    expectOneNotice("kept");
  });

  test("a session another login committed with this key while the approval was pending keeps it: the profile and key stay", async () => {
    pickedLifetimeMs = 6 * DAY;
    sessionDuringAcquisition = true;
    await login("--expiry", "1d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED" })]);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expectOneNotice("kept");
  });
});

describe("a profile with a LIVE session: its existing key is kept, byte for byte", () => {
  test("a permanent refusal keeps the key and the session, drops the saved approval, and prints one kept notice", async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([]);
    const before = { key: JSON.stringify(await ProfileManager.getKey(profileName)), session: JSON.stringify(await ProfileManager.getSession(profileName)) };
    stderr.length = 0;
    savedPendingCopies = 0;
    pickedLifetimeMs = 30 * DAY;
    await login("--expiry", "7d", "--replace-session");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_EXPIRY_EXCEEDED", exitCode: 5 })]);
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
    expectOneNotice("kept");
  });
});

describe("refusals the resume design keeps ON PURPOSE change nothing and print no notice", () => {
  test("AUTH_EXPIRED (the approved session already ended): the profile and key this login created stay, no notice", async () => {
    pickedLifetimeMs = -30_000;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "AUTH_EXPIRED", exitCode: 3 })]);
    expect(files(profileName)).toMatchObject({ key: true, session: false });
    expect(await ProfileManager.profileExists(profileName)).toBe(true);
    expectNoNotice();
  });

  test("SESSION_IN_USE at the commit: the saved approval is KEPT to finish with the same code, key and session stay, no notice", async () => {
    const scope = [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }] as never;
    await createKeyOnlyProfile(profileName, HOST);
    pickedLifetimeMs = 6 * DAY;
    await capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, expiry: "7d", permissions: scope }));
    const before = { key: JSON.stringify(await ProfileManager.getKey(profileName)), session: JSON.stringify(await ProfileManager.getSession(profileName)) };
    stderr.length = 0;
    savedPendingCopies = 0;
    pickedLifetimeMs = 60 * 60_000;
    await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, expiry: "7d", permissions: scope }))).rejects.toMatchObject({ code: "SESSION_IN_USE" });
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toEqual({ key: true, pending: true, session: true });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
    expectNoNotice();
  });

  test("PROFILE_CHANGED_DURING_LOGIN (the key was replaced meanwhile): the saved approval is KEPT, the other key stays, no notice", async () => {
    pickedLifetimeMs = 6 * DAY;
    const { generateKey } = await import("../auth/local-key.js");
    const other = (await generateKey()).jwk as Record<string, unknown>;
    await createKeyOnlyProfile(profileName, HOST);
    replaceKeyAfterRedeem = other;
    await expect(capturing(() => refreshOpenKeySession(profileName, HOST, { paste: true, expiry: "7d" }))).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect(files(profileName)).toMatchObject({ key: true, pending: true, session: false });
    expect(((await ProfileManager.getKey(profileName)) as Record<string, unknown>).x).toBe(other.x);
    expectNoNotice();
  });
});

describe("tc auth rotate --paste: the new key is staged in memory, so a refused rotation keeps the old login", () => {
  const signedIn = async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([]);
    const before = {
      key: JSON.stringify(await ProfileManager.getKey(profileName)),
      session: JSON.stringify(await ProfileManager.getSession(profileName)),
      profile: JSON.stringify(await ProfileManager.getProfile(profileName)),
    };
    stderr.length = 0;
    savedPendingCopies = 0;
    return before;
  };

  test("while the owner is still approving, the old key and the old session are untouched", async () => {
    const before = await signedIn();
    pickedLifetimeMs = 6 * DAY;
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(observedDuringApproval).toEqual({ key: before.key, session: true });
  });

  // `rotate` pins the owner the profile already has; it has no --expiry, so the owner family is a result signed by another account.
  const ROTATE_REFUSALS: Array<[string, number, () => void]> = [
    ["OPENKEY_PROOF_INVALID", 3, () => { tamper = "signature"; }],
    ["OPENKEY_OWNER_MISMATCH", 5, () => { signedByOther = true; }],
  ];
  for (const [code, exitCode, arrange] of ROTATE_REFUSALS) {
    test(`${code}: the old key, session and profile stay byte for byte, no new key on disk, no saved approval, one deleted notice`, async () => {
      const before = await signedIn();
      pickedLifetimeMs = 6 * DAY;
      arrange();
      await runAuth("rotate", "--paste", "--no-popup", "--force");
      expect(recordedErrors).toEqual([expect.objectContaining({ code, exitCode })]);
      expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
      expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
      expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
      expect(JSON.stringify(await ProfileManager.getProfile(profileName))).toBe(before.profile);
      expectOneNotice("deleted");
    });
  }

  test("a refused rotation's notice says the current login and its key are unchanged; a refused FRESH login's notice does not", async () => {
    await signedIn();
    pickedLifetimeMs = 6 * DAY;
    tamper = "signature";
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    const notice = text().split("\n").find((line) => line.includes("OpenKey granted this approval"))!;
    expect(notice).toContain(`${deletedLine()} Your current login and its key are unchanged. This CLI cannot revoke it`);
    // A fresh login that was refused owns the key it made: nothing of a "current login" to speak of.
    recordedErrors.length = 0;
    stderr.length = 0;
    profileName = `refusal-fresh-${++profileNumber}`;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expectOneNotice("deleted");
    expect(text()).not.toContain("Your current login");
  });

  test("a refused rotation of a profile whose session is not usable still leaves the old key where it was", async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    const keyBefore = JSON.stringify(await ProfileManager.getKey(profileName));
    await ProfileManager.clearSession(profileName);
    tamper = "signature";
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(keyBefore);
  });

  test("a SUCCESSFUL rotation is unchanged: new key, new session, new DID, the same output", async () => {
    const before = await signedIn();
    const oldDid = (await ProfileManager.getProfile(profileName)).did;
    pickedLifetimeMs = 6 * DAY;
    await runAuth("rotate", "--paste", "--no-popup", "--force");
    expect(recordedErrors).toEqual([]);
    const profile = await ProfileManager.getProfile(profileName);
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).not.toBe(before.key);
    expect(profile.did).not.toBe(oldDid);
    expect(profile.sessionDid).toBe(profile.did);
    expect(profile.authMethod).toBe("openkey");
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).not.toBe(before.session);
    expect(outputs.at(-1)).toMatchObject({ rotated: true, profile: profileName, oldDid, did: profile.did, authMethod: "openkey" });
    expectNoNotice();
  });
});

describe("ensureDelegationAuthority: a refused approval of an established profile", () => {
  beforeEach(() => { signRequest = true; });
  const owned = async () => {
    await createKeyOnlyProfile(profileName, HOST);
    const profile = { ...(await ProfileManager.getProfile(profileName)), authMethod: "openkey" as const, ownerDid: OWNER_DID, posture: "owner-openkey" as const };
    await ProfileManager.setProfile(profileName, profile);
    return profile;
  };
  const node = { hasRuntimePermissions: () => false, useRuntimeDelegation: async () => { throw new Error("nothing may be activated"); } } as never;
  const request = (space: string, path = ""): Permission => ({ service: "tinycloud.kv", space, path, actions: ["tinycloud.kv/get"] });
  const grantedFiles = (name: string) => existsSync(join(profilePath(name), "additional-delegations.json"));
  const ensure = (profile: Parameters<typeof ensureDelegationAuthority>[0]["profile"], requested: Permission[], extra: Record<string, unknown> = {}) =>
    capturing(() => ensureDelegationAuthority({
      ctx: { profile: profileName, host: HOST }, profile, node, requested: requested as never, expiryOption: "7d", reason: "test",
      yes: true, consentAlreadyGiven: true, openKeyAcquisition: acquisitionFlow as never, ...extra,
    }));

  test("OPENKEY_OWNER_MISMATCH: the saved approval goes, the existing key stays, one kept notice names the CID, nothing is stored", async () => {
    const profile = await owned();
    await ProfileManager.setProfile(profileName, { ...profile, ownerDid: `did:pkh:eip155:1:${OTHER_ADDRESS}` });
    const before = JSON.stringify(await ProfileManager.getKey(profileName));
    pickedLifetimeMs = 6 * DAY;
    await expect(ensure(await ProfileManager.getProfile(profileName), [request("default")])).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expect(savedPendingCopies).toBe(1);
    expect(files(profileName)).toMatchObject({ key: true, pending: false });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before);
    expect(grantedFiles(profileName)).toBe(false);
    expectOneNotice("kept");
  });

  test("OPENKEY_APPROVAL_NARROWER (--exact approval): refused, the saved approval goes, one kept notice", async () => {
    const profile = await owned();
    pickedLifetimeMs = 6 * DAY;
    // The owner approved `get` only; the request asked for `get` and `list`.
    const refusedAcquisition = (did: string, options: Record<string, unknown>) =>
      acquisitionFlow(did, { ...options, permissions: (options.permissions as Permission[]).map((permission) =>
        permission.service === "tinycloud.kv" ? { ...permission, actions: ["tinycloud.kv/get"] } : permission) });
    await expect(ensure(profile, [{ ...request("default"), actions: ["tinycloud.kv/get", "tinycloud.kv/list"] }],
      { exactApproval: true, openKeyAcquisition: refusedAcquisition })).rejects.toMatchObject({ code: "OPENKEY_APPROVAL_NARROWER" });
    expect(files(profileName)).toMatchObject({ key: true, pending: false });
    expect(grantedFiles(profileName)).toBe(false);
    expectOneNotice("kept");
  });

  test("a SECOND space refused after the first was approved: nothing is stored, ONE notice (for the refused delegation only)", async () => {
    const profile = await owned();
    pickedLifetimeMs = 6 * DAY;
    let approvals = 0;
    const secondRefused = async (did: string, options: Record<string, unknown>) => {
      approvals += 1;
      tamper = approvals === 2 ? "signature" : "none";
      return acquisitionFlow(did, options);
    };
    await expect(ensure(profile, [request("default"), request("applications")], { openKeyAcquisition: secondRefused as never }))
      .rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    expect(approvals).toBe(2);
    expect(grantedFiles(profileName)).toBe(false);
    expect(noticeCount()).toBe(1);
    expect(text()).toContain(`Refused delegation: ${grantedCid}.`);
    expect(text()).toContain(REVOKE_URL);
  });

  test("a one-use approval (persist: false): refused, one kept notice, nothing is activated", async () => {
    const profile = await owned();
    pickedLifetimeMs = 6 * DAY;
    tamper = "signature";
    await expect(ensure(profile, [request("default")], { persist: false })).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    expect(files(profileName)).toMatchObject({ key: true, pending: false });
    expectOneNotice("kept");
  });

  test("a refusal raised BEFORE any approval exists grants nothing: no notice, nothing dropped", async () => {
    const profile = await owned();
    const { CLIError } = await import("../output/errors.js");
    const early = async () => { throw new CLIError("OPENKEY_OWNER_MISMATCH", "refused before the owner approved anything", 5); };
    await expect(ensure(profile, [request("default")], { openKeyAcquisition: early as never })).rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expectNoNotice();
  });

  test("AUTH_EXPIRED stays by design: no notice, the existing key stays", async () => {
    const profile = await owned();
    pickedLifetimeMs = -30_000;
    await expect(ensure(profile, [request("default")])).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(files(profileName)).toMatchObject({ key: true });
    expectNoNotice();
  });
});

describe("tc auth request --grant: a refused approval", () => {
  test("the saved approval goes, the signed-in key and session stay, one kept notice", async () => {
    pickedLifetimeMs = 6 * DAY;
    await login("--expiry", "7d");
    expect(recordedErrors).toEqual([]);
    const before = { key: JSON.stringify(await ProfileManager.getKey(profileName)), session: JSON.stringify(await ProfileManager.getSession(profileName)) };
    stderr.length = 0;
    savedPendingCopies = 0;
    signRequest = false; // the owner signs the default read, not the list that was asked for
    await runAuth("request", "--grant", "--paste", "--no-popup", "--cap", "tinycloud.kv:default:data/KEY:list", "--yes");
    expect(recordedErrors).toEqual([expect.objectContaining({ code: expect.stringMatching(/^OPENKEY_(GRANT_BROADENED|APPROVAL_NARROWER|SCOPE_MISMATCH)$/) })]);
    expect(files(profileName)).toEqual({ key: true, pending: false, session: true });
    expect(JSON.stringify(await ProfileManager.getKey(profileName))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(before.session);
    expectOneNotice("kept");
  });
});

describe("a refused short code no longer tells the owner to re-run with the same code", () => {
  test("a 404 on a code OpenKey no longer has says to approve again, never to paste the same code", async () => {
    const original = globalThis.fetch;
    const send = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 404 }), { preconnect: original.preconnect }) as never);
    try {
      const { generateKey } = await import("../auth/local-key.js");
      const key = (await generateKey()).jwk as Record<string, unknown>;
      const error = await delegationFromInput("abcd-efgh", "did:key:example", { jwk: key, profileName: undefined }).catch((caught: Error) => caught);
      expect(error).toMatchObject({ status: 404 });
      expect((error as Error).message).toContain("not found or expired");
      expect((error as Error).message).toMatch(/approve again in OpenKey/i);
      expect((error as Error).message).not.toMatch(/re-run|paste the same code|same command/i);
    } finally {
      send.mockRestore();
    }
  });
});
