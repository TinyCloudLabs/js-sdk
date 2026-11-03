// TC-2412: `auth rotate` cannot revoke the OpenKey login delegation it replaces (a login's approved set carries no
// `tinycloud.delegation/revoke`, TC-2308), so the previous sign-in stays live on the node until it expires. After a SUCCESSFUL
// rotation that replaced a live session, the CLI says so ONCE on stderr: which sign-in (when its CID is known), until when, and
// where to revoke it. Never on a first login, a refused or failed rotation (the refusal notice covers it), or a logout.
// stdout, the JSON and the exit code do not change. Real ProfileManager and real refreshOpenKeySession; only the OpenKey
// acquisition is simulated, as in refusal-cleanup.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const recordedErrors: Array<{ code?: string; exitCode?: number; message?: string }> = [];
let pickedLifetimeMs = 6 * 86_400_000;
let signedByOther = false;
let tamperSignature = false;
/** The Expiration Time and CID of the grant the simulated OpenKey made LAST. */
let grantedUntil = "";
let grantedCid = "";
const stderr: string[] = [];

const realBrowserAuth = await import("../auth/browser-auth.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const otherSigner = new PrivateKeySigner("1111111111111111111111111111111111111111111111111111111111111111");

const DEFAULT_ABILITIES = [{ service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }];

/** A real owner-signed session for the profile's own key, with a lifetime chosen by the test. */
async function proofFor(did: string, jwk: Record<string, unknown>, lifetimeMs: number) {
  const now = Date.now();
  const sign = signedByOther ? otherSigner : signer;
  const signerAddress = signedByOther ? await otherSigner.getAddress() : address;
  const spaceId = wasm.makeSpaceId(signerAddress, 1, "default");
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": DEFAULT_ABILITIES[0]!.actions } }, address: signerAddress, chainId: 1, domain: "cli.example.test", spaceId, jwk,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + lifetimeMs).toISOString(),
  });
  const signature = await sign.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  grantedUntil = new Date(/Expiration Time: (.+)/.exec(prepared.siwe)![1]!).toISOString();
  grantedCid = session.delegationCid;
  const { d: _private, ...publicJwk } = jwk;
  return {
    ...session, jwk: publicJwk, verificationMethod: did, address: signerAddress, chainId: 1, spaceId,
    ownerDid: `did:pkh:eip155:1:${signerAddress}`,
    siwe: prepared.siwe,
    signature: tamperSignature ? await sign.signMessage("not the message that was approved") : signature,
  };
}

