import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  BOOTSTRAP_SESSION_REQUESTS,
  ErrorCodes,
  KVService,
  bootstrapSteps,
  err,
  serviceError,
  type BootstrapStep,
  type IServiceContext,
} from "@tinycloud/sdk-core";
import {
  BOOTSTRAP_COMPLETION_MARKER_KEY,
  BOOTSTRAP_COMPLETION_MARKER_VERSION,
  TinyCloudNode,
} from "./TinyCloudNode";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HOST = "https://tinycloud.test";
const MARKER_STEP = "marker:put";

type Fault = {
  boundary: string;
  call?: number;
  beforeCommit?: boolean;
  error?: Error;
};

type FakeSession = {
  spaceId: string;
  delegationHeader: { Authorization: string };
  delegationCid: string;
  verificationMethod: string;
  jwk: object;
};

/**
 * In-memory durable side effects for the complete bootstrap ceremony.  Faults
 * deliberately happen at the boundary after a mutation by default: this is
 * the process-death window TC-393 must recover from.
 */
class FakeCloud {
  readonly hostedSpaces = new Set<string>();
  readonly sessions = new Set<string>();
  readonly activatedSpaces = new Set<string>();
  readonly kv = new Map<string, unknown>();
  readonly registry = new Map<string, object>();
  readonly appRecords = new Map<string, object>();
  readonly schemasApplied = new Set<string>();
  readonly encryptionAssumeMissing: boolean[] = [];
  networkCreated = false;
  readonly calls = new Map<string, number>();
  readonly boundaries: string[] = [];
  fault?: Fault;

  callCount(boundary: string): number {
    return this.calls.get(boundary) ?? 0;
  }

  ceremonyCallCount(): number {
    return this.boundaries.filter((boundary) => boundary !== "marker:get").length;
  }

  at(boundary: string, commit: () => void): void {
    this.boundaries.push(boundary);
    const call = this.callCount(boundary) + 1;
    this.calls.set(boundary, call);
    const fault = this.fault;
    const failsHere = fault?.boundary === boundary && (fault.call ?? 1) === call;
    if (failsHere && fault?.beforeCommit) {
      throw fault.error ?? new Error(`killed before ${boundary}`);
    }
    commit();
    if (failsHere) {
      throw fault.error ?? new Error(`killed after ${boundary}`);
    }
  }

  completeArtifacts(steps: BootstrapStep[]): void {
    for (const step of steps) {
      if (step.kind === "host") expect(this.hostedSpaces.has(step.spaceId)).toBe(true);
      if (step.kind === "activate") expect(this.activatedSpaces.has(step.spaceId)).toBe(true);
    }
    expect(this.registry.size).toBe(5);
    expect(this.appRecords.size).toBeGreaterThan(0);
    expect(this.schemasApplied.size).toBe(2);
    expect(this.networkCreated).toBe(true);
  }
}

function makeNode(): TinyCloudNode {
  const node = Reflect.construct(TinyCloudNode, [{
    wasmBindings: {
      makeSpaceId(address: string, chainId: number, name: string) {
        return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
      },
      createSessionManager() {
        return {
          createSessionKey: (id: string) => id,
          replaceSessionKey: (_jwk: object, keyId: string) => keyId,
          renameSessionKeyId: () => {},
          getDID: (keyId: string) => `did:key:${keyId}`,
          jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
        };
      },
    },
  }]);
  Reflect.set(node, "_address", ADDRESS);
  return node;
}

test("a truncated bootstrap step array cannot write a completion marker", async () => {
  const node = makeNode();
  const put = mock(async () => ({ ok: true, data: { data: undefined } }));
  Reflect.set(node, "kvForSpace", () => ({ put }));
  const write = Reflect.get(node, "writeBootstrapCompletionMarker");
  const steps = bootstrapSteps(ADDRESS, 1);

  await expect(write.call(node, steps.slice(0, -1))).rejects.toThrow(
    "canonical bootstrap step set",
  );
  expect(put).not.toHaveBeenCalled();

  await write.call(node, steps);
  expect(put).toHaveBeenCalledWith(
    BOOTSTRAP_COMPLETION_MARKER_KEY,
    expect.objectContaining({
      v: BOOTSTRAP_COMPLETION_MARKER_VERSION,
      stepIds: steps.map((step) => step.id),
    }),
  );
});

