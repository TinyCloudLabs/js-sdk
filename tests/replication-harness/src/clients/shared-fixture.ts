import { prepareSharedEndpointStorageDeviceSpec } from "../contracts/frozen";
import type { ClientConstructionOptions, SharedEndpointStorageDeviceFixture, SharedFixturePreparation } from "../contracts/frozen";
import type { KvClient, SdkClient } from "../contracts/client";
import type { RunEnvironment, Topology } from "../contracts/lifecycle";
import type { TopologySpec } from "../contracts/topology";

export interface SharedFixtureOptions extends SharedFixturePreparation {
  environment: RunEnvironment;
  createTopology(spec: TopologySpec): Promise<Topology>;
  createClient(input: ClientConstructionOptions): Promise<KvClient>;
}

export async function createSharedEndpointStorageDeviceFixture(input: SharedFixtureOptions): Promise<SharedEndpointStorageDeviceFixture> {
  const preparedSpec = prepareSharedEndpointStorageDeviceSpec(input);
  const topology = await input.createTopology(preparedSpec);
  const [firstId, secondId] = input.clientIds;
  const make = async (id: string): Promise<KvClient> => {
    const spec = preparedSpec.clients.find((client) => client.id === id);
    if (!spec) throw new Error(`Shared fixture client ${id} was not prepared`);
    return input.createClient({ topology, environment: input.environment, spec, image: topology.node(spec.node).image, sut: input.environment.sut });
  };
  const first = await make(firstId);
  const second = await make(secondId);
  if (first.kind !== "sdk" || second.kind !== "sdk") throw new Error("Shared endpoint/storage/device fixture requires SDK clients");
  return {
    canonicalEndpoint: input.canonicalEndpoint,
    replicaRoot: input.replicaRoot,
    mode: "foreground",
    devices: input.deviceProofs,
    topology,
    clients: [first, second] as [SdkClient, SdkClient],
    async reopen(clientId, options) {
      if (options.refresh !== false) throw new Error("Shared fixture reopen may not refresh the client before use");
      const current = clientId === firstId ? first : clientId === secondId ? second : undefined;
      if (!current) throw new Error(`Unknown shared fixture client: ${clientId}`);
      await current.restart({ auth: options.auth, signal: options.signal, deadlineMs: options.deadlineMs });
      return current;
    },
  };
}