const acquisitionFlow = async (did: string, options: Record<string, unknown>) =>
  proofFor(did, options.jwk as Record<string, unknown>, pickedLifetimeMs);
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
const home = await mkdtemp(join(tmpdir(), "tc-rotate-previous-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { registerAuthCommand } = await import("./auth.js");

const DAY = 86_400_000;
const REVOKE_URL = "https://account.tinycloud.xyz/delegations";
let profileNumber = 0;
let profileName = "";

beforeEach(async () => {
  recordedErrors.length = 0;
  outputs.length = 0;
  stderr.length = 0;
  grantedUntil = "";
  grantedCid = "";
  signedByOther = false;
  tamperSignature = false;
  pickedLifetimeMs = 6 * DAY;
  profileName = `rotate-previous-${++profileNumber}`;
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setConfig({ ...(await ProfileManager.getConfig()), defaultProfile: "default" });
});
afterEach(() => { setSystemTime(); });
afterAll(async () => {
  if (originalHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const text = () => stderr.join("");
/** The one sentence, exactly as the owner reads it. */
const sentence = (cid: string | undefined, until: string): string =>
  `The previous sign-in${cid === undefined ? "" : ` (${cid})`} stays live until ${until} because this CLI cannot revoke it; revoke it at ${REVOKE_URL}.`;
const noticeLines = () => text().split("\n").filter((line) => line.includes("The previous sign-in"));
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
const login = () => runAuth("login", "--method", "openkey", "--paste", "--no-popup", "--expiry", "7d");
const ROTATE_FLOWS: Array<[string, string[]]> = [
  ["paste", ["rotate", "--paste", "--no-popup", "--force"]],
  ["request", ["rotate", "--no-popup", "--force"]],
];

/** A signed-in profile; returns the sign-in a rotation will replace, and clears what the setup wrote to stderr. */
async function signedIn(): Promise<{ cid: string; until: string }> {
  await login();
  expect(recordedErrors).toEqual([]);
  const old = { cid: grantedCid, until: grantedUntil };
  expect(old.cid).not.toBe("");
  stderr.length = 0;
  outputs.length = 0;
  return old;
}
/** Rewrite the stored session (what an older release, or another tool, may have left). */
async function editSession(change: (session: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await ProfileManager.setSession(profileName, change({ ...(await ProfileManager.getSession(profileName) as Record<string, unknown>) }));
}

for (const [flow, args] of ROTATE_FLOWS) {
  describe(`tc auth rotate (${flow} flow): the previous sign-in stays live, and the owner is told`, () => {
    test("a successful rotation that replaced a live session prints ONE notice: the old CID and the old expiry, not the new ones", async () => {
      const old = await signedIn();
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(grantedCid).not.toBe(old.cid);
      expect(grantedUntil).not.toBe(old.until);
      expect(noticeLines()).toEqual([sentence(old.cid, old.until)]);
      // Nothing else is written to stderr, and nothing of the NEW grant is in the notice.
      expect(text()).toBe(`${sentence(old.cid, old.until)}\n`);
      expect(text()).not.toContain(grantedCid);
      expect(text()).not.toContain(grantedUntil);
    });

    test("stdout (the JSON) and the saved state are those of a rotation without the notice: exit unchanged, new key and session saved", async () => {
      const old = await signedIn();
      const oldDid = (await ProfileManager.getProfile(profileName)).did;
      const keyBefore = JSON.stringify(await ProfileManager.getKey(profileName));
      await runAuth(...args);
      const profile = await ProfileManager.getProfile(profileName);
      expect(recordedErrors).toEqual([]);
      expect(outputs).toEqual([{
        rotated: true, profile: profileName, oldDid, did: profile.did, sessionDid: profile.sessionDid ?? null,
        authMethod: "openkey", spaceId: profile.spaceId ?? null,
      }]);
      expect(JSON.stringify(await ProfileManager.getKey(profileName))).not.toBe(keyBefore);
      expect(((await ProfileManager.getSession(profileName)) as Record<string, unknown>).delegationCid).toBe(grantedCid);
      expect(noticeLines()).toHaveLength(1);
      expect(old.cid).not.toBe(grantedCid);
    });

    test("OPENKEY_OWNER_MISMATCH (a refused rotation): only the refusal notice, never the previous-sign-in notice; the old session stays", async () => {
      await signedIn();
      const sessionBefore = JSON.stringify(await ProfileManager.getSession(profileName));
      signedByOther = true;
      await runAuth(...args);
      expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_OWNER_MISMATCH", exitCode: 5 })]);
      expect(text()).toContain("OpenKey granted this approval");
      expect(noticeLines()).toEqual([]);
      expect(JSON.stringify(await ProfileManager.getSession(profileName))).toBe(sessionBefore);
    });

    test("OPENKEY_PROOF_INVALID (a refused rotation): no previous-sign-in notice", async () => {
      await signedIn();
      tamperSignature = true;
      await runAuth(...args);
      expect(recordedErrors).toEqual([expect.objectContaining({ code: "OPENKEY_PROOF_INVALID" })]);
      expect(noticeLines()).toEqual([]);
    });

    test("a profile with a key but no previous session: nothing was replaced, no notice", async () => {
      await signedIn();
      await ProfileManager.clearSession(profileName);
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(outputs).toEqual([expect.objectContaining({ rotated: true })]);
      expect(text()).toBe("");
    });

    test("the previous sign-in already ended: nothing stays live, no notice", async () => {
      await signedIn();
      setSystemTime(new Date(Date.now() + 7 * DAY));
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(outputs).toEqual([expect.objectContaining({ rotated: true })]);
      expect(text()).toBe("");
    });

    test("a previous session whose owner was never verified (no signed proof): no notice", async () => {
      await signedIn();
      await editSession(({ siwe: _siwe, signature: _signature, ...rest }) => rest);
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(text()).toBe("");
    });

    test("a previous session that holds no delegation (no CID, no delegation header): nothing is known to stay live, no notice", async () => {
      await signedIn();
      await editSession(({ delegationCid: _cid, delegationHeader: _header, ...rest }) => rest);
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(text()).toBe("");
    });

    test("no CID stored: the same sentence without the CID part, with the date", async () => {
      const old = await signedIn();
      await editSession(({ delegationCid: _cid, ...rest }) => rest);
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(text()).toBe(`The previous sign-in stays live until ${old.until} because this CLI cannot revoke it; revoke it at ${REVOKE_URL}.\n`);
    });

    test("no expiry readable: `until it expires`, with the CID", async () => {
      const old = await signedIn();
      await editSession(({ expiresAt: _a, expiry: _b, expirationTime: _c, siwe, ...rest }) => ({
        ...rest, siwe: String(siwe).replace(/^Expiration Time: .*$/m, "Resources:"),
      }));
      await runAuth(...args);
      expect(recordedErrors).toEqual([]);
      expect(text()).toBe(`The previous sign-in (${old.cid}) stays live until it expires because this CLI cannot revoke it; revoke it at ${REVOKE_URL}.\n`);
    });

    for (const hostile of ["bafy\u001b[2J\nRefused nothing. Login OK", "short", "has-dash-in-it-12345678", `a${"b".repeat(128)}`, "\u001b[31mred\u001b[0m"]) {
      test(`a stored CID that is not a CID (${JSON.stringify(hostile).slice(0, 24)}) is omitted: one line, no control characters`, async () => {
        const old = await signedIn();
        await editSession((session) => ({ ...session, delegationCid: hostile }));
        await runAuth(...args);
        expect(recordedErrors).toEqual([]);
        expect(text()).toBe(`The previous sign-in stays live until ${old.until} because this CLI cannot revoke it; revoke it at ${REVOKE_URL}.\n`);
        // eslint-disable-next-line no-control-regex
        expect(text().replace(/\n$/, "")).not.toMatch(/[\u0000-\u001f\u007f]/);
      });
    }
  });
}

describe("the notice is only for a rotation that replaced a previous sign-in", () => {
  test("a FIRST login prints no notice", async () => {
    await login();
    expect(recordedErrors).toEqual([]);
    expect(await ProfileManager.getSession(profileName)).not.toBeNull();
    // The first login says whose profile this is (an existing notice); it says nothing of a previous sign-in.
    expect(noticeLines()).toEqual([]);
    expect(text()).not.toContain(REVOKE_URL);
  });

  test("a login that renews a live session of the same profile is not a rotation: no notice", async () => {
    await signedIn();
    await login();
    expect(noticeLines()).toEqual([]);
  });

  test("auth logout prints no notice (a separate concern)", async () => {
    await signedIn();
    await runAuth("logout", "--force");
    expect(recordedErrors).toEqual([]);
    expect(noticeLines()).toEqual([]);
  });
});
