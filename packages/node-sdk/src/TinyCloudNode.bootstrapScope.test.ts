import { afterEach, describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_ALLOWLIST,
  SERVICE_SHORT_TO_LONG,
  bootstrapSpaceId,
  type IWasmBindings,
} from "@tinycloud/sdk-core";
import { BOOTSTRAP_SESSION_EXPIRY_MS } from "./authorization/bootstrapSessionScope";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { BOOTSTRAP_COMPLETION_MARKER_KEY, TinyCloudNode } from "./TinyCloudNode";

// TC-2038: account bootstrap signs one session per space whose data a step
// writes (account, secrets), scopes each to that step, keeps it for minutes,
// and never leaves it behind as a runtime grant or on disk.

const ADDRESS = "0x1234567890AbcdEF1234567890aBcdef12345678";
const CHAIN_ID = 1;
const HOST = "https://tinycloud.test";
const NETWORK_URN = `urn:tinycloud:encryption:did:pkh:eip155:${CHAIN_ID}:${ADDRESS}:default`;
const space = (name: string) => `tinycloud:pkh:eip155:${CHAIN_ID}:${ADDRESS}:${name}`;

interface PreparedParams {
  spaceId: string;
  issuedAt: string;
  expirationTime: string;
  notBefore?: string;
  spaceAbilities: Record<string, Record<string, Record<string, string[]>>>;
  rawAbilities?: Record<string, string[]>;
  jwk: object;
}

interface RuntimeGrantView {
  provenance: string;
  expiresAt: Date;
  delegation: { cid: string };
  operations?: RuntimeOperation[];
}

interface RuntimeOperation {
  spaceId?: string;
  resource?: string;
  service: string;
  path: string;
  action: string;
}

interface StepProbe {
  stage: string;
  /** Provenance of the grant selected for the operation the step performs. */
  selected: string | undefined;
  /** Expiry of every bootstrap grant installed at that moment. */
  bootstrapExpiries: Date[];
}

function makeWasm(captured: PreparedParams[]): IWasmBindings {
  const keys = new Map<string, string>();
  const ensureKey = (id: string): string => {
    if (!keys.has(id)) keys.set(id, JSON.stringify({ kty: "OKP", kid: id }));
    return id;
  };
  const sessionManager = {
    createSessionKey: ensureKey,
    replaceSessionKey: (jwk: object, keyId: string) => {
      keys.set(keyId, JSON.stringify(jwk));
      return keyId;
    },
    renameSessionKeyId: (_old: string, id: string) => {
      ensureKey(id);
    },
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: (keyId: string) => {
      ensureKey(keyId);
      return keys.get(keyId);
    },
  };
  let counter = 0;
  return {
    prepareSession: (params: PreparedParams) => {
      captured.push(params);
      return {
        siwe: [
          "example.com wants you to sign in with your Ethereum account:",
          ADDRESS,
          "",
          "TinyCloud bootstrap",
          "",
          "URI: did:key:test",
          "Version: 1",
          `Chain ID: ${CHAIN_ID}`,
          "Nonce: abcdef12345",
          `Issued At: ${params.issuedAt}`,
          `Expiration Time: ${params.expirationTime}`,
        ].join("\n"),
        jwk: params.jwk,
        spaceId: params.spaceId,
        verificationMethod: "did:key:verification",
      };
    },
    completeSessionSetup: () => {
      const cid = `bafy-bootstrap-${++counter}`;
      return { delegationHeader: { Authorization: `Bearer ${cid}` }, delegationCid: cid };
    },
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createSessionManager: () => sessionManager,
  } as unknown as IWasmBindings;
}

interface HarnessOptions {
  /** Whether the sign-in session's recap already covers a marker write. Default true. */
  markerCovered?: boolean;
  siweConfig?: { expirationTime?: string; notBefore?: string };
  /** Runs inside the account index step, after this run's grants are installed. */
  duringIndex?: (node: TinyCloudNode) => void;
}

