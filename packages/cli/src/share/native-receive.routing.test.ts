import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { ProfileConfig } from "../config/types";
import type { ProfileManager as ProfileManagerType } from "../config/profiles.js";
import type { createShareAuthorityAdapters as ShareAuthorityAdapterFactory } from "./adapters.js";
import type { createHermeticEncryptedNode as HermeticEncryptedNodeFactory } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { PrivateKeySigner as PrivateKeySignerType } from "@tinycloud/node-sdk";
import { pkhDid, registryOwnerKeyV2, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { createNativeShare, parseNativeShareUrl } from "@tinycloud/share-sdk";

type FixtureServer = {
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void;
};
type NativeReadResult = { readonly bytes: Uint8Array; readonly filename: string };

const SHARE_PATH = "vault/secrets/HERMETIC_DELEGATION_CANARY";
const EXPECTED_BYTES = Uint8Array.from([0, 7, 128, 255, 13]);
const PROFILE_SUFFIX = randomUUID();
const ENVIRONMENT_KEYS = ["HOME", "TC_HOME", "TC_REGISTRY_URL", "TC_HOST", "TC_PRIVATE_KEY"] as const;

let privateRoot: string | undefined;
let priorEnvironment = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch | undefined;
let fixture: HermeticEncryptedNode | undefined;
let registryServer: FixtureServer | undefined;
let attackerServer: FixtureServer | undefined;
let profileManager: typeof ProfileManagerType;
let createShareAuthorityAdapters: typeof ShareAuthorityAdapterFactory;
let createHermeticEncryptedNode: typeof HermeticEncryptedNodeFactory;
let PrivateKeySigner: typeof PrivateKeySignerType;
let routeRecord: unknown;
let signedLocationRecord: unknown;
let registryOwnerKey = "";
let ownerLink = "";
let registeredOrigin = "";
const registryRequests: Array<{ readonly method: string; readonly path: string }> = [];
const attackerRequests: Array<{ readonly method: string; readonly path: string; readonly hasAuthorization: boolean }> = [];
const unapprovedOrigins: string[] = [];
const allowedOrigins = new Set<string>();

function profileName(suffix: string): string {
  return `tc2594-${suffix}-${PROFILE_SUFFIX.slice(0, 8)}`;
}

async function writeProfile(name: string): Promise<void> {
  if (!fixture || !registryServer) throw new Error("test fixture is not ready");
  const profile: ProfileConfig = {
    name,
    host: fixture.host,
    tinycloudRegistryUrl: registryServer.url.origin,
    chainId: fixture.ownerRestorableSession.chainId,
    spaceName: "secrets",
    did: fixture.ownerDid,
    createdAt: new Date().toISOString(),
    autoDiscoverLocalNode: false,
  };
  await profileManager.setProfile(name, profile);
}

function readerFor(name: string): (link: string) => Promise<NativeReadResult> {
  return createShareAuthorityAdapters({ profileName: async () => name }).nativeReader;
}

function linkWithHost(host: string): string {
  if (!fixture || !ownerLink) throw new Error("test fixture is not ready");
  const token = parseNativeShareUrl(ownerLink);
  const decoded = fixture.owner.sharing.decodeLink(token);
  const altered = fixture.owner.sharing.encodeLink({ ...decoded, host });
  const url = new URL(ownerLink);
  url.hash = new URLSearchParams({ tc1: altered }).toString();
  return url.toString();
}

beforeAll(async () => {
  for (const key of ENVIRONMENT_KEYS) priorEnvironment.set(key, process.env[key]);

  privateRoot = await mkdtemp(join(tmpdir(), "tc2594-cli-receive-"));
  const home = join(privateRoot, "home");
  const tcHome = join(privateRoot, "tc-home");
  await chmod(privateRoot, 0o700);
  await mkdir(home, { mode: 0o700 });
  await mkdir(tcHome, { mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(tcHome, 0o700);
  process.env.HOME = home;
  process.env.TC_HOME = tcHome;
  delete process.env.TC_HOST;
  delete process.env.TC_PRIVATE_KEY;

  // These modules capture HOME/TC_HOME at import time; install the private test home first. Details: TC-2594
  await import("../../../operations/test-support/test-bootstrap.mjs");
  const [profiles, adapters, nodeHelpers, nodeSdkModule] = await Promise.all([
    import("../config/profiles.js"),
    import("./adapters.js"),
    import("../../../node-sdk/src/test-support/hermetic-encrypted-node"),
    import("@tinycloud/node-sdk"),
  ]);
  profileManager = profiles.ProfileManager;
  createShareAuthorityAdapters = adapters.createShareAuthorityAdapters;
  createHermeticEncryptedNode = nodeHelpers.createHermeticEncryptedNode;
  PrivateKeySigner = nodeSdkModule.PrivateKeySigner;

  fixture = await createHermeticEncryptedNode({
    ownerPrivateKey: randomBytes(32).toString("hex"),
    delegatePrivateKey: randomBytes(32).toString("hex"),
    nodePrivateKey: Uint8Array.from(randomBytes(32)),
    networkSeed: Uint8Array.from(randomBytes(32)),
  });
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [SHARE_PATH]: EXPECTED_BYTES });
  fixture.allowInvocationProof(fixture.ownerRestorableSession.delegationCid);

  registryServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      registryRequests.push({ method: request.method, path: url.pathname });
      const lastSegment = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1)).toLowerCase();
      if (url.pathname.startsWith("/v2/") && lastSegment === registryOwnerKey && routeRecord !== undefined) {
        return Response.json({ record: routeRecord });
      }
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v2/")) {
        return Response.json({ error: "location record not found" }, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  registeredOrigin = registryServer.url.origin;

  attackerServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      attackerRequests.push({ method: request.method, path: url.pathname, hasAuthorization: request.headers.has("authorization") });
      return new Response("not found", { status: 404 });
    },
  });

  allowedOrigins.add(new URL(fixture.host).origin);
  allowedOrigins.add(registeredOrigin);
  allowedOrigins.add(attackerServer.url.origin);
  process.env.TC_REGISTRY_URL = registeredOrigin;
  const fetchBeforeGuard = globalThis.fetch;
  originalFetch = fetchBeforeGuard;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowedOrigins.has(url.origin)) {
      unapprovedOrigins.push(url.origin);
      throw new Error("test blocked a non-fixture network destination");
    }
    return fetchBeforeGuard(input, init);
  }) as typeof globalThis.fetch;

  const ownerIdentity = await fixture.owner.activeNodeIdentity();
  const subject = pkhDid(fixture.ownerRestorableSession.address, fixture.ownerRestorableSession.chainId);
  registryOwnerKey = registryOwnerKeyV2(subject).toLowerCase();
  const ownerSigner = new PrivateKeySigner(fixture.ownerPrivateKey);
  signedLocationRecord = await signLocationRecordV2({
    version: 2,
    subject,
    nodes: [{ did: ownerIdentity.nodeDid, url: fixture.host }],
    spaces: [{
      space: fixture.ownerRestorableSession.spaceId.toLowerCase(),
      nodes: [{ did: ownerIdentity.nodeDid, mode: "read-write" }],
    }],
    encryptionNode: ownerIdentity.nodeDid,
    updated_at: new Date().toISOString(),
    sequence: 1,
  }, {
    type: "did:pkh",
    signMessage: (message) => ownerSigner.signMessage(message),
  });
  routeRecord = signedLocationRecord;

  await writeProfile(profileName("missing"));
  await writeProfile(profileName("mismatch"));
  await writeProfile(profileName("registered"));
  const published = await createNativeShare(fixture.owner.sharing, {
    path: SHARE_PATH,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    viewerOrigin: "https://share.test",
  });
  ownerLink = published.url;
});

