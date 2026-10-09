export type ReplicationModuleLoaders = {
  runtime: () => Promise<typeof import("./runtime")>;
  authority: () => Promise<typeof import("./authority")>;
};

let nodeLoaders: ReplicationModuleLoaders | undefined;

export function registerNodeReplicationLoaders(loaders: ReplicationModuleLoaders): void {
  nodeLoaders = loaders;
}

export function getNodeReplicationLoaders(): ReplicationModuleLoaders {
  if (nodeLoaders === undefined) {
    throw new Error("Replication requires importing @tinycloud/node-sdk, not @tinycloud/node-sdk/core");
  }
  return nodeLoaders;
}
