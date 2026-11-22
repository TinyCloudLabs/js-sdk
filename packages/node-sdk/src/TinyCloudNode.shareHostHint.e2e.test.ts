import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Wallet } from "ethers";
import { REGISTRY_NOT_FOUND_BODY, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./index";
import { createHermeticEncryptedNode, type HermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

const path = "vault/secrets/HERMETIC_DELEGATION_CANARY";
const DAY = 24 * 60 * 60_000;

type RegistryMode = "no record" | "record" | "unavailable";
interface Seen { readonly origin: string; readonly path: string; readonly method: string; readonly authorization: string | null }

let fixture: HermeticEncryptedNode;
let owner: TinyCloudNode;
let registry: Bun.Server<undefined>;
let hostile: Bun.Server<undefined>;
let registryMode: RegistryMode;
let record: unknown;
let hostileRequests: string[];
let seen: Seen[];
const cleanup: Array<() => void> = [];

beforeEach(async () => {
  registryMode = "no record";
  record = undefined;
  hostileRequests = [];
  seen = [];
  fixture = await createHermeticEncryptedNode();
  registry = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (registryMode === "unavailable") return new Response("registry unavailable", { status: 503 });
      if (registryMode === "record" && new URL(request.url).pathname.startsWith("/v2/locations/")) return Response.json({ record });
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } });
    },
  });
  hostile = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      hostileRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("hostile", { status: 500 });
    },
  });
  owner = new TinyCloudNode({
    host: fixture.host, tinycloudRegistryUrl: fixture.host, privateKey: fixture.ownerPrivateKey, autoBootstrapAccount: false,
  });
  await owner.restoreSession(fixture.ownerRestorableSession);
  fixture.configureKv(fixture.ownerRestorableSession.spaceId, { [path]: { message: "shared by the owner" } });
  const native = globalThis.fetch;
  const watch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ origin: url.origin, path: url.pathname, method: request.method, authorization: request.headers.get("authorization") });
    return native(input, init);
  }, { preconnect: native.preconnect }));
  cleanup.push(() => watch.mockRestore());
});

afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  registry.stop(true);
  hostile.stop(true);
  fixture.stop();
});

/** A v1 share of the canary; a share that outlives the owner's session is signed from the owner's root. */
async function share(expiryMs: number, host?: string) {
  const generated = await owner.sharing.generate({ path, actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + expiryMs) });
  if (!generated.ok) throw new Error(JSON.stringify(generated.error));
  const decoded = owner.sharing.decodeLink(generated.data.token);
  expect(decoded.version).toBe(1);
  return { decoded, delegator: generated.data.delegation.delegatorDID, token: host ? owner.sharing.encodeLink({ ...decoded, host }) : generated.data.token };
}

/** The recipient is unsigned and, like a share viewer, has no new-user host. */
function recipient(extra: ConstructorParameters<typeof TinyCloudNode>[0] = {}) {
  return new TinyCloudNode({ tinycloudRegistryUrl: registry.url.origin, newUserHost: null, autoDiscoverLocalNode: false, ...extra });
}

async function read(receiver: TinyCloudNode, token: string) {
  const received = await receiver.sharing.receive(token, { autoSubdelegate: false, useSessionKey: false });
  if (!received.ok) return received;
  return received.data.kv.get(path, { prefix: "" });
}

function sentTo(origin: string): Seen[] {
  return seen.filter((entry) => entry.origin === origin);
}

async function publishRecord(): Promise<void> {
  const wallet = new Wallet(`0x${fixture.ownerPrivateKey.replace(/^0x/, "")}`);
  const info = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
  record = await signLocationRecordV2({
    version: 2, subject: `did:pkh:eip155:1:${wallet.address}`,
    nodes: [{ did: info.nodeId, url: fixture.host }],
    spaces: [{ space: fixture.ownerRestorableSession.spaceId, nodes: [{ did: info.nodeId, mode: "read-write" }] }],
    encryptionNode: null, updated_at: new Date().toISOString(), sequence: 1,
  }, { type: "did:pkh", signMessage: (message: string) => wallet.signMessage(message) });
}

