import { HarnessError } from "../contracts/common";
import { prepareSharedEndpointStorageDeviceSpec } from "../contracts/frozen";
import type { RestartAuthMode, SharedEndpointStorageDeviceFixture, SharedFixtureFactory } from "../contracts/frozen";

export const createSharedEndpointStorageDeviceFixture: SharedFixtureFactory = async (input) => {
  const preparedSpec = prepareSharedEndpointStorageDeviceSpec(input);
  const topology = await input.createTopology(preparedSpec);
  const [firstId, secondId] = input.clientIds;
  const first = topology.sdk(firstId);
  const second = topology.sdk(secondId);
  if (first.kind !== "sdk" || second.kind !== "sdk") {
    throw new HarnessError("TOPOLOGY_INVALID", "Shared endpoint/storage/device fixture requires SDK clients");
  }
  return {
    canonicalEndpoint: input.canonicalEndpoint,
    replicaRoot: input.replicaRoot,
    mode: "foreground",
    devices: input.deviceProofs,
    topology,
    clients: [first, second],
    async reopen(clientId, options) {
      if (options.refresh !== false) throw new HarnessError("TOPOLOGY_INVALID", "Shared fixture reopen may not refresh the client before use");
      const current = clientId === firstId ? first : clientId === secondId ? second : undefined;
      if (!current) throw new HarnessError("TOPOLOGY_INVALID", `Unknown shared fixture client: ${clientId}`);
      const restartable = current as unknown as { restart(options: { auth: RestartAuthMode; signal?: AbortSignal; deadlineMs?: number }): Promise<void> };
      await restartable.restart({ auth: options.auth, signal: options.signal, deadlineMs: options.deadlineMs });
      return current;
    },
  };
};
