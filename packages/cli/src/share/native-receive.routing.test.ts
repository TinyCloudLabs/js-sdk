import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { ProfileConfig } from "../config/types.js";
import type { ProfileManager as ProfileManagerType } from "../config/profiles.js";
import type { createShareAuthorityAdapters as ShareAuthorityAdapterFactory } from "./adapters.js";
import type { createHermeticEncryptedNode as HermeticEncryptedNodeFactory } from "../../../node-sdk/src/test-support/hermetic-encrypted-node";
import type { createNativeShare as NativeShareFactory } from "@tinycloud/share-sdk";
import type { ShareReceiveError as ShareReceiveErrorType } from "@tinycloud/share-sdk";

type RequestSummary = {
  readonly method: string;
  readonly path: string;
  readonly authorizationPresent: boolean;
};
type RequestServer = {
  readonly url: URL;
  requests(): readonly RequestSummary[];
  stop(closeActiveConnections?: boolean): void;
};
type ShareFixture = {
  readonly node: HermeticEncryptedNode;
  readonly link: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
};

const PROFILE_NAME = "tc2594-native-receive";
const VIEWER_ORIGIN = "https://share.tinycloud.xyz";
const ENVIRONMENT_KEYS = ["HOME", "TC_HOME", "TC_PROFILE", "TC_HOST"] as const;
const SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const EXPECTED_BYTES = Uint8Array.from([0, 7, 128, 255, 13]);

const priorEnvironment = new Map<string, string | undefined>();
const fixtures: HermeticEncryptedNode[] = [];
const servers: RequestServer[] = [];
let privateRoot: string | undefined;
let ProfileManager: typeof ProfileManagerType;
let createShareAuthorityAdapters: typeof ShareAuthorityAdapterFactory;
let createHermeticEncryptedNode: typeof HermeticEncryptedNodeFactory;
let createNativeShare: typeof NativeShareFactory;
let ShareReceiveError: typeof ShareReceiveErrorType;
let parseNativeShareUrl: typeof import("@tinycloud/share-sdk").parseNativeShareUrl;
let defaultHost: string;

function freshPrivateKey(): string {
  for (;;) {
    const bytes = randomBytes(32);
    const value = BigInt(`0x${bytes.toString("hex")}`);
    if (value > 0n && value < SECP256K1_ORDER) return bytes.toString("hex");
  }
}

function startRequestServer(status: number): RequestServer {
  const observed: RequestSummary[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      observed.push({
        method: request.method,
        path: url.pathname,
        authorizationPresent: request.headers.has("authorization"),
      });
      return new Response(null, { status });
    },
  });
  const value: RequestServer = {
    url: server.url,
    requests: () => observed.map((request) => ({ ...request })),
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
  };
  servers.push(value);
  return value;
}

async function configureProfile(host: string, did: string): Promise<void> {
  const profile: ProfileConfig = {
    name: PROFILE_NAME,
    host,
    chainId: 1,
    spaceName: "applications",
    did,
    createdAt: new Date().toISOString(),
    autoDiscoverLocalNode: false,
  };
  await ProfileManager.setProfile(PROFILE_NAME, profile);
  await ProfileManager.setConfig({ defaultProfile: PROFILE_NAME, version: 1 });
}

async function createShareFixture(): Promise<ShareFixture> {
  const path = `routing/${randomUUID()}.bin`;
  const bytes = Uint8Array.from(EXPECTED_BYTES);
  const node = await createHermeticEncryptedNode({
    ownerPrivateKey: freshPrivateKey(),
    delegatePrivateKey: freshPrivateKey(),
    nodePrivateKey: Uint8Array.from(randomBytes(32)),
    networkSeed: Uint8Array.from(randomBytes(32)),
    nativeBearerPath: path,
    recordAuthorizationHashes: false,
  });
  fixtures.push(node);
  node.configureKv(node.applicationsSpaceId, { [path]: bytes });
  const share = await createNativeShare(node.owner.sharing, {
    path,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    viewerOrigin: VIEWER_ORIGIN,
  });
  return { node, link: share.url, bytes, filename: path.split("/").at(-1)! };
}