test("a marker-read error runs one repair decision instead of skipping", async () => {
  const node = makeNode();
  Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "readBootstrapCompletionMarker", async () => ({
    ok: false,
    error: { code: "AUTH_UNAUTHORIZED", message: "denied", service: "kv" },
  }));
  const resolve = Reflect.get(node, "resolveBootstrapDecision");

  await expect(resolve.call(node, bootstrapSteps(ADDRESS, 1))).resolves.toEqual({
    action: "run",
    mode: "repair",
  });
});

test("only an accepted marker version permits an already-provisioned skip", async () => {
  const node = makeNode();
  Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "readBootstrapCompletionMarker", async () => ({
    ok: true,
    data: { data: { v: BOOTSTRAP_COMPLETION_MARKER_VERSION } },
  }));
  const resolve = Reflect.get(node, "resolveBootstrapDecision");

  await expect(resolve.call(node, bootstrapSteps(ADDRESS, 1))).resolves.toEqual({
    action: "skip",
  });
});

function makeRecoveryHarness(fake: FakeCloud): TinyCloudNode {
  const node = Reflect.construct(TinyCloudNode, [{
    host: HOST,
    wasmBindings: {
      makeSpaceId(address: string, chainId: number, name: string) {
        return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
      },
      createSessionManager() {
        return {
          createSessionKey: (id: string) => id,
          replaceSessionKey: (_jwk: object, keyId: string) => keyId,
          renameSessionKeyId: () => {},
          getDID: (keyId: string) => `did:key:${keyId}`,
          jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
        };
      },
    },
  }]);
  Reflect.set(node, "_address", ADDRESS);
  Reflect.set(node, "_chainId", 1);

  const spaceName = (spaceId: string) => spaceId.split(":").at(-1)!;
  const sessionFor = (spaceId: string): FakeSession => ({
    spaceId,
    delegationHeader: { Authorization: `Bearer ${spaceId}` },
    delegationCid: `cid:${spaceId}`,
    verificationMethod: `did:key:${spaceName(spaceId)}`,
    jwk: { kty: "OKP", crv: "Ed25519", x: spaceName(spaceId) },
  });
  const auth = {
    tinyCloudSession: undefined,
    capabilityRequest: undefined,
    lastActivationSkippedSpaceIds: [] as string[],
    hosts: [HOST],
    async createBootstrapSession({ spaceId }: { spaceId: string }) {
      const name = spaceName(spaceId);
      fake.at(`session:${name}`, () => fake.sessions.add(spaceId));
      return sessionFor(spaceId);
    },
    async hostOwnedSpace(spaceId: string) {
      fake.at(`host:${spaceName(spaceId)}`, () => fake.hostedSpaces.add(spaceId));
      return true;
    },
  };
  Reflect.set(node, "auth", auth);
  Reflect.set(node, "hasRuntimePermissions", () => true);
  Reflect.set(node, "registerBootstrapRuntimeGrant", () => {});
  Reflect.set(node, "_account", {
    index: {
      async ensure() {
        fake.at("account:index-schema", () => {
          fake.schemasApplied.add("account/account/tinycloud.account.index");
        });
        return { ok: true, data: undefined };
      },
    },
    spaces: {
      async registerBatch(spaces: readonly { spaceId: string; name: string }[]) {
        fake.at("account:seed-spaces", () => {
          for (const space of spaces) fake.registry.set(space.spaceId, { ...space });
        });
        return { ok: true, data: { spaces: [...spaces] } };
      },
      async register() {
        return { ok: true, data: undefined };
      },
    },
    applications: {
      async register(manifests: readonly { app_id?: string }[]) {
        fake.at("account:seed-applications", () => {
          for (const manifest of manifests) {
            fake.appRecords.set(manifest.app_id ?? JSON.stringify(manifest), { ...manifest });
          }
        });
        return { ok: true, data: undefined };
      },
    },
  });
  Reflect.set(node, "sqlForSpace", (spaceId: string) => ({
    db(database: string) {
      return {
        migrations: {
          async apply({ namespace }: { namespace: string }) {
            const boundary = namespace === "tinycloud.secrets.records"
              ? "secrets:secret-records-schema"
              : "account:index-schema";
            fake.at(boundary, () => fake.schemasApplied.add(`${spaceId}/${database}/${namespace}`));
            return { ok: true, data: undefined };
          },
        },
      };
    },
  }));
  Reflect.set(node, "ensureEncryptionNetwork", async (_networkId: string, options: { assumeMissing: boolean }) => {
    fake.encryptionAssumeMissing.push(options.assumeMissing);
    fake.at("encryption:network-create", () => { fake.networkCreated = true; });
  });
  Reflect.set(node, "readBootstrapCompletionMarker", async () => {
    fake.at("marker:get", () => {});
    const defaultSpaceId = bootstrapSteps(ADDRESS, 1).find(
      (step) => step.id === "host:default",
    );
    if (!defaultSpaceId || defaultSpaceId.kind !== "host") throw new Error("missing default space");
    if (!fake.hostedSpaces.has(defaultSpaceId.spaceId)) {
      return err(serviceError(
        ErrorCodes.KV_NOT_FOUND,
        "Space not found",
        "kv",
        { meta: { status: 404 } },
      ));
    }
    if (!fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)) {
      return err(serviceError(ErrorCodes.KV_NOT_FOUND, "Key not found", "kv"));
    }
    return { ok: true as const, data: { data: fake.kv.get(BOOTSTRAP_COMPLETION_MARKER_KEY) } };
  });
  Reflect.set(node, "writeBootstrapCompletionMarker", async (steps: BootstrapStep[]) => {
    const ids = steps.map((step) => step.id);
    fake.at(MARKER_STEP, () => {
      fake.kv.set(BOOTSTRAP_COMPLETION_MARKER_KEY, {
        v: BOOTSTRAP_COMPLETION_MARKER_VERSION,
        stepIds: ids,
        completedAt: "2000-01-01T00:00:00.000Z",
      });
    });
  });
  return node;
}