afterAll(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  fixture?.stop();
  registryServer?.stop(true);
  attackerServer?.stop(true);
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
});

test("Native bearer receive refuses an unregistered owner before dispatch; Details: TC-2594", async () => {
  if (!fixture || !registryServer) throw new Error("test fixture is not ready");
  routeRecord = undefined;
  const ownerRequestCount = fixture.requests().length;
  const registryRequestCount = registryRequests.length;
  const attackerRequestCount = attackerRequests.length;
  const rejected = await readerFor(profileName("missing"))(ownerLink).then(() => false, () => true);

  expect(rejected).toBe(true);
  expect(registryRequests.length).toBeGreaterThan(registryRequestCount);
  expect(fixture.requests().slice(ownerRequestCount)).toEqual([]);
  expect(attackerRequests.slice(attackerRequestCount)).toEqual([]);
  expect(unapprovedOrigins).toEqual([]);
});

test("Native bearer receive ignores a mismatched link host and uses the signed route; Details: TC-2594", async () => {
  if (!fixture || !attackerServer) throw new Error("test fixture is not ready");
  routeRecord = signedLocationRecord;
  const ownerRequestCount = fixture.requests().length;
  const ownerInvocationCount = fixture.invocations().length;
  const attackerRequestCount = attackerRequests.length;
  const result = await readerFor(profileName("mismatch"))(linkWithHost(attackerServer.url.origin));

  expect(result.bytes).toEqual(EXPECTED_BYTES);
  expect(fixture.requests().slice(ownerRequestCount).some((request) => request.path === "/invoke" && request.authorizationSha256 !== undefined)).toBe(true);
  expect(fixture.invocations().slice(ownerInvocationCount).some((invocation) =>
    invocation.action === "tinycloud.kv/get" && invocation.path === SHARE_PATH
  )).toBe(true);
  expect(attackerRequests.slice(attackerRequestCount)).toEqual([]);
  expect(unapprovedOrigins).toEqual([]);
});

test("Native bearer receive reads bytes over a signed registry route; Details: TC-2594", async () => {
  if (!fixture) throw new Error("test fixture is not ready");
  routeRecord = signedLocationRecord;
  const invocationCount = fixture.invocations().length;
  const result = await readerFor(profileName("registered"))(ownerLink);

  expect(result.bytes).toEqual(EXPECTED_BYTES);
  expect(fixture.invocations().slice(invocationCount).some((invocation) =>
    invocation.action === "tinycloud.kv/get" && invocation.path === SHARE_PATH
  )).toBe(true);
  expect(unapprovedOrigins).toEqual([]);
});