function nativeReader() {
  return createShareAuthorityAdapters({ profileName: async () => PROFILE_NAME }).nativeReader;
}

function linkAtHost(share: ShareFixture, host: string): string {
  const sharing = share.node.owner.sharing;
  const decoded = sharing.decodeLink(parseNativeShareUrl(share.link));
  const token = sharing.encodeLink({ ...decoded, host });
  const link = new URL(share.link);
  link.hash = new URLSearchParams({ tc1: token }).toString();
  return link.href;
}

function readerViaOwnedNode(share: ShareFixture, profile = PROFILE_NAME) {
  const origins: string[] = [];
  const reader = createShareAuthorityAdapters({
    profileName: async () => profile,
    fetchFn: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      origins.push(url.origin);
      const ownedUrl = new URL(`${url.pathname}${url.search}`, share.node.host);
      // Only the DNS/TLS destination changes; native HTTP still receives the actual options.
      return fetch(input instanceof Request ? new Request(ownedUrl, input) : ownedUrl, init);
    },
  }).nativeReader;
  return { reader, origins };
}

beforeAll(async () => {
  for (const key of ENVIRONMENT_KEYS) priorEnvironment.set(key, process.env[key]);
  privateRoot = await mkdtemp(join(tmpdir(), "tc2594-cli16-receive-"));
  const home = join(privateRoot, "home");
  const tcHome = join(privateRoot, "tc-home");
  await chmod(privateRoot, 0o700);
  await mkdir(home, { mode: 0o700 });
  await mkdir(tcHome, { mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(tcHome, 0o700);
  process.env.HOME = home;
  process.env.TC_HOME = tcHome;
  process.env.TC_PROFILE = PROFILE_NAME;
  delete process.env.TC_HOST;

  // Set isolated paths before importing code that resolves profile storage. Details: TC-2594
  const [profiles, adapters, nodeHelpers, shareSdk, constants] = await Promise.all([
    import("../config/profiles.js"),
    import("./adapters.js"),
    import("../../../node-sdk/src/test-support/hermetic-encrypted-node"),
    import("@tinycloud/share-sdk"),
    import("../config/constants.js"),
  ]);
  ProfileManager = profiles.ProfileManager;
  createShareAuthorityAdapters = adapters.createShareAuthorityAdapters;
  createHermeticEncryptedNode = nodeHelpers.createHermeticEncryptedNode;
  createNativeShare = shareSdk.createNativeShare;
  ShareReceiveError = shareSdk.ShareReceiveError;
  parseNativeShareUrl = shareSdk.parseNativeShareUrl;
  defaultHost = constants.DEFAULT_HOST;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const fixture of fixtures.splice(0)) fixture.stop();
});

afterAll(async () => {
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (privateRoot !== undefined) await rm(privateRoot, { recursive: true, force: true });
});

test("rejects a share whose link origin is not selected by the profile Details: TC-2594", async () => {
  const configuredNode = startRequestServer(503);
  const share = await createShareFixture();
  await configureProfile(configuredNode.url.origin, share.node.ownerDid);
  const linkRequestStart = share.node.requestSummary().length;
  const configuredRequestStart = configuredNode.requests().length;
  let failure: unknown;
  const received = await nativeReader()(share.link).then(() => true, (error: unknown) => {
    failure = error;
    return false;
  });

  expect({
    received,
    linkRequests: share.node.requestSummary().slice(linkRequestStart),
    configuredRequests: configuredNode.requests().slice(configuredRequestStart),
  }).toEqual({ received: false, linkRequests: [], configuredRequests: [] });
  expect(failure).toBeInstanceOf(ShareReceiveError);
  expect(failure).toMatchObject({ code: "origin-mismatch" });
});

test("reads exact bytes when the link origin matches the selected profile Details: TC-2594", async () => {
  const share = await createShareFixture();
  await configureProfile(share.node.host, share.node.ownerDid);
  const requestStart = share.node.requestSummary().length;
  const received = await nativeReader()(share.link);
  const requests = share.node.requestSummary().slice(requestStart);

  expect(received.bytes).toEqual(share.bytes);
  expect(received.filename).toBe(share.filename);
  expect(requests.some((request) => request.method === "POST" && request.path === "/invoke" && request.authorizationPresent)).toBe(true);
});

test("refuses a redirected receive without contacting the redirect target Details: TC-2594", async () => {
  const redirectTarget = startRequestServer(204);
  const share = await createShareFixture();
  await configureProfile(share.node.host, share.node.ownerDid);
  share.node.redirectInvocationsTo(redirectTarget.url.origin);
  const requestStart = share.node.requestSummary().length;
  const received = await nativeReader()(share.link).then(() => true, () => false);
  const requests = share.node.requestSummary().slice(requestStart);

  expect(received).toBe(false);
  expect(requests.some((request) => request.method === "POST" && request.path === "/invoke" && request.authorizationPresent)).toBe(true);
  expect(redirectTarget.requests()).toEqual([]);
});

test("opens the other first-party hostname through the default profile's server Details: TC-2594", async () => {
  const share = await createShareFixture();
  await configureProfile(defaultHost, share.node.ownerDid);
  const { reader, origins } = readerViaOwnedNode(share);
  const requestStart = share.node.requestSummary().length;
  const received = await reader(linkAtHost(share, "https://node.tinycloud.xyz"));

  expect(received.bytes).toEqual(share.bytes);
  expect(received.filename).toBe(share.filename);
  expect(origins.every((origin) => origin === defaultHost)).toBe(true);
  expect(share.node.requestSummary().slice(requestStart).some(
    (request) => request.method === "POST" && request.path === "/invoke" && request.authorizationPresent,
  )).toBe(true);
});

test("does not extend first-party aliases to a third origin, HTTP or a different port Details: TC-2594", async () => {
  const share = await createShareFixture();
  await configureProfile(defaultHost, share.node.ownerDid);
  const { reader, origins } = readerViaOwnedNode(share);
  const requestStart = share.node.requestSummary().length;

  for (const host of [
    "https://third-party.example.invalid",
    "http://node.tinycloud.xyz",
    "https://node.tinycloud.xyz:8443",
  ]) {
    await expect(reader(linkAtHost(share, host))).rejects.toMatchObject({ code: "origin-mismatch" });
  }
  expect(origins).toEqual([]);
  expect(share.node.requestSummary().slice(requestStart)).toEqual([]);
});

test("does not add first-party aliases to a custom profile's origin Details: TC-2594", async () => {
  const share = await createShareFixture();
  await configureProfile(share.node.host, share.node.ownerDid);
  const { reader, origins } = readerViaOwnedNode(share);
  const requestStart = share.node.requestSummary().length;

  await expect(reader(linkAtHost(share, "https://node.tinycloud.xyz"))).rejects.toMatchObject({ code: "origin-mismatch" });
  expect(origins).toEqual([]);
  expect(share.node.requestSummary().slice(requestStart)).toEqual([]);
});

test("uses the CLI default for an alias link when the selected profile does not exist Details: TC-2594", async () => {
  const share = await createShareFixture();
  const { reader, origins } = readerViaOwnedNode(share, "tc2594-no-profile");
  const requestStart = share.node.requestSummary().length;
  const received = await reader(linkAtHost(share, "https://node.tinycloud.xyz"));

  expect(received.bytes).toEqual(share.bytes);
  expect(origins.every((origin) => origin === defaultHost)).toBe(true);
  expect(share.node.requestSummary().slice(requestStart).some(
    (request) => request.method === "POST" && request.path === "/invoke" && request.authorizationPresent,
  )).toBe(true);
});