async function bootstrap(node: TinyCloudNode): Promise<void> {
  const run = Reflect.get(node, "bootstrapAccountIfNeeded") as () => Promise<boolean>;
  await run.call(node);
}

function makePublicSignIn(node: TinyCloudNode): void {
  Reflect.set(node, "signer", {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
  });
  Reflect.set(node, "tc", {
    signIn: async () => {},
    retireServices: () => {},
  });
  Reflect.set(node, "syncResolvedHostFromAuth", () => {});
  Reflect.set(node, "initializeServices", () => {});
  Reflect.set(node, "ensureRequestedEncryptionNetworks", async () => {});
  Reflect.set(node, "ensureOwnedSpaceHostedById", async () => {});
  Reflect.set(node, "scheduleAccountRegistrySync", () => {});
}

function canonicalStepIds(): string[] {
  return bootstrapSteps(ADDRESS, 1).map((step) => step.id);
}

function bootstrapSpaceId(name: "default" | "applications" | "account" | "secrets" | "public"): string {
  const step = bootstrapSteps(ADDRESS, 1).find(
    (candidate) => candidate.kind === "host" && candidate.space === name,
  );
  if (!step || step.kind !== "host") throw new Error(`missing ${name} bootstrap space`);
  return step.spaceId;
}

const ceremonyFaultPoints = [
  ...["default", "applications", "account", "secrets", "public"].map((space) => `session:${space}`),
  ...["default", "applications", "account", "secrets", "public"].map((space) => `host:${space}`),
  ...["default", "applications", "account", "secrets", "public"].map((space) => `activate:${space}`),
  "account:index-schema",
  "account:seed-spaces",
  "account:seed-applications",
  "encryption:network-create",
  "secrets:secret-records-schema",
] as const;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installActivationTransport(fake: FakeCloud): void {
  globalThis.fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const spaceId = headers?.Authorization?.replace("Bearer ", "");
    if (!spaceId) throw new Error("missing fake delegation header");
    fake.at(`activate:${spaceId.split(":").at(-1)!}`, () => fake.activatedSpaces.add(spaceId));
    return new Response(JSON.stringify({ activated: [spaceId] }), { status: 200 });
  };
}

