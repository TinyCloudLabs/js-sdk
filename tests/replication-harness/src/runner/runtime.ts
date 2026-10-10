import type { ClientConstructor, SharedFixtureFactory, SutResolver } from "../contracts/frozen";
import type { KvClient } from "../contracts/client";
import type { ClientSpec } from "../contracts/topology";
import { DockerTopologyFactory, registerClientConstructor } from "../topology/factory";

export type ClientSecretCollector = (client: KvClient, spec: ClientSpec, runId: string) => Promise<readonly string[]>;

export interface HarnessClientFactories {
  /** S2 injection point: the real factory builds the CLI client from the frozen S0 construction options. */
  createCliClient: ClientConstructor;
  /** S2's identity store returns per-run credential material for report redaction. */
  collectClientSecrets?: ClientSecretCollector;
  /** S2 injection point: the real factory builds the SDK client from the frozen S0 construction options. */
  createSdkClient: ClientConstructor;
  /** S2/S6 injection point for fixtures that share endpoint, storage and distinct device proofs. */
  createSharedFixture: SharedFixtureFactory;
}

export interface HarnessRuntimeAdapters extends HarnessClientFactories {
  resolveSut: SutResolver;
  collectClientSecrets: ClientSecretCollector;
}

export interface HarnessRuntime {
  topologyFactory: DockerTopologyFactory;
  sharedFixtureFactory: SharedFixtureFactory;
  collectClientSecrets: ClientSecretCollector;
}

/** Assemble S1's Docker topology factory with the injected S2 client constructors. */
export function assembleHarnessRuntime(factories: HarnessClientFactories): HarnessRuntime {
  const constructor: ClientConstructor = (options) => options.spec.kind === "cli"
    ? factories.createCliClient(options)
    : factories.createSdkClient(options);
  registerClientConstructor(constructor);
  return {
    topologyFactory: new DockerTopologyFactory(),
    sharedFixtureFactory: factories.createSharedFixture,
    collectClientSecrets: factories.collectClientSecrets ?? (async () => []),
  };
}

/** Load S2's real adapters only at runtime, keeping this S4a branch buildable before S2 merges. */
export async function loadS2RuntimeAdapters(): Promise<HarnessRuntimeAdapters> {
  const load = async (file: string): Promise<Record<string, unknown>> => await import(new URL(file, import.meta.url).href) as Record<string, unknown>;
  const [cli, sdk, shared, sut, identity] = await Promise.all([
    load("../clients/cli-client.ts"),
    load("../clients/sdk-client.ts"),
    load("../clients/shared-fixture.ts"),
    load("../clients/sut.ts"),
    load("../clients/identity.ts"),
  ]);
  const required = <T>(module: Record<string, unknown>, name: string, file: string): T => {
    const value = module[name];
    if (typeof value !== "function") throw new Error(`S2 runtime adapter ${file} does not export ${name}`);
    return value as T;
  };
  const registeredIdentityKey = required<(runId: string, identity: string) => string | undefined>(identity, "registeredSdkIdentityPrivateKey", "identity.ts");
  const sdkIdentityKey = required<(runId: string, identity: string) => string>(identity, "sdkIdentityPrivateKey", "identity.ts");
  return {
    createCliClient: required<ClientConstructor>(cli, "createCliClient", "cli-client.ts"),
    createSdkClient: required<ClientConstructor>(sdk, "createSdkClient", "sdk-client.ts"),
    createSharedFixture: required<SharedFixtureFactory>(shared, "createSharedEndpointStorageDeviceFixture", "shared-fixture.ts"),
    resolveSut: required<SutResolver>(sut, "resolveSut", "sut.ts"),
    collectClientSecrets: async (_client, spec, runId) => {
      const registered = registeredIdentityKey(runId, spec.identity);
      const secret = registered ?? (spec.kind === "sdk" ? sdkIdentityKey(runId, spec.identity) : undefined);
      return secret ? [secret] : [];
    },
  };
}
