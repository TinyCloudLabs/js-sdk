import { afterAll, afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { openLinkRecord, parseLink, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

// TC-4247: renewal is on by default for onboarding. OpenKey starts its renewal box ticked only when the signed approval
// request carries top-level `purpose: "standing"`; a request without one is a task and starts unticked. These tests run
// the real `onboard` command and the real sign-in down to the signed request the CLI posts to the links API, then open
// that record with the key in the approval link. Synthetic owner, keys and hosts only: the links API is a fetch stub and
// every other network call is refused. `--timeout` (an approval wait) makes the flow stop with APPROVAL_PENDING as soon as
// the request exists, so nobody has to approve anything.
const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "TC_LINKS_API_ORIGIN", "TC_OPENKEY_HOST", "TC_OPENKEY_API_HOST"] as const;
const original = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
const home = mkdtempSync("/var/tmp/TC4247-renewal-purpose-test-");
chmodSync(home, 0o700);
const LINKS_API = "https://links.example.test";
const OPENKEY = "https://openkey.example.test";
const NODE = "https://node.example.test";
const fixtureEnvironment = {
  HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"),
  TC_LINKS_API_ORIGIN: LINKS_API, TC_OPENKEY_HOST: OPENKEY, TC_OPENKEY_API_HOST: OPENKEY,
};
Object.assign(process.env, fixtureEnvironment);
// Imported after the fixture HOME is set, so no module resolves a real profile directory.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson } = await import("../config/storage.js");
const { registerOnboardCommand } = await import("./onboard.js");
const { refreshOpenKeySession } = await import("./auth.js");
const { startAuthFlow } = await import("../auth/browser-auth.js");
const { acquireApprovalRequest } = await import("../auth/approval-request.js");
const { DEFAULT_RENEWAL_LEASE_SECONDS } = await import("../auth/renewal-lease.js");

const THIRTY_DAYS = 30 * 86_400;
const wasm = new NodeWasmBindings();
const wallet = new PrivateKeySigner("6c8f0d4e2b1a39577e2d94c1b0a8f3e6d5c4b3a291807f6e5d4c3b2a19087f6e");
const ownerDid = `did:pkh:eip155:1:${await wallet.getAddress()}`;

/** One /v1/links post: the record exactly as the CLI sent it. */
let posted: unknown[] = [];
let fetchSpy: Mock<typeof fetch> | undefined;
let exitSpy: Mock<typeof process.exit> | undefined;
let errorSpy: Mock<typeof console.error> | undefined;
let stdoutWrite: typeof process.stdout.write;
let stderrWrite: typeof process.stderr.write;
let profileNumber = 0;

class Exited extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${code}`); }
}

async function linksApi(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== LINKS_API || url.pathname !== "/v1/links" || init?.method !== "POST") {
    throw new Error(`Only the links API fixture may be contacted, not ${url.origin}${url.pathname}`);
  }
  const record = JSON.parse(String(init.body)) as { header: { expiresAt: string } };
  posted.push(record);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(26)), (byte) => String.fromCharCode(97 + byte % 26)).join("");
  return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
}

interface Pending { approvalUrl: string; request: Record<string, unknown> }

/**
 * The signed request OpenKey would open: the one record posted to the links API, opened with the key in the approval
 * link this run saved. It must also be the request the profile saved for resuming.
 */
async function signedRequest(profile: string): Promise<Record<string, unknown>> {
  const saved = await readJson<Pending[]>(join(profilePath(profile), "approval-pending.json")) ?? [];
  expect(saved).toHaveLength(1);
  expect(posted).toHaveLength(1);
  const link = parseLink(saved[0]!.approvalUrl, { trustedOrigins: [OPENKEY] });
  const opened = await openLinkRecord(posted[0], link.key);
  expect(opened.type).toBe("openkey-approval-request");
  expect(opened.value).toEqual(saved[0]!.request);
  return opened.value as Record<string, unknown>;
}

/** Run `tc --profile <profile> onboard <args> --timeout 5m`; it ends with exit 8 (pending) once the request exists. */
async function onboard(profile: string, ...args: string[]): Promise<void> {
  const program = new Command().option("-p, --profile <name>").option("--host <url>");
  registerOnboardCommand(program);
  const failure = await program.parseAsync(["node", "tc", "--profile", profile, "onboard", ...args, "--timeout", "5m"], { from: "node" })
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Exited);
  expect((failure as Exited).code).toBe(8);
}

beforeEach(() => {
  Object.assign(process.env, fixtureEnvironment);
  posted = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(linksApi, { preconnect: globalThis.fetch.preconnect }));
  exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exited(code); }) as never);
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  stdoutWrite = process.stdout.write;
  stderrWrite = process.stderr.write;
  process.stdout.write = (() => true) as never;
  process.stderr.write = (() => true) as never;
});
afterEach(() => {
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
  fetchSpy?.mockRestore();
  exitSpy?.mockRestore();
  errorSpy?.mockRestore();
});
afterAll(async () => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

test("onboard asks with the renewal box ticked: the signed request is standing and asks a 30-day lease", async () => {
  const profile = `onboard-${++profileNumber}`;
  await onboard(profile);
  const request = await signedRequest(profile);
  expect(request.purpose).toBe("standing");
  expect(request.renewal).toEqual({ version: 1, leaseLifetimeSeconds: THIRTY_DAYS });
  expect(request.grantLifetimeSeconds).toBe(7 * 86_400);
});

test("onboard --with feed asks with the renewal box ticked as well", async () => {
  const profile = `onboard-${++profileNumber}`;
  await onboard(profile, "--with", "feed");
  const request = await signedRequest(profile);
  expect(request.purpose).toBe("standing");
  expect(request.renewal).toEqual({ version: 1, leaseLifetimeSeconds: THIRTY_DAYS });
});

test("onboard --expiry 30d asks no renewal, so the signed request names no purpose", async () => {
  const profile = `onboard-${++profileNumber}`;
  await onboard(profile, "--expiry", "30d");
  const request = await signedRequest(profile);
  expect(request.grantLifetimeSeconds).toBe(THIRTY_DAYS);
  expect("renewal" in request).toBe(false);
  expect("purpose" in request).toBe(false);
});

test("a plain sign-in asks the default renewal lease but stays a task: no purpose", async () => {
  const profile = `login-${++profileNumber}`;
  const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
  const did = signerFromJwk(key).did;
  await ProfileManager.setProfile(profile, { name: profile, did, sessionDid: did, ownerDid, host: NODE, chainId: 1, spaceName: "applications",
    createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey(profile, key);
  // The real approval-link flow with exactly the options sign-in builds; the wait bound only ends it once the request exists.
  const viaApprovalLink = ((requester: string, flow: Parameters<typeof startAuthFlow>[1]) =>
    startAuthFlow(requester, { ...flow, approvalWait: { deadlineMs: Date.now() + 300_000, step: 1, of: 1 } })) as never;
  const failure = await refreshOpenKeySession(profile, NODE, { noPopup: true, openKeyAcquisition: viaApprovalLink })
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "APPROVAL_PENDING" });
  const request = await signedRequest(profile);
  expect(request.renewal).toEqual({ version: 1, leaseLifetimeSeconds: DEFAULT_RENEWAL_LEASE_SECONDS });
  expect("purpose" in request).toBe(false);
});

test("the signed request carries a purpose only beside a renewal lease", async () => {
  const profile = `direct-${++profileNumber}`;
  const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
  const did = signerFromJwk(key).did;
  await ProfileManager.setProfile(profile, { name: profile, did, sessionDid: did, ownerDid, host: NODE, chainId: 1, spaceName: "applications",
    createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey(profile, key);
  const ask = (extra: Record<string, unknown>) => acquireApprovalRequest(did, {
    profileName: profile, jwk: key, host: NODE, expectedOwner: ownerDid, expiry: "1h", openkeyHost: OPENKEY, openkeyApiHost: OPENKEY,
    permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
    noPopup: true, onApprovalRequest: () => undefined, approvalWait: { deadlineMs: Date.now() + 300_000, step: 1, of: 1 }, ...extra,
  } as never).then(() => undefined, (error: unknown) => error);

  expect(await ask({ renewalPurpose: "standing" })).toMatchObject({ code: "APPROVAL_PENDING" });
  const withoutLease = await signedRequest(profile);
  expect("renewal" in withoutLease).toBe(false);
  expect("purpose" in withoutLease).toBe(false);

  await rm(join(profilePath(profile), "approval-pending.json"), { force: true });
  posted = [];
  expect(await ask({ renewalPurpose: "standing", renewalLeaseSeconds: THIRTY_DAYS })).toMatchObject({ code: "APPROVAL_PENDING" });
  const withLease = await signedRequest(profile);
  expect(withLease.purpose).toBe("standing");
  expect(withLease.renewal).toEqual({ version: 1, leaseLifetimeSeconds: THIRTY_DAYS });
});