describe("TC-393 bootstrap recovery matrix", () => {
  for (const boundary of ceremonyFaultPoints) {
    test(`converges after commit-then-throw at ${boundary}`, async () => {
      const fake = new FakeCloud();
      fake.fault = { boundary };
      const node = makeRecoveryHarness(fake);
      installActivationTransport(fake);
      makePublicSignIn(node);

      await node.signIn();
      expect(node.bootstrapStatus.skipped).toBe(true);
      expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(false);

      fake.fault = undefined;
      const callsBeforeRepair = fake.ceremonyCallCount();
      await node.signIn();
      expect(node.bootstrapStatus).toEqual({ skipped: false });
      expect(fake.ceremonyCallCount()).toBeGreaterThan(callsBeforeRepair);
      fake.completeArtifacts(bootstrapSteps(ADDRESS, 1));
      expect(fake.kv.get(BOOTSTRAP_COMPLETION_MARKER_KEY)).toEqual(expect.objectContaining({
        v: 1,
        stepIds: canonicalStepIds(),
      }));

      const callsBeforeFastPath = fake.ceremonyCallCount();
      const markerGetsBefore = fake.callCount("marker:get");
      await node.signIn();
      expect(node.bootstrapStatus).toEqual({ skipped: true, reason: "already-provisioned" });
      expect(fake.ceremonyCallCount()).toBe(callsBeforeFastPath);
      expect(fake.callCount("marker:get")).toBe(markerGetsBefore + 1);
    });
  }

  for (const boundary of ["host:default", "activate:account", "account:seed-spaces"] as const) {
    test(`converges after fail-before-commit at ${boundary}`, async () => {
      const fake = new FakeCloud();
      fake.fault = { boundary, beforeCommit: true };
      const node = makeRecoveryHarness(fake);
      installActivationTransport(fake);
      makePublicSignIn(node);

      await node.signIn();
      expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(false);
      fake.fault = undefined;
      await node.signIn();
      fake.completeArtifacts(bootstrapSteps(ADDRESS, 1));
    });
  }

  test("converges when death happens between the runner and marker write", async () => {
    const fake = new FakeCloud();
    fake.fault = { boundary: MARKER_STEP, beforeCommit: true };
    const node = makeRecoveryHarness(fake);
    installActivationTransport(fake);
    makePublicSignIn(node);

    await node.signIn();
    expect(node.bootstrapStatus.skipped).toBe(true);
    expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(false);
    fake.fault = undefined;
    await node.signIn();
    expect(node.bootstrapStatus).toEqual({ skipped: false });
    fake.completeArtifacts(bootstrapSteps(ADDRESS, 1));
  });

  test("a committed marker survives a throw and correctly skips the next run", async () => {
    const fake = new FakeCloud();
    fake.fault = { boundary: MARKER_STEP };
    const node = makeRecoveryHarness(fake);
    installActivationTransport(fake);
    makePublicSignIn(node);

    await node.signIn();
    expect(node.bootstrapStatus.skipped).toBe(true);
    expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(true);
    fake.fault = undefined;
    const calls = fake.ceremonyCallCount();
    await node.signIn();
    expect(node.bootstrapStatus.reason).toBe("already-provisioned");
    expect(fake.ceremonyCallCount()).toBe(calls);
  });
});