interface Harness {
  node: TinyCloudNode;
  captured: PreparedParams[];
  storage: MemorySessionStorage;
  saves: number;
  probes: StepProbe[];
  failAt?: string;
}

function grants(node: TinyCloudNode): RuntimeGrantView[] {
  return Reflect.get(node, "runtimePermissionGrants") as RuntimeGrantView[];
}

function selectGrant(node: TinyCloudNode, operation: RuntimeOperation): RuntimeGrantView | undefined {
  const find = Reflect.get(node, "findGrantForOperations") as (
    operations: RuntimeOperation[],
  ) => RuntimeGrantView | undefined;
  return find.call(node, [operation]);
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const captured: PreparedParams[] = [];
  const wasm = makeWasm(captured);
  const storage = new MemorySessionStorage();
  const harness: Harness = { node: undefined as never, captured, storage, saves: 0, probes: [] };
  const save = storage.save.bind(storage);
  storage.save = async (...args) => {
    harness.saves++;
    return save(...args);
  };

  const auth = new NodeUserAuthorization({
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => CHAIN_ID,
      signMessage: async () => "0xsigned",
    },
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: [HOST],
    sessionStorage: storage,
    ...(options.siweConfig ? { siweConfig: options.siweConfig } : {}),
  });
  Reflect.set(auth, "_address", ADDRESS);
  Reflect.set(auth, "_chainId", CHAIN_ID);
  Reflect.set(auth, "hostOwnedSpaceResult", async () => ({ success: true, status: 200 }));
  // Fresh account: the account space is not hosted yet.
  Reflect.set(auth, "_lastActivationSkippedSpaceIds", [space("account")]);

  const node: TinyCloudNode = Reflect.construct(TinyCloudNode, [{ host: HOST, wasmBindings: wasm }]);
  harness.node = node;
  Reflect.set(node, "_address", ADDRESS);
  Reflect.set(node, "_chainId", CHAIN_ID);
  Reflect.set(node, "auth", auth);
  Reflect.set(node, "assertMayCreateSpace", async () => {});
  Reflect.set(node, "currentSessionCoversBootstrapMarker", () => options.markerCovered ?? true);

  const probe = (stage: string, operation: RuntimeOperation) => {
    harness.probes.push({
      stage,
      selected: selectGrant(node, operation)?.provenance,
      bootstrapExpiries: grants(node)
        .filter((grant) => grant.provenance === "bootstrap")
        .map((grant) => grant.expiresAt),
    });
    if (harness.failAt === stage) throw new Error(`injected failure at ${stage}`);
  };
  const accountOp = (service: string, path: string, action: string): RuntimeOperation => ({
    spaceId: space("account"),
    service,
    path,
    action,
  });
  Reflect.set(node, "_account", {
    index: {
      async ensure() {
        probe("index", accountOp("sql", "account", "tinycloud.sql/schema"));
        options.duringIndex?.(node);
        return { ok: true, data: undefined };
      },
    },
    spaces: {
      async registerBatch() {
        probe("spaces", accountOp("kv", "spaces/x", "tinycloud.kv/put"));
        return { ok: true, data: { spaces: [] } };
      },
      async registerMissing() {
        return { ok: true, data: [] };
      },
    },
    applications: {
      async register() {
        probe("applications", accountOp("kv", "applications/app", "tinycloud.kv/put"));
        return { ok: true, data: undefined };
      },
    },
  });
  Reflect.set(node, "ensureEncryptionNetwork", async () => {
    probe("network", {
      resource: NETWORK_URN,
      service: "encryption",
      path: NETWORK_URN,
      action: "tinycloud.encryption/network.create",
    });
  });
  Reflect.set(node, "sqlForSpace", () => ({
    db: () => ({
      migrations: {
        async apply() {
          probe("secrets-schema", {
            spaceId: space("secrets"),
            service: "sql",
            path: "default",
            action: "tinycloud.sql/schema",
          });
          return { ok: true, data: undefined };
        },
      },
    }),
  }));
  Reflect.set(node, "writeBootstrapCompletionMarker", async () => {
    probe("marker", accountOp("kv", BOOTSTRAP_COMPLETION_MARKER_KEY, "tinycloud.kv/put"));
  });
  return harness;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runBootstrap(h: Harness): Promise<boolean> {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ activated: ["x"] }), { status: 200 });
  const run = Reflect.get(h.node, "bootstrapAccountIfNeeded") as () => Promise<boolean>;
  return run.call(h.node);
}

