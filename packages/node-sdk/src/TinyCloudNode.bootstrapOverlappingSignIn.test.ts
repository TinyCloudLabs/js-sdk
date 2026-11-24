import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, describe, expect, test } from "bun:test";
import { ServiceContext, type BootstrapStep, type ServiceSession } from "@tinycloud/sdk-core";
import { SiweMessage } from "siwe";
import { TinyCloudNode } from "./TinyCloudNode";

// TC-3931: two sign-ins on one TinyCloudNode that overlap each run their own
// account setup. Each setup signs with its own bootstrap grant, never the
// other's, and once both end only the app's own grant is left.

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HOST = "https://tinycloud.test";
const DEFAULT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const ACCOUNT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
const PRIMARY_VM = "did:key:primary#primary";
const FIRST_VM = "did:key:account-1#account-1";
const SECOND_VM = "did:key:account-2#account-2";
// The account space's ceremony: one bootstrap grant, then a provisioning step signed with it.
const STEP_IDS = new Set(["session:account", "host:account", "activate:account", "account:index-schema"]);
// In the account grant (kv put on `spaces/`), outside the app's own recap (kv on `default`).
const OUT_OF_MANIFEST_KEY = "spaces/out-of-manifest";
const PROVISIONING = `${ACCOUNT_SPACE}/sql/account`;

type Signature = { by: string; ops: string[] };
type Grant = { provenance: string };
type BootstrapScopeView = { grants: Grant[]; graph: { assertActive(): void } };

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

/** A node that records who signed each invocation; it can hold the first SQL request until released. */
class FakeCloud {
  readonly signed: Signature[] = [];
  private holdNextSql = false;
  private readonly sqlReached = Promise.withResolvers<void>();
  private readonly sqlReleased = Promise.withResolvers<void>();

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

  /** Signers of the invocations from index `from` (inclusive) to `to` (exclusive) touching `fragment`. */
  signersOf(fragment: string, from = 0, to = this.signed.length): string[] {
    return this.signed.slice(from, to)
      .filter((entry) => entry.ops.some((op) => op.includes(fragment)))
      .map((entry) => entry.by);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (!url.endsWith("/invoke")) {
      return Response.json({ activated: [authorization.replace("Bearer ", "")] });
    }
    const att = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString()).att;
    if (Object.keys(att).some((resource) => resource.includes("/sql/"))) {
      if (this.holdNextSql) {
        this.holdNextSql = false;
        this.sqlReached.resolve();
        await this.sqlReleased.promise;
      }
      const body = JSON.parse(String(init?.body));
      return Response.json(body.action === "query" ? { rows: [], columns: [] } : { results: [] });
    }
    return new Response("", { status: 200 });
  };
}

function makeNode(cloud: FakeCloud) {
  const primary = sessionFor(DEFAULT_SPACE, "primary");
  const node: TinyCloudNode = Reflect.construct(TinyCloudNode, [{
    host: HOST,
    tinycloudRegistryUrl: null,
    notificationHandler: { success: () => {}, warning: () => {}, error: () => {} },
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
  // Each sign-in's account setup gets a bootstrap session of its own: account-1, then account-2.
  let bootstrapSessions = 0;
  Reflect.set(node, "auth", {
    address: (): string | undefined => undefined,
    tinyCloudSession: primary,
    capabilityRequest: undefined,
    lastActivationSkippedSpaceIds: [] as string[],
    hosts: [HOST],
    registryRecordPresent: false,
    resolveResourceDestinations: async () => [{ url: HOST }],
    createBootstrapSession: async ({ spaceId }: { spaceId: string }) =>
      sessionFor(spaceId, `${spaceId.split(":").at(-1)!}-${++bootstrapSessions}`),
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

describe("two overlapping sign-ins keep their account setups apart (TC-3931)", () => {
  test("each setup signs with its own bootstrap grant, and afterwards only the primary grant remains", async () => {
    const cloud = new FakeCloud();
    globalThis.fetch = cloud.fetch as typeof fetch;
    const { node, scopes, runtimeGrants, grantFor } = makeNode(cloud);

    // The first sign-in's setup is mid-step: its index request waits on the node.
    const held = cloud.holdSql();
    const first = node.signIn();
    await held;
    const firstHeld = cloud.signed.length;
    expect(cloud.signersOf(PROVISIONING)).toEqual([FIRST_VM]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.grants.map((grant) => grant.provenance)).toEqual(["bootstrap"]);

    // A second sign-in runs its whole setup while the first is still waiting.
    await node.signIn();
    const secondDone = cloud.signed.length;
    expect(node.bootstrapStatus).toEqual({ skipped: false });
    expect(scopes).toHaveLength(2);
    const secondSigners = cloud.signersOf(PROVISIONING, firstHeld, secondDone);
    expect(secondSigners.length).toBeGreaterThan(0);
    expect(new Set(secondSigners)).toEqual(new Set([SECOND_VM]));
    // The second setup's grant ended with it; the first's is still its own.
    expect(scopes[1]!.grants).toHaveLength(0);
    expect(() => scopes[1]!.graph.assertActive()).toThrow("retired");
    expect(scopes[0]!.grants.map((grant) => grant.provenance)).toEqual(["bootstrap"]);
    // Neither setup's grant reached the runtime: public calls sign with the app's session.
    expect(runtimeGrants().filter((grant) => grant.provenance !== "delegated").map((grant) => grant.provenance))
      .toEqual(["primary"]);
    expect(grantFor(OUT_OF_MANIFEST_KEY, "tinycloud.kv/put")).toBeUndefined();
    await node.kvForSpace(ACCOUNT_SPACE).put(OUT_OF_MANIFEST_KEY, "x");
    expect(cloud.signersOf(OUT_OF_MANIFEST_KEY)).toEqual([PRIMARY_VM]);

    // The second sign-in replaced the first one's session, so the first setup stops:
    // it signs nothing more, and never with the second setup's grant.
    cloud.release();
    await first;
    expect(cloud.signersOf(PROVISIONING, secondDone)).toEqual([]);
    expect(cloud.signed.slice(secondDone).filter((entry) => entry.by !== PRIMARY_VM)).toEqual([]);
    expect(cloud.signed.slice(0, firstHeld).some((entry) => entry.by === SECOND_VM)).toBe(false);
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) {
      expect(scope.grants).toHaveLength(0);
      expect(() => scope.graph.assertActive()).toThrow("retired");
    }
    expect(runtimeGrants().filter((grant) => grant.provenance !== "delegated").map((grant) => grant.provenance))
      .toEqual(["primary"]);
    expect(grantFor(OUT_OF_MANIFEST_KEY, "tinycloud.kv/put")).toBeUndefined();
    await node.kvForSpace(ACCOUNT_SPACE).put(OUT_OF_MANIFEST_KEY, "y");
    expect(cloud.signersOf(OUT_OF_MANIFEST_KEY)).toEqual([PRIMARY_VM, PRIMARY_VM]);
  });
});
