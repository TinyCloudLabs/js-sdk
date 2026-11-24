import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, describe, expect, test } from "bun:test";
import { ServiceContext, bootstrapSteps, type BootstrapStep, type ServiceSession } from "@tinycloud/sdk-core";
import { SiweMessage } from "siwe";
import { TinyCloudNode } from "./TinyCloudNode";

// TC-3443: a bootstrap grant belongs to its bootstrap attempt alone. Public
// calls made while that attempt runs, and every call after it, sign with the
// app's own session.

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HOST = "https://tinycloud.test";
const DEFAULT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const ACCOUNT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
const PRIMARY_VM = "did:key:primary#primary";
const ACCOUNT_VM = "did:key:account#account";
// The account space's ceremony: one bootstrap grant, then a provisioning step signed with it.
const STEP_IDS = new Set(["session:account", "host:account", "activate:account", "account:index-schema"]);
// In the account grant (kv put on `spaces/`), outside the app's own recap (kv on `default`).
const OUT_OF_MANIFEST_KEY = "spaces/out-of-manifest";

type Signature = { by: string; ops: string[] };

type BootstrapScopeView = {
  grants: { provenance: string }[];
  graph: { assertActive(): void };
};

type Grant = { provenance: string };

function siwe(): string {
  return new SiweMessage({
    domain: "app.test",
    address: ADDRESS,
    uri: "https://app.test",
    version: "1",
    chainId: 1,
    nonce: "bootstrapnonce1",
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
  }).prepareMessage();
}

function sessionFor(spaceId: string, name: string) {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: name,
    spaceId,
    delegationHeader: { Authorization: `Bearer ${spaceId}` },
    delegationCid: `cid:${name}`,
    verificationMethod: `did:key:${name}#${name}`,
    jwk: { kty: "OKP", crv: "Ed25519", x: name },
    siwe: siwe(),
  };
}

/** A node that records who signed each invocation and serves the account space. */
class FakeCloud {
  readonly signed: Signature[] = [];
  failSql = false;
  private holdNextSql = false;
  private readonly sqlReached = Promise.withResolvers<void>();
  private readonly sqlReleased = Promise.withResolvers<void>();

  /** Hold the next SQL request until `release()`; resolves once it arrives. */
  holdSql(): Promise<void> {
    this.holdNextSql = true;
    return this.sqlReached.promise;
  }

  release(): void {
    this.sqlReleased.resolve();
  }

  sign(session: ServiceSession, ops: { resource: string; action: string }[]): Record<string, string> {
    const att: Record<string, Record<string, unknown[]>> = {};
    for (const { resource, action } of ops) {
      att[resource] = { ...att[resource], [action]: [{}] };
    }
    this.signed.push({
      by: session.verificationMethod,
      ops: ops.map(({ resource, action }) => `${resource}#${action}`),
    });
    const payload = Buffer.from(JSON.stringify({ iss: session.verificationMethod, att })).toString("base64url");
    return { Authorization: `h.${payload}.s` };
  }

  signersOf(fragment: string): string[] {
    return this.signed.filter((entry) => entry.ops.some((op) => op.includes(fragment))).map((entry) => entry.by);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (!url.endsWith("/invoke")) {
      // Session activation.
      return Response.json({ activated: [authorization.replace("Bearer ", "")] });
    }
    const att = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString()).att;
    if (Object.keys(att).some((resource) => resource.includes("/sql/"))) {
      if (this.holdNextSql) {
        this.holdNextSql = false;
        this.sqlReached.resolve();
        await this.sqlReleased.promise;
      }
      if (this.failSql) return new Response("boom", { status: 400 });
      const body = JSON.parse(String(init?.body));
      return Response.json(body.action === "query" ? { rows: [], columns: [] } : { results: [] });
    }
    return new Response("", { status: 200 });
  };
}