interface RecapEntry {
  service: string;
  space: string;
  path: string;
  actions: string[];
}

/** The recap of a prepared session as the entries OpenKey's auto-sign rule sees. */
function recapEntries(params: PreparedParams): RecapEntry[] {
  const entries: RecapEntry[] = [];
  for (const [spaceId, services] of Object.entries(params.spaceAbilities)) {
    for (const [service, paths] of Object.entries(services)) {
      for (const [path, actions] of Object.entries(paths)) {
        entries.push({
          service: SERVICE_SHORT_TO_LONG[service] ?? service,
          space: spaceId,
          path,
          actions,
        });
      }
    }
  }
  for (const [resource, actions] of Object.entries(params.rawAbilities ?? {})) {
    entries.push({ service: "tinycloud.encryption", space: "encryption", path: resource, actions });
  }
  return entries;
}

/**
 * OpenKey's `evaluateBootstrapSessionCandidates`: exactly one session
 * candidate of `BOOTSTRAP_ALLOWLIST` must explain every entry of the recap,
 * and at least one entry must sit in that candidate's own space.
 */
function explainingCandidates(entries: RecapEntry[]): string[] {
  const subset = (requested: string[], allowed: readonly string[]) =>
    requested.every((action) => allowed.includes(action));
  const candidates = BOOTSTRAP_ALLOWLIST.filter((entry) => entry.kind === "session");
  return candidates
    .filter((candidate) => {
      let anchored = false;
      for (const entry of entries) {
        if (entry.service === "tinycloud.encryption") {
          const raw = candidate.rawAbilities?.find(
            (ability) =>
              ability.service === entry.service &&
              ability.resource.replace("{ownerDid}", `did:pkh:eip155:${CHAIN_ID}:${ADDRESS}`) === entry.path &&
              subset(entry.actions, ability.actions),
          );
          if (!raw || entry.space !== "encryption") return false;
          continue;
        }
        const resource = candidate.resources?.find(
          (allowed) =>
            allowed.service === entry.service &&
            allowed.path === entry.path &&
            subset(entry.actions, allowed.actions) &&
            entry.space === bootstrapSpaceId(ADDRESS, CHAIN_ID, allowed.space as never),
        );
        if (!resource) return false;
        if (entry.space === bootstrapSpaceId(ADDRESS, CHAIN_ID, candidate.space)) anchored = true;
      }
      return anchored;
    })
    .map((candidate) => candidate.space);
}

