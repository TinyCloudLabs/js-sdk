import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { signLocationRecordV2 } from "@tinycloud/sdk-core";
import { profileConfigPath, readJson, sessionPath, writeJsonAtomic } from "@tinycloud/operations/state";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";

// Same untyped load of the operations fixture as the CLI tests (outside this package's rootDir).
const { createAuthRuntimeFixture, persistRuntimeDelegations } = await import(
  new URL("../../operations/test-support/auth-runtime.ts", import.meta.url).href
);
type HermeticFixture = {
  hermetic: { host: string; ownerDid: string; ownerPrivateKey: string; restorableSession: { spaceId: string } };
};

// TC-2944: on the production node, a hosted secret read, including the replay
// of the agent's grant, uses only its dedicated vault address. Two loopback
// forwarders stand in for the two production names in front of one loopback node.
const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const SECRET_NAME = "HERMETIC_DELEGATION_CANARY";
const SECRET_PREFIX = "vault/secrets/";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Server = Bun.Server<undefined>;

async function hostedFixture() {
  // One tenant state root per test, inside the private test home.
  const previousHome = process.env.TC_HOME;
  const home = await mkdtemp(join(process.env.HOME!, "tc2944-hosted-"));
  process.env.TC_HOME = home;
  cleanups.push(async () => {
    if (previousHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const fixture = await createAuthRuntimeFixture({ secretPayloadValue: "tc2944-hosted-dummy" });
  cleanups.push(() => fixture.hermetic.stop());
  const originalFetch = globalThis.fetch;
  const seen = { proxied: [] as string[], tee: [] as string[] };
  const forwarder = (log: string[], redirectTo?: () => string | undefined): Server => Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      log.push(`${request.method} ${url.pathname}`);
      const location = redirectTo?.();
      if (location !== undefined) return Response.redirect(`${location}${url.pathname}${url.search}`, 307);
      return originalFetch(new Request(`${fixture.hermetic.host}${url.pathname}${url.search}`, request), { redirect: "manual" });
    },
  });
  let teeRedirects = false;
  const proxied = forwarder(seen.proxied);
  const tee = forwarder(seen.tee, () => teeRedirects ? proxied.url.origin : undefined);
  const loopback = new Map([[PROXIED, proxied.url.origin], [TEE, tee.url.origin]]);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const origin = loopback.get(url.origin);
    if (origin === undefined) return originalFetch(input, init);
    const target = `${origin}${url.pathname}${url.search}`;
    return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
    proxied.stop(true);
    tee.stop(true);
  });

  const registry = await productionRegistry(fixture);
  cleanups.push(() => registry.stop(true));
  const previousRegistry = process.env.TC_REGISTRY_URL;
  delete process.env.TC_REGISTRY_URL;
  cleanups.push(() => {
    if (previousRegistry !== undefined) process.env.TC_REGISTRY_URL = previousRegistry;
  });

  const spaceId = fixture.hermetic.restorableSession.spaceId;
  const profile = await readJson<Record<string, unknown>>(profileConfigPath(fixture.profile));
  await writeJsonAtomic(profileConfigPath(fixture.profile), { ...profile, host: PROXIED, tinycloudRegistryUrl: registry.url.origin });
  await writeJsonAtomic(sessionPath(fixture.profile), { ...fixture.hermetic.restorableSession, tinycloudHosts: [PROXIED] });
  const grant = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [{ ...grant, host: PROXIED }]);

  // The hosted server's tool registration for one tenant's state root.
  const server = new McpServer({ name: "tinycloud-mcp", version: "test" });
  registerTinyCloudTools(server, {
    surface: "hosted",
    profile: fixture.profile,
    explicitProfile: true,
    allowOwnerProfile: false,
    stateRoot: process.env.TC_HOME!,
  }, createJsonSchemaValidator());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tc2944-test", version: "1.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;
  return { call, seen, spaceId, stopTee: () => tee.stop(true), redirectTee: () => { teeRedirects = true; } };
}

async function productionRegistry(fixture: HermeticFixture): Promise<Server> {
  const signer = new PrivateKeySigner(fixture.hermetic.ownerPrivateKey);
  const { nodeId: nodeDid } = await (await fetch(`${fixture.hermetic.host}/info`)).json() as { nodeId: string };
  const record = await signLocationRecordV2({
    version: 2, subject: fixture.hermetic.ownerDid, nodes: [{ did: nodeDid, url: PROXIED }],
    spaces: [{ space: fixture.hermetic.restorableSession.spaceId.toLowerCase(), nodes: [{ did: nodeDid, mode: "read-write" }] }],
    encryptionNode: nodeDid, updated_at: new Date().toISOString(), sequence: 0,
  }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ record }) });
}

const invokes = (log: readonly string[]) => log.filter((entry) => entry === "POST /invoke").length;

test("hosted secret reads on the production node use only its vault address; listings and metadata of secrets are not offered", async () => {
  const { call, seen, spaceId } = await hostedFixture();

  expect(await call("tinycloud_secrets_get", { name: SECRET_NAME })).toMatchObject({
    status: "ok",
    output: { value: "tc2944-hosted-dummy" },
  });
  expect(invokes(seen.tee)).toBeGreaterThan(0);
  expect(seen.tee.some((entry) => entry.includes("/encryption/"))).toBe(true);
  const invokesAfterGet = invokes(seen.tee);

  // Secret names and sizes have no hosted listing or metadata path at all.
  expect(await call("tinycloud_kv_list", { space: spaceId, prefix: SECRET_PREFIX })).toMatchObject({
    status: "error",
    error: { code: "INPUT_INVALID" },
  });
  expect(await call("tinycloud_kv_head", { space: spaceId, key: `${SECRET_PREFIX}${SECRET_NAME}` })).toMatchObject({
    status: "error",
    error: { code: "INPUT_INVALID" },
  });
  // Refused locally: the only traffic is the agent's grant replay, on the vault address.
  expect(invokes(seen.tee)).toBe(invokesAfterGet);
  expect(seen.proxied).toEqual([]);
}, 60_000);

test("hosted secret reads fail when the vault address is down and never use the other name", async () => {
  const { call, seen, stopTee } = await hostedFixture();
  stopTee();

  expect(await call("tinycloud_secrets_get", { name: SECRET_NAME })).toMatchObject({
    status: "error",
    error: { code: "NODE_NOT_RESPONDING" },
  });
  expect(seen.proxied).toEqual([]);
}, 60_000);

test("a redirect from the vault address is not followed to the other name", async () => {
  const { call, seen, redirectTee } = await hostedFixture();
  redirectTee();

  expect(await call("tinycloud_secrets_get", { name: SECRET_NAME })).toMatchObject({ status: "error" });
  expect(seen.tee.length).toBeGreaterThan(0);
  expect(seen.proxied).toEqual([]);
}, 60_000);
