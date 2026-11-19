import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { ProfileConfig } from "../config/types";
import type { ProfileManager as ProfileManagerType } from "../config/profiles.js";
import type { createShareAuthorityAdapters as ShareAuthorityAdapterFactory } from "./adapters.js";
import { DEFAULT_TINYCLOUD_FALLBACK_HOST, endToEndNodeHost, pkhDid, registryOwnerKeyV2, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { createNativeShare } from "@tinycloud/share-sdk";

// TC-3181: a bearer link whose sender the registry verifies has no record (an OpenKey
// did:pkh owner, for example) is read from the default node. Registry outages, offline
// verdicts and saved settings never route there, and a registered sender uses its record.
// The real SDK runs against a loopback node; the default node's origin is answered by
// that node, so nothing leaves the machine.

type RegistryMode = "absent" | "registered" | "http-500" | "http-503" | "hang" | "transport" | "v1-outage";
type FixtureServer = { readonly url: URL; stop(closeActiveConnections?: boolean): void };

const SHARE_PATH = "vault/secrets/HERMETIC_DELEGATION_CANARY";
const EXPECTED_BYTES = Uint8Array.from(randomBytes(64));
const RUN = randomUUID().slice(0, 8);
const ENVIRONMENT_KEYS = ["HOME", "TC_HOME", "TC_REGISTRY_URL", "TC_HOST", "TC_PRIVATE_KEY"] as const;

let privateRoot: string | undefined;
const priorEnvironment = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch | undefined;
let fixture: HermeticEncryptedNode | undefined;
let registryServer: FixtureServer | undefined;
let profileManager: typeof ProfileManagerType;
let createShareAuthorityAdapters: typeof ShareAuthorityAdapterFactory;
let registryMode: RegistryMode = "absent";
let routeRecord: unknown;
let registryOwnerKey = "";
let link = "";
const defaultNodeRequests: string[] = [];
const unapprovedOrigins: string[] = [];

async function reader(suffix: string): Promise<(link: string) => Promise<{ readonly bytes: Uint8Array; readonly filename: string }>> {
  if (!fixture || !registryServer) throw new Error("test fixture is not ready");
  const name = `tc3181-${suffix}-${RUN}`;
  if (!await profileManager.profileExists(name)) {
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
  return createShareAuthorityAdapters({ profileName: async () => name }).nativeReader;
}

function shareReads(since: number): boolean {
  return fixture!.invocations().slice(since).some((invocation) =>
    invocation.action === "tinycloud.kv/get" && invocation.path === SHARE_PATH);
}

async function expectRefused(mode: RegistryMode, suffix: string): Promise<void> {
  registryMode = mode;
  const invocations = fixture!.invocations().length;
  defaultNodeRequests.length = 0;
  const failure = await (await reader(suffix))(link).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(defaultNodeRequests).toEqual([]);
  expect(shareReads(invocations)).toBe(false);
  expect(unapprovedOrigins).toEqual([]);
}

beforeAll(async () => {
  for (const key of ENVIRONMENT_KEYS) priorEnvironment.set(key, process.env[key]);
  privateRoot = await mkdtemp(join(tmpdir(), "tc3181-cli-receive-"));
  await chmod(privateRoot, 0o700);
  const home = join(privateRoot, "home");
  const tcHome = join(privateRoot, "tc-home");
  await mkdir(home, { mode: 0o700 });
  await mkdir(tcHome, { mode: 0o700 });
  process.env.HOME = home;
  process.env.TC_HOME = tcHome;
  delete process.env.TC_HOST;
  delete process.env.TC_PRIVATE_KEY;

  // These modules capture HOME/TC_HOME at import time; install the private test home first.
  await import("../../../operations/test-support/test-bootstrap.mjs");
  const [profiles, adapters, nodeHelpers, nodeSdk] = await Promise.all([
    import("../config/profiles.js"),
    import("./adapters.js"),
    import("../../../node-sdk/src/test-support/hermetic-encrypted-node"),
    import("@tinycloud/node-sdk"),
  ]);
  profileManager = profiles.ProfileManager;
  createShareAuthorityAdapters = adapters.createShareAuthorityAdapters;

  fixture = await nodeHelpers.createHermeticEncryptedNode({
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
    async fetch(request) {
      const url = new URL(request.url);
      const v2 = url.pathname.startsWith("/v2/");
      if (!v2 && !url.pathname.startsWith("/v1/")) return new Response("not found", { status: 404 });
      if (registryMode === "http-500") return new Response("internal error", { status: 500 });
      if (registryMode === "http-503") return new Response("unavailable", { status: 503 });
      if (registryMode === "hang") {
        // Never answers: the SDK's lookup budget aborts the request.
        const { promise, resolve } = Promise.withResolvers<void>();
        request.signal.addEventListener("abort", () => resolve());
        await promise;
        return new Response("late", { status: 503 });
      }
      if (registryMode === "v1-outage" && !v2) return new Response("unavailable", { status: 503 });
      const owner = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1)).toLowerCase();
      if (registryMode === "registered" && v2 && owner === registryOwnerKey) return Response.json({ record: routeRecord });
      return Response.json({ error: "location record not found" }, { status: 404 });
    },
  });
  process.env.TC_REGISTRY_URL = registryServer.url.origin;

  const allowed = new Set([new URL(fixture.host).origin, registryServer.url.origin]);
  const fixtureHost = fixture.host;
  const registryOrigin = registryServer.url.origin;
  const passthrough = globalThis.fetch;
  originalFetch = passthrough;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === DEFAULT_TINYCLOUD_FALLBACK_HOST || url.origin === endToEndNodeHost(DEFAULT_TINYCLOUD_FALLBACK_HOST)) {
      defaultNodeRequests.push(url.pathname);
      const target = new URL(`${url.pathname}${url.search}`, fixtureHost).toString();
      return input instanceof Request ? passthrough(new Request(target, input), init) : passthrough(target, init);
    }
    if (url.origin === registryOrigin && registryMode === "transport") throw new TypeError("fetch failed");
    if (!allowed.has(url.origin)) {
      unapprovedOrigins.push(url.origin);
      throw new Error("test blocked a non-fixture network destination");
    }
    return passthrough(input, init);
  }) as typeof globalThis.fetch;

  const identity = await fixture.owner.activeNodeIdentity();
  const subject = pkhDid(fixture.ownerRestorableSession.address, fixture.ownerRestorableSession.chainId);
  registryOwnerKey = registryOwnerKeyV2(subject).toLowerCase();
  const ownerSigner = new nodeSdk.PrivateKeySigner(fixture.ownerPrivateKey);
  routeRecord = await signLocationRecordV2({
    version: 2,
    subject,
    nodes: [{ did: identity.nodeDid, url: fixture.host }],
    spaces: [{ space: fixture.ownerRestorableSession.spaceId.toLowerCase(), nodes: [{ did: identity.nodeDid, mode: "read-write" }] }],
    encryptionNode: identity.nodeDid,
    updated_at: new Date().toISOString(),
    sequence: 1,
  }, { type: "did:pkh", signMessage: (message) => ownerSigner.signMessage(message) });

  link = (await createNativeShare(fixture.owner.sharing, {
    path: SHARE_PATH,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    viewerOrigin: "https://share.test",
  })).url;
});

