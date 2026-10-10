import type { ClientConstructor, SharedFixtureFactory } from "../contracts/frozen";
import { DockerTopologyFactory, registerClientConstructor } from "../topology/factory";

export interface HarnessClientFactories {
  /** S2 injection point: the real factory builds the CLI client from the frozen S0 construction options. */
  createCliClient: ClientConstructor;
  /** S2 injection point: the real factory builds the SDK client from the frozen S0 construction options. */
  createSdkClient: ClientConstructor;
  /** S2/S6 injection point for fixtures that share endpoint, storage and distinct device proofs. */
  createSharedFixture: SharedFixtureFactory;
}

export interface HarnessRuntime {
  topologyFactory: DockerTopologyFactory;
  sharedFixtureFactory: SharedFixtureFactory;
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
  };
}