describe("TC-393 recovery decisions and convergence", () => {
  test("pre-seed wedge is repaired even when all five spaces are already hosted", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    for (const step of bootstrapSteps(ADDRESS, 1)) {
      if (step.kind === "host") fake.hostedSpaces.add(step.spaceId);
    }
    installActivationTransport(fake);

    await bootstrap(node);

    expect(node.bootstrapStatus).toEqual({ skipped: false });
    expect(fake.callCount("account:seed-spaces")).toBe(1);
    fake.completeArtifacts(bootstrapSteps(ADDRESS, 1));
  });

  test("reconciled ambiguous seed batch completes and writes the marker", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    const account = Reflect.get(node, "_account") as {
      spaces: { registerBatch: (spaces: readonly { spaceId: string }[]) => Promise<unknown> };
    };
    account.spaces.registerBatch = async (spaces) => {
      fake.at("account:seed-spaces", () => {
        for (const space of spaces) fake.registry.set(space.spaceId, { ...space });
      });
      return {
        ok: true as const,
        data: {
          spaces: [...spaces],
          recoveredFromBatchError: serviceError(
            ErrorCodes.KV_WRITE_FAILED,
            "ambiguous batch reconciled",
            "kv",
          ),
        },
      };
    };
    installActivationTransport(fake);

    await bootstrap(node);

    expect(node.bootstrapStatus).toEqual({
      skipped: false,
      warnings: [expect.objectContaining({
        stepId: "account:seed-spaces",
        kind: "batch-write-reconciled",
      })],
    });
    expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(true);
  });

  test("an ambiguous seed batch which surfaces as a failure converges on the next run", async () => {
    const fake = new FakeCloud();
    fake.fault = { boundary: "account:seed-spaces", error: new Error("ambiguous batch unconfirmed") };
    const node = makeRecoveryHarness(fake);
    installActivationTransport(fake);

    await bootstrap(node);
    expect(node.bootstrapStatus.skipped).toBe(true);
    expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(false);
    fake.fault = undefined;
    await bootstrap(node);
    fake.completeArtifacts(bootstrapSteps(ADDRESS, 1));
  });

  test("a second complete ceremony is idempotent modulo timestamps", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    installActivationTransport(fake);

    await bootstrap(node);
    const first = {
      registry: [...fake.registry.entries()],
      applications: [...fake.appRecords.entries()],
      schemas: [...fake.schemasApplied].sort(),
    };
    fake.kv.delete(BOOTSTRAP_COMPLETION_MARKER_KEY);
    await bootstrap(node);

    expect([...fake.registry.entries()]).toEqual(first.registry);
    expect([...fake.appRecords.entries()]).toEqual(first.applications);
    expect([...fake.schemasApplied].sort()).toEqual(first.schemas);
    expect(fake.registry.size).toBe(5);
    expect(fake.appRecords.size).toBe(first.applications.length);
    expect(fake.encryptionAssumeMissing).toEqual([true, false]);
  });

  test("old, malformed, and foreign-step markers repair; only accepted v1 skips", async () => {
    for (const marker of [
      { v: 0, stepIds: canonicalStepIds() },
      { v: 2, stepIds: canonicalStepIds() },
      { bad: true },
    ]) {
      const fake = new FakeCloud();
      const node = makeRecoveryHarness(fake);
      fake.hostedSpaces.add(bootstrapSpaceId("default"));
      fake.kv.set(BOOTSTRAP_COMPLETION_MARKER_KEY, marker);
      installActivationTransport(fake);
      await bootstrap(node);
      expect(node.bootstrapStatus.skipped).toBe(false);
    }

    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    fake.hostedSpaces.add(bootstrapSpaceId("default"));
    fake.kv.set(BOOTSTRAP_COMPLETION_MARKER_KEY, { v: 1, stepIds: ["future:renamed"] });
    await bootstrap(node);
    expect(node.bootstrapStatus).toEqual({ skipped: true, reason: "already-provisioned" });
  });

  test("a custom-prefix session probes before marker get and repairs a missing tail", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    const grants: FakeSession[] = [];
    const events: string[] = [];
    const probeRequests: unknown[] = [];
    const auth = Reflect.get(node, "auth") as {
      createBootstrapSession: (input: { spaceId: string; capabilityRequest: unknown }) => Promise<FakeSession>;
    };
    const createSession = auth.createBootstrapSession;
    auth.createBootstrapSession = async (input) => {
      probeRequests.push(input.capabilityRequest);
      return createSession(input);
    };
    const readMarker = Reflect.get(node, "readBootstrapCompletionMarker") as () => Promise<unknown>;
    Reflect.set(node, "readBootstrapCompletionMarker", async () => {
      events.push("marker:get");
      return readMarker.call(node);
    });
    Reflect.set(node, "hasRuntimePermissions", () => false);
    Reflect.set(node, "registerBootstrapRuntimeGrant", (session: FakeSession) => {
      grants.push(session);
      events.push("grant");
    });
    for (const step of bootstrapSteps(ADDRESS, 1)) {
      if (step.kind === "host") fake.hostedSpaces.add(step.spaceId);
      if (step.kind === "seed-spaces") {
        for (const space of step.spaces) fake.registry.set(space.spaceId, { ...space });
      }
    }
    installActivationTransport(fake);

    await bootstrap(node);

    expect(grants).toHaveLength(6); // probe plus the five ceremony sessions
    expect(fake.callCount("marker:get")).toBe(1);
    expect(fake.callCount("account:seed-applications")).toBe(1);
    expect(node.bootstrapStatus.skipped).toBe(false);
    expect(probeRequests[0]).toEqual(BOOTSTRAP_SESSION_REQUESTS.default);
    expect(events.indexOf("grant")).toBeLessThan(events.indexOf("marker:get"));
  });

  for (const outcome of ["signature rejection", "transport throw", "non-404 activation"] as const) {
    test(`probe ${outcome} resolves sign-in bootstrap as one repair attempt`, async () => {
      const fake = new FakeCloud();
      const node = makeRecoveryHarness(fake);
      const auth = Reflect.get(node, "auth") as {
        createBootstrapSession: (input: { spaceId: string }) => Promise<FakeSession>;
      };
      Reflect.set(node, "hasRuntimePermissions", () => false);
      if (outcome === "signature rejection") {
        auth.createBootstrapSession = async () => { throw new Error("signature rejected"); };
      } else {
        globalThis.fetch = async () => {
          if (outcome === "transport throw") throw new Error("transport down");
          return new Response("nope", { status: 500 });
        };
      }
      const runner = Reflect.get(node, "runAccountBootstrap") as (
        steps: BootstrapStep[],
        options: { mode: "fresh" | "repair" },
      ) => Promise<unknown>;
      const runSpy = mock((steps: BootstrapStep[], options: { mode: "fresh" | "repair" }) =>
        runner.call(node, steps, options));
      Reflect.set(node, "runAccountBootstrap", runSpy);

      makePublicSignIn(node);
      await expect(node.signIn()).resolves.toBeUndefined();

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls[0]![1]).toEqual({ mode: "repair" });
      expect(node.bootstrapStatus.skipped).toBe(true);
      expect(node.bootstrapStatus.reason).not.toBe("already-provisioned");
      expect(fake.kv.has(BOOTSTRAP_COMPLETION_MARKER_KEY)).toBe(false);
    });
  }

  test("interactive signer remains skipped without reading a marker", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    const config = Reflect.get(node, "config") as { signer?: { signMessage: () => Promise<string> } };
    const signMessage = mock(async () => "0xsig");
    config.signer = { signMessage };

    await bootstrap(node);

    expect(node.bootstrapStatus).toEqual({ skipped: true, reason: "interactive-signer" });
    expect(fake.callCount("marker:get")).toBe(0);
    expect(signMessage).not.toHaveBeenCalled();
  });

  test("generic OpenKey auto-sign uses the marked fast path without a probe", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    fake.hostedSpaces.add(bootstrapSpaceId("default"));
    fake.kv.set(BOOTSTRAP_COMPLETION_MARKER_KEY, { v: 1, stepIds: canonicalStepIds() });
    const config = Reflect.get(node, "config") as { signStrategy?: { openKeyAutoSign: boolean } };
    config.signStrategy = { openKeyAutoSign: true };

    await bootstrap(node);

    expect(node.bootstrapStatus).toEqual({ skipped: true, reason: "already-provisioned" });
    expect(fake.callCount("marker:get")).toBe(1);
    expect(fake.sessions.size).toBe(0);
  });

  test("cold fresh path reads no marker, writes one, and executes every ceremony boundary once", async () => {
    const fake = new FakeCloud();
    const node = makeRecoveryHarness(fake);
    const auth = Reflect.get(node, "auth") as { lastActivationSkippedSpaceIds: string[] };
    auth.lastActivationSkippedSpaceIds = [bootstrapSpaceId("default")];
    installActivationTransport(fake);

    await bootstrap(node);

    expect(fake.callCount("marker:get")).toBe(0);
    expect(fake.callCount(MARKER_STEP)).toBe(1);
    for (const boundary of ceremonyFaultPoints) expect(fake.callCount(boundary)).toBe(1);
  });
});