describe("TC-2038 bootstrap session scope", () => {
  test("bootstrap completes and every step runs under a bootstrap grant", async () => {
    const h = makeHarness({ markerCovered: false });
    expect(await runBootstrap(h)).toBe(true);
    expect(h.node.bootstrapStatus).toEqual({ skipped: false });
    expect(h.probes.map(({ stage, selected }) => [stage, selected])).toEqual([
      ["index", "bootstrap"],
      ["spaces", "bootstrap"],
      ["applications", "bootstrap"],
      ["network", "bootstrap"],
      ["secrets-schema", "bootstrap"],
      ["marker", "bootstrap"],
    ]);
  });

  test("when the sign-in session covers the marker, the marker is written under it", async () => {
    const h = makeHarness({ markerCovered: true });
    expect(await runBootstrap(h)).toBe(true);
    expect(h.probes.map(({ stage, selected }) => [stage, selected])).toEqual([
      ["index", "bootstrap"],
      ["spaces", "bootstrap"],
      ["applications", "bootstrap"],
      ["network", "bootstrap"],
      ["secrets-schema", "bootstrap"],
      // No bootstrap grant covers the marker; the sign-in session signs it.
      ["marker", undefined],
    ]);
  });

  test("only the account and secrets sessions are signed, scoped to their step", async () => {
    const h = makeHarness();
    await runBootstrap(h);

    expect(h.captured).toHaveLength(2);
    const bySpace = new Map(h.captured.map((params) => [params.spaceId, params]));
    expect([...bySpace.keys()].sort()).toEqual([space("account"), space("secrets")].sort());

    for (const params of h.captured) {
      const lifetime = Date.parse(params.expirationTime) - Date.parse(params.issuedAt);
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(BOOTSTRAP_SESSION_EXPIRY_MS);
      // Only the step's own space appears in the recap.
      expect(Object.keys(params.spaceAbilities)).toEqual([params.spaceId]);
    }

    const account = bySpace.get(space("account"));
    expect(account?.spaceAbilities[space("account")]).toEqual({
      kv: {
        "applications/": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
        "spaces/": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
      },
      sql: { account: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    });
    expect(account?.rawAbilities).toEqual({ [NETWORK_URN]: ["tinycloud.encryption/network.create"] });

    const secrets = bySpace.get(space("secrets"));
    expect(secrets?.spaceAbilities[space("secrets")]).toEqual({
      sql: { default: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    });
    expect(secrets?.rawAbilities).toBeUndefined();
  });

  test("the account session adds the marker only when the sign-in session does not cover it", async () => {
    const h = makeHarness({ markerCovered: false });
    await runBootstrap(h);
    const account = h.captured.find((params) => params.spaceId === space("account"));
    expect(account?.spaceAbilities[space("account")].kv[BOOTSTRAP_COMPLETION_MARKER_KEY]).toEqual([
      "tinycloud.kv/get",
      "tinycloud.kv/put",
    ]);
  });

  test("every bootstrap recap is explained by exactly one allowlist candidate, anchored in its own space", async () => {
    const h = makeHarness({ markerCovered: true });
    await runBootstrap(h);
    expect(h.captured).toHaveLength(2);
    for (const params of h.captured) {
      const spaceName = params.spaceId.split(":").at(-1);
      expect(explainingCandidates(recapEntries(params))).toEqual([spaceName]);
    }
  });

  test("the sign-in session's marker coverage is read from its recap", () => {
    const h = makeHarness();
    // Use the real method, not the harness stub.
    const covers = (operations: RuntimeOperation[]) => {
      Reflect.deleteProperty(h.node, "currentSessionCoversBootstrapMarker");
      Reflect.set(h.node, "currentTinyCloudSession", () => ({ siwe: "recap" }));
      Reflect.set(h.node, "recapOperationsFromSession", () => operations);
      const real = Reflect.get(h.node, "currentSessionCoversBootstrapMarker") as () => boolean;
      return real.call(h.node);
    };
    const marker = (extra: Partial<RuntimeOperation>): RuntimeOperation => ({
      spaceId: space("account"),
      service: "kv",
      path: BOOTSTRAP_COMPLETION_MARKER_KEY,
      action: "tinycloud.kv/put",
      ...extra,
    });
    expect(covers([marker({})])).toBe(true);
    expect(covers([marker({ path: "system/" })])).toBe(true);
    expect(covers([marker({ action: "tinycloud.kv/get" })])).toBe(false);
    expect(covers([marker({ path: "applications/" })])).toBe(false);
    expect(covers([marker({ spaceId: space("applications") })])).toBe(false);
    expect(covers([])).toBe(false);
  });

  test("the installed bootstrap grants expire within the bootstrap lifetime", async () => {
    const h = makeHarness();
    const before = Date.now();
    await runBootstrap(h);
    const expiries = h.probes.flatMap((probe) => probe.bootstrapExpiries);
    expect(expiries.length).toBeGreaterThan(0);
    for (const expiresAt of expiries) {
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(BOOTSTRAP_SESSION_EXPIRY_MS + 5_000);
    }
  });

  test("a siweConfig cannot lengthen a bootstrap session or move its start", async () => {
    const h = makeHarness({
      siweConfig: {
        expirationTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        notBefore: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    await runBootstrap(h);
    expect(h.captured).toHaveLength(2);
    for (const params of h.captured) {
      expect(Date.parse(params.expirationTime)).toBeLessThanOrEqual(
        Date.parse(params.issuedAt) + 600_000,
      );
      expect(params.notBefore).toBeUndefined();
    }
  });

  test("a siweConfig expiry earlier than the bootstrap lifetime still applies", async () => {
    const h = makeHarness({
      siweConfig: { expirationTime: new Date(Date.now() + 60_000).toISOString() },
    });
    await runBootstrap(h);
    for (const params of h.captured) {
      const lifetime = Date.parse(params.expirationTime) - Date.parse(params.issuedAt);
      expect(lifetime).toBeLessThanOrEqual(60_000);
    }
  });

  test("a narrow-manifest sign-in cannot reach outside its manifest after bootstrap", async () => {
    const h = makeHarness();
    Reflect.set(h.node, "runtimePermissionGrants", [{
      session: { spaceId: space("applications"), delegationCid: "bafy-primary" },
      delegation: { cid: "bafy-primary" },
      operations: [{
        spaceId: space("applications"),
        service: "kv",
        path: "xyz.tinycloud.tinychat/threads/",
        action: "tinycloud.kv/get",
      }],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      provenance: "primary",
    }]);
    await runBootstrap(h);

    // The reads the repro made with a bootstrap-signed invocation: no grant
    // covers them, so the call is signed by the narrow primary session and the
    // node answers 401.
    const outside: Array<[string, string, string, string]> = [
      ["applications", "kv", "xyz.tinycloud.tinychat/feed/weight/profile", "tinycloud.kv/get"],
      ["applications", "kv", "xyz.tinycloud.tinychat/feed/weight/zz", "tinycloud.kv/put"],
      ["applications", "sql", "anything", "tinycloud.sql/read"],
      ["default", "kv", "x", "tinycloud.kv/get"],
      ["account", "kv", "applications/app", "tinycloud.kv/get"],
      ["secrets", "sql", "default", "tinycloud.sql/read"],
    ];
    for (const [spaceName, service, path, action] of outside) {
      expect(selectGrant(h.node, { spaceId: space(spaceName), service, path, action })).toBeUndefined();
    }
    // What the manifest asked for still resolves to the primary grant.
    expect(
      selectGrant(h.node, {
        spaceId: space("applications"),
        service: "kv",
        path: "xyz.tinycloud.tinychat/threads/t1",
        action: "tinycloud.kv/get",
      })?.provenance,
    ).toBe("primary");
    expect(grants(h.node).map((grant) => grant.provenance)).toEqual(["primary"]);
  });

  test("a failed bootstrap leaves no bootstrap grants either", async () => {
    for (const failAt of ["index", "applications", "secrets-schema", "marker"]) {
      const h = makeHarness();
      h.failAt = failAt;
      expect(await runBootstrap(h)).toBe(false);
      expect(h.node.bootstrapStatus.skipped).toBe(true);
      expect(grants(h.node).filter((grant) => grant.provenance === "bootstrap")).toEqual([]);
    }
  });

  test("cleanup removes only the grants this sign-in installed", async () => {
    const newer: RuntimeGrantView = {
      provenance: "bootstrap",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      delegation: { cid: "bafy-newer-signin" },
      operations: [],
    };
    const h = makeHarness({
      // A newer sign-in installs its own bootstrap grant while this run is in flight.
      duringIndex: (node) => {
        Reflect.set(node, "runtimePermissionGrants", [...grants(node), newer]);
      },
    });
    expect(await runBootstrap(h)).toBe(true);
    expect(grants(h.node)).toEqual([newer]);
  });

  test("nothing bootstrap-related is persisted", async () => {
    const h = makeHarness();
    await runBootstrap(h);
    expect(h.captured.length).toBeGreaterThan(0);
    expect(h.saves).toBe(0);
    expect(await h.storage.load(ADDRESS)).toBeNull();
    expect(grants(h.node)).toEqual([]);
  });
});