describe("a v1 share whose owner has no registry record", () => {
  for (const [name, expiryMs, rootSigned] of [["signed by the owner's session", 60_000, false], ["signed from the owner's root", 30 * DAY, true]] as const) {
    test(`the link's host serves a share ${name} when the recipient knows that node`, async () => {
      const { decoded, delegator, token } = await share(expiryMs);
      expect(decoded.host).toBe(fixture.host);
      expect(delegator?.startsWith("did:pkh:") ?? false).toBe(rootSigned);
      seen = [];
      const result = await read(recipient({ tinycloudFallbackHosts: [fixture.host] }), token);
      expect(result).toMatchObject({ ok: true, data: { data: { message: "shared by the owner" } } });
      expect(seen[0]?.origin).toBe(registry.url.origin);
      expect(sentTo(fixture.host).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /info", "GET /info", "GET /.well-known/tinycloud/node-keys", "POST /invoke",
      ]);
      const authorization = sentTo(fixture.host).find((entry) => entry.path === "/invoke")!.authorization!;
      const claims = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString()) as { iss: string; prf: string[] };
      expect(claims.iss.split("#")[0]).toBe(decoded.keyDid.split("#")[0]);
      expect(claims.prf).toEqual([decoded.delegation.cid]);
    });
  }

  test("a link host the recipient does not know is refused and receives no request", async () => {
    const { token } = await share(60_000, hostile.url.origin);
    seen = [];
    const result = await read(recipient(), token);
    expect(result.ok).toBe(false);
    expect(hostileRequests).toEqual([]);
    expect(sentTo(hostile.url.origin)).toEqual([]);
    expect(sentTo(fixture.host)).toEqual([]);
  });

  test("a v2 share goes to its signed placement and ignores the link host", async () => {
    const generated = await owner.sharing.generate({ path, expiry: new Date(Date.now() + 60_000), includePlacement: true });
    if (!generated.ok) throw new Error(JSON.stringify(generated.error));
    const decoded = owner.sharing.decodeLink(generated.data.token);
    expect(decoded.version).toBe(2);
    const token = owner.sharing.encodeLink({ ...decoded, host: hostile.url.origin });
    seen = [];
    const result = await read(recipient({ tinycloudFallbackHosts: [hostile.url.origin] }), token);
    expect(result).toMatchObject({ ok: true, data: { data: { message: "shared by the owner" } } });
    expect(hostileRequests).toEqual([]);
  });
});

describe("a v1 share whose owner has a registry record", () => {
  test("the record's node serves the share and the link host is never contacted", async () => {
    const { token } = await share(60_000, hostile.url.origin);
    await publishRecord();
    registryMode = "record";
    seen = [];
    const result = await read(recipient({ tinycloudFallbackHosts: [hostile.url.origin] }), token);
    expect(result).toMatchObject({ ok: true, data: { data: { message: "shared by the owner" } } });
    expect(hostileRequests).toEqual([]);
    expect(sentTo(fixture.host).some((entry) => entry.path === "/invoke")).toBe(true);
  });
});

describe("a v1 share while the registry is unavailable", () => {
  test("the link's known host is not used as a fallback", async () => {
    const { token } = await share(60_000);
    registryMode = "unavailable";
    seen = [];
    const result = await read(recipient({ tinycloudFallbackHosts: [fixture.host] }), token);
    expect(result.ok).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.origin === registry.url.origin)).toBe(true);
  });
});

describe("a recipient that restored a persisted session", () => {
  async function restoredRecipient(extra: ConstructorParameters<typeof TinyCloudNode>[0] = {}) {
    const restored = recipient(extra);
    await restored.restoreSession({ ...fixture.ownerRestorableSession, tinycloudHosts: [hostile.url.origin] });
    return restored;
  }

  test("a host that came from the persisted session is not a known node", async () => {
    const { token } = await share(60_000, hostile.url.origin);
    const restored = await restoredRecipient();
    hostileRequests = [];
    seen = [];
    const result = await read(restored, token);
    expect(result.ok).toBe(false);
    expect(hostileRequests).toEqual([]);
    expect(sentTo(hostile.url.origin)).toEqual([]);
  });

  test("a host the recipient configured is a known node when a session is restored", async () => {
    const { token } = await share(60_000);
    const restored = await restoredRecipient({ host: fixture.host });
    seen = [];
    const result = await read(restored, token);
    expect(result).toMatchObject({ ok: true, data: { data: { message: "shared by the owner" } } });
    expect(hostileRequests).toEqual([]);
    expect(sentTo(fixture.host).some((entry) => entry.path === "/invoke")).toBe(true);
  });
});