function realKv404(body: string): KVService {
  const service = new KVService();
  const abortController = new AbortController();
  const context: IServiceContext = {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "cid:test",
      spaceId: "tinycloud:pkh:eip155:1:test:default",
      verificationMethod: "did:key:test",
      jwk: { kty: "OKP" },
    },
    isAuthenticated: true,
    invoke: () => ({}),
    fetch: async () => new Response(body, { status: 404, statusText: "Not Found" }),
    hosts: [HOST],
    getService: () => undefined,
    emit: () => {},
    on: () => () => {},
    abortSignal: abortController.signal,
    retryPolicy: {
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableErrors: [],
    },
  };
  service.initialize(context);
  return service;
}

test("real KVService 404 classification distinguishes unhosted default from missing marker", async () => {
  for (const [body, expected] of [
    ["Space not found", { action: "run", mode: "fresh" }],
    ["Key not found", { action: "run", mode: "repair" }],
  ] as const) {
    const node = makeNode();
    Reflect.set(node, "auth", { lastActivationSkippedSpaceIds: [] });
    Reflect.set(node, "hasRuntimePermissions", () => true);
    Reflect.set(node, "kvForSpace", () => realKv404(body));
    const resolve = Reflect.get(node, "resolveBootstrapDecision") as (
      steps: BootstrapStep[],
    ) => Promise<unknown>;

    await expect(resolve.call(node, bootstrapSteps(ADDRESS, 1))).resolves.toEqual(expected);
  }
});