afterAll(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  fixture?.stop();
  registryServer?.stop(true);
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
});

test("a verified-unregistered did:pkh sender's bearer share is received from the default node, byte for byte", async () => {
  expect(fixture!.ownerDid).toStartWith("did:pkh:eip155:");
  registryMode = "absent";
  defaultNodeRequests.length = 0;
  const invocations = fixture!.invocations().length;
  const received = await (await reader("absent"))(link);

  expect(received.bytes).toEqual(EXPECTED_BYTES);
  expect(received.filename).toBe("HERMETIC_DELEGATION_CANARY");
  expect(defaultNodeRequests).toContain("/invoke");
  expect(shareReads(invocations)).toBe(true);
  expect(unapprovedOrigins).toEqual([]);
});

for (const mode of ["http-500", "http-503", "transport"] as const) {
  test(`a registry ${mode} answer is refused and nothing goes to the default node`, async () => {
    await expectRefused(mode, mode);
  });
}

test("a registry lookup that times out is refused and nothing goes to the default node", async () => {
  await expectRefused("hang", "hang");
}, 20_000);

test("an offline unregistered verdict (v2 absent, v1 unreachable) is refused", async () => {
  await expectRefused("v1-outage", "v1-outage");
});

test("a sender saved in this profile as registered is refused once the registry reports no record", async () => {
  registryMode = "registered";
  expect((await (await reader("remembered"))(link)).bytes).toEqual(EXPECTED_BYTES);
  await expectRefused("absent", "remembered");
});

test("a registered sender is read from its own record's host, never the default node", async () => {
  registryMode = "registered";
  defaultNodeRequests.length = 0;
  const invocations = fixture!.invocations().length;
  const received = await (await reader("registered"))(link);

  expect(received.bytes).toEqual(EXPECTED_BYTES);
  expect(shareReads(invocations)).toBe(true);
  expect(defaultNodeRequests).toEqual([]);
  expect(unapprovedOrigins).toEqual([]);
});
