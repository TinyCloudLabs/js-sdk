import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Manifest } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const testHome = mkdtempSync("/var/tmp/account-index-read-only.");
if (!testHome.startsWith("/var/tmp/account-index-read-only.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = testHome;
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

/** One `POST /invoke` the node saw: what the invocation asked for and how the node answered. */
interface Invocation {
  readonly status: number;
  /** `resource-path:ability` pairs with the space prefix stripped, e.g. `account/sql/account:tinycloud.sql/read`. */
  readonly abilities: readonly string[];
  /** Response body of a refusal; empty for 2xx. */
  readonly refusal: string;
}

interface InvokeAtt {
  readonly att: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function abilitiesOf(authorization: string): string[] {
  const claims = authorization.split(".")[1];
  if (claims === undefined) return [];
  const { att } = JSON.parse(Buffer.from(claims, "base64url").toString()) as InvokeAtt;
  return Object.entries(att).flatMap(([resource, abilities]) =>
    Object.keys(abilities).map((ability) => `${resource.replace(/^tinycloud:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:/, "")}:${ability}`),
  );
}

/** Records every invocation sent to `nodeHost` until `stop()`; the node's own answer is what is observed. */
function recordInvocations(nodeHost: string) {
  const invocations: Invocation[] = [];
  const nativeFetch = globalThis.fetch;
  const recording = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const response = await nativeFetch(input, init);
    if (url.origin === nodeHost && url.pathname === "/invoke" && (init?.method ?? request?.method) === "POST") {
      const authorization = new Headers(init?.headers ?? request?.headers).get("authorization") ?? "";
      invocations.push({
        status: response.status,
        abilities: abilitiesOf(authorization),
        refusal: response.ok ? "" : await response.clone().text(),
      });
    }
    return response;
  };
  globalThis.fetch = Object.assign(recording, { preconnect: nativeFetch.preconnect }) as typeof fetch;
  return {
    invocations,
    stop: () => {
      globalThis.fetch = nativeFetch;
    },
  };
}

const sqlNonRead = (invocations: readonly Invocation[]) =>
  invocations.filter((invocation) => invocation.abilities.some((ability) => /:tinycloud\.sql\/(?!read$)/.test(ability)));
const unauthorized = (invocations: readonly Invocation[]) =>
  invocations.filter((invocation) => invocation.status === 401);

/** The account site's manifest; only the account-index SQL grant varies. */
const accountSiteManifest = (sqlActions: string[]): Manifest => ({
  app_id: "xyz.tinycloud.account-site.test",
  name: "Account site",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    { service: "tinycloud.sql", space: "account", path: "account", actions: sqlActions, skipPrefix: true },
    { service: "tinycloud.kv", space: "account", path: "applications/", actions: ["get", "list", "put"], skipPrefix: true },
    { service: "tinycloud.kv", space: "account", path: "spaces/", actions: ["get", "list", "put"], skipPrefix: true },
    { service: "tinycloud.space", space: "account", path: "", actions: ["list"], skipPrefix: true },
    { service: "tinycloud.delegation", space: "account", path: "", actions: ["list", "status"], skipPrefix: true },
  ],
});

describe.skipIf(!nodeBinary)("account index with and without sql write on the account space (real node)", () => {
  let node: LocalNode | undefined;
  let registry: UnregisteredLocationRegistry;

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    node = await startLocalNode(nodeBinary!, "/var/tmp/account-index-read-only-node-");
  }, 120_000);

  afterAll(async () => {
    registry?.stop(true);
    await node?.stop();
  });

  /**
   * A brand-new account's session as the account site builds it. Account bootstrap is off because
   * the site signs in through a wallet that provisions the account elsewhere: the SDK itself
   * must not find (or create) an index on this account.
   */
  function accountSiteSession(sqlActions: string[]): TinyCloudNode {
    return new TinyCloudNode({
      host: node!.host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey: randomBytes(32).toString("hex"),
      wasmBindings: new NodeWasmBindings(),
      domain: "account-index-read-only.test",
      prefix: "account",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      manifest: accountSiteManifest(sqlActions),
    });
  }

  test("a session with only sql read lists spaces without sending a schema or write the node refuses", async () => {
    const session = accountSiteSession(["read"]);
    const wire = recordInvocations(node!.host);
    try {
      await session.signIn();
      await session.waitForAccountRegistrySync();
      const afterSignIn = wire.invocations.length;

      const listed = await session.account.spaces.list({ preferIndex: true, refreshIndex: false });
      expect(listed.ok, JSON.stringify(listed.ok ? undefined : listed.error)).toBe(true);
      expect(listed.ok && listed.data.length).toBeGreaterThan(0);

      const listing = wire.invocations.slice(afterSignIn);
      // It did try the index first, and the node says the fresh account has none...
      const indexRead = listing.find((invocation) => invocation.abilities.includes("account/sql/account:tinycloud.sql/read"));
      expect(indexRead?.status).toBe(400);
      expect(indexRead?.refusal).toContain("no such table");
      // ...and the listing never asked the node to create it.
      expect(sqlNonRead(listing)).toEqual([]);
      expect(unauthorized(listing)).toEqual([]);
    } finally {
      wire.stop();
    }
  }, 120_000);

  test("the whole session, sign-in included, sends no sql schema or write and gets no 401", async () => {
    const session = accountSiteSession(["read"]);
    const wire = recordInvocations(node!.host);
    try {
      await session.signIn();
      await session.waitForAccountRegistrySync();
      const listed = await session.account.spaces.list({ preferIndex: true, refreshIndex: false });
      expect(listed.ok, JSON.stringify(listed.ok ? undefined : listed.error)).toBe(true);

      expect(sqlNonRead(wire.invocations)).toEqual([]);
      expect(unauthorized(wire.invocations)).toEqual([]);
    } finally {
      wire.stop();
    }
  }, 120_000);

  test("control: a session granted sql read, write and schema still creates the account index", async () => {
    const session = accountSiteSession(["read", "write", "schema"]);
    const wire = recordInvocations(node!.host);
    try {
      await session.signIn();
      await session.waitForAccountRegistrySync();
      const listed = await session.account.spaces.list({ preferIndex: true, refreshIndex: false });
      expect(listed.ok, JSON.stringify(listed.ok ? undefined : listed.error)).toBe(true);

      // The schema request went out and the node accepted it.
      const schema = wire.invocations.filter((invocation) => invocation.abilities.includes("account/sql/account:tinycloud.sql/schema"));
      expect(schema.length).toBeGreaterThan(0);
      expect(schema.every((invocation) => invocation.status === 200)).toBe(true);
      expect(unauthorized(wire.invocations)).toEqual([]);

      // The table is there afterwards and holds the registered spaces.
      const ensured = await session.account.index.ensure();
      expect(ensured.ok, JSON.stringify(ensured.ok ? undefined : ensured.error)).toBe(true);
      const count = await session.sqlForSpace(session.accountSpaceId!).db("account").query<number>("SELECT count(*) FROM spaces");
      expect(count.ok, JSON.stringify(count.ok ? undefined : count.error)).toBe(true);
      expect(count.ok && count.data.rows[0]?.[0]).toBeGreaterThan(0);
    } finally {
      wire.stop();
    }
  }, 120_000);
});