function makeNode(cloud: FakeCloud, warning: (message: string) => void = () => {}) {
  const primary = sessionFor(DEFAULT_SPACE, "primary");
  const node: TinyCloudNode = Reflect.construct(TinyCloudNode, [{
    host: HOST,
    tinycloudRegistryUrl: null,
    notificationHandler: { success: () => {}, warning, error: () => {} },
    wasmBindings: {
      makeSpaceId: (address: string, chainId: number, name: string) => `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
      createSessionManager: () => ({
        createSessionKey: (id: string) => id,
        replaceSessionKey: (_jwk: object, keyId: string) => keyId,
        renameSessionKeyId: () => {},
        getDID: (keyId: string) => `did:key:${keyId}`,
        jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
      }),
      // The app's own recap: kv on its default space only.
      parseRecapFromSiwe: (message: string) => message === primary.siwe
        ? [{ service: "tinycloud.kv", space: DEFAULT_SPACE, path: "", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }]
        : [],
      invoke: (session: ServiceSession, service: string, path: string, action: string) =>
        cloud.sign(session, [{ resource: `${session.spaceId}/${service}/${path}`, action }]),
      invokeAny: (session: ServiceSession, entries: { spaceId?: string; resource?: string; service: string; path: string; action: string }[]) =>
        cloud.sign(session, entries.map((entry) => ({
          resource: `${entry.spaceId ?? entry.resource}/${entry.service}/${entry.path}`,
          action: entry.action,
        }))),
    },
  }]);
  Reflect.set(node, "auth", {
    address: (): string | undefined => undefined,
    tinyCloudSession: primary,
    capabilityRequest: undefined,
    lastActivationSkippedSpaceIds: [] as string[],
    hosts: [HOST],
    registryRecordPresent: false,
    resolveResourceDestinations: async () => [{ url: HOST }],
    createBootstrapSession: async ({ spaceId }: { spaceId: string }) => sessionFor(spaceId, spaceId.split(":").at(-1)!),
    hostOwnedSpaceResult: async () => ({ success: true, status: 200 }),
  });
  Reflect.set(node, "signer", { getAddress: async () => ADDRESS, getChainId: async () => 1 });
  Reflect.set(node, "tc", { signIn: async () => {}, retireServices: () => {} });
  Reflect.set(node, "syncResolvedHostFromAuth", () => {});
  Reflect.set(node, "initializeServices", () => {
    const graph = Reflect.get(node, "_serviceGraph");
    const context = new ServiceContext({ invoke: graph.invoke, invokeAny: graph.invokeAny, fetch: graph.fetch, hosts: [HOST] });
    context.setSession({
      delegationHeader: primary.delegationHeader,
      delegationCid: primary.delegationCid,
      spaceId: primary.spaceId,
      verificationMethod: primary.verificationMethod,
      jwk: primary.jwk,
    });
    Reflect.set(node, "_serviceContext", context);
  });
  Reflect.set(node, "resolveBootstrapDecision", async () => ({ action: "run", mode: "fresh" }));
  Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
  Reflect.set(node, "scheduleAccountRegistrySync", () => {});

  const scopes: BootstrapScopeView[] = [];
  const createScope = Reflect.get(node, "createBootstrapScope");
  Reflect.set(node, "createBootstrapScope", () => {
    const scope = createScope.call(node);
    scopes.push(scope);
    return scope;
  });
  const run = Reflect.get(node, "runAccountBootstrap");
  Reflect.set(node, "runAccountBootstrap", (steps: BootstrapStep[], options: unknown, scope: unknown) =>
    run.call(node, steps.filter((step) => STEP_IDS.has(step.id)), options, scope));

  const runtimeGrants = (): Grant[] => Reflect.get(node, "runtimePermissionGrants");
  const grantFor = (path: string, action: string) =>
    Reflect.get(node, "findGrantForOperation").call(node, { spaceId: ACCOUNT_SPACE, service: "kv", path, action });
  return { node, scopes, runtimeGrants, grantFor };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("bootstrap grants stay with their bootstrap attempt (TC-3443)", () => {
  test("the test steps are part of the canonical ceremony", () => {
    const ids = bootstrapSteps(ADDRESS, 1).map((step) => step.id);
    for (const id of STEP_IDS) expect(ids).toContain(id);
  });

  test("a public call made while a provisioning step is in flight signs with the app's session", async () => {
    const cloud = new FakeCloud();
    globalThis.fetch = cloud.fetch as typeof fetch;
    const { node, scopes, runtimeGrants, grantFor } = makeNode(cloud);
    const held = cloud.holdSql();

    const signingIn = node.signIn();
    await held;
    // The attempt holds its account grant while its index step waits on the node.
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.grants.map((grant) => grant.provenance)).toEqual(["bootstrap"]);

    const put = await node.kvForSpace(ACCOUNT_SPACE).put(OUT_OF_MANIFEST_KEY, "x");
    expect(put.ok).toBe(true);
    expect(cloud.signersOf(OUT_OF_MANIFEST_KEY)).toEqual([PRIMARY_VM]);

    await node.invokeAny([{ spaceId: ACCOUNT_SPACE, service: "sql", path: "account", action: "tinycloud.sql/write" }]);
    expect(cloud.signed.at(-1)).toEqual({
      by: PRIMARY_VM,
      ops: [`${ACCOUNT_SPACE}/sql/account#tinycloud.sql/write`],
    });

    expect(grantFor(OUT_OF_MANIFEST_KEY, "tinycloud.kv/put")).toBeUndefined();
    expect(runtimeGrants().map((grant) => grant.provenance)).toEqual(["primary"]);

    cloud.release();
    await signingIn;
    expect(node.bootstrapStatus).toEqual({ skipped: false });
  });

  test("a provisioning step signs with its attempt's bootstrap grant; afterwards only the primary grant remains", async () => {
    const cloud = new FakeCloud();
    globalThis.fetch = cloud.fetch as typeof fetch;
    const { node, scopes, runtimeGrants, grantFor } = makeNode(cloud);

    await node.signIn();

    expect(node.bootstrapStatus).toEqual({ skipped: false });
    const provisioning = cloud.signersOf(`${ACCOUNT_SPACE}/sql/account`);
    expect(provisioning.length).toBeGreaterThan(0);
    expect(new Set(provisioning)).toEqual(new Set([ACCOUNT_VM]));

    expect(runtimeGrants().filter((grant) => grant.provenance !== "delegated").map((grant) => grant.provenance))
      .toEqual(["primary"]);
    expect(scopes[0]!.grants).toHaveLength(0);
    expect(() => scopes[0]!.graph.assertActive()).toThrow("retired");
    expect(grantFor(OUT_OF_MANIFEST_KEY, "tinycloud.kv/put")).toBeUndefined();

    await node.kvForSpace(ACCOUNT_SPACE).put(OUT_OF_MANIFEST_KEY, "x");
    expect(cloud.signersOf(OUT_OF_MANIFEST_KEY)).toEqual([PRIMARY_VM]);
  });

  test("a failed step whose warning handler throws still ends the attempt's grants", async () => {
    const cloud = new FakeCloud();
    cloud.failSql = true;
    globalThis.fetch = cloud.fetch as typeof fetch;
    const { node, scopes, runtimeGrants, grantFor } = makeNode(cloud, () => {
      throw new Error("warning handler failed");
    });

    await expect(node.signIn()).rejects.toThrow("warning handler failed");

    expect(node.bootstrapStatus.skipped).toBe(true);
    expect(node.bootstrapStatus.reason).toContain("Failed to create account index schema");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.grants).toHaveLength(0);
    expect(() => scopes[0]!.graph.assertActive()).toThrow("retired");
    expect(runtimeGrants().some((grant) => grant.provenance === "bootstrap")).toBe(false);
    expect(grantFor(OUT_OF_MANIFEST_KEY, "tinycloud.kv/put")).toBeUndefined();

    cloud.failSql = false;
    await node.kvForSpace(ACCOUNT_SPACE).put(OUT_OF_MANIFEST_KEY, "x");
    expect(cloud.signersOf(OUT_OF_MANIFEST_KEY)).toEqual([PRIMARY_VM]);
  });
});
