/**
 * The `@tinycloud/replica/profile-gate` members the node adapter uses, typed structurally: node-sdk
 * compiles under `moduleResolution: node` and cannot read replica's `exports` map (see replica-contract.ts).
 */
export type ProfileGateModule = {
  establishSessionStamp(
    profileDir: string,
    principal: string,
    options: { siweIssuedAt: number },
  ): Promise<{ incarnation: string; lifecycleEpoch: number }>;
  restoreSessionStamp(
    profileDir: string,
    principal: string,
    persisted: { incarnation: string; lifecycleEpoch: number } | undefined,
  ): Promise<{ incarnation: string; lifecycleEpoch: number }>;
  denyGate(
    profileDir: string,
    input: { reason: "sign_out"; principal: string },
    collectIntents: (principalHash: string) => Promise<readonly unknown[]>,
  ): Promise<{ status: string; code?: string }>;
};

export type ReplicationModuleLoaders = {
  runtime: () => Promise<typeof import("./runtime")>;
  authority: () => Promise<typeof import("./authority")>;
  gate: () => Promise<ProfileGateModule>;
};

let nodeLoaders: ReplicationModuleLoaders | undefined;

export function registerReplicationLoaders(loaders: ReplicationModuleLoaders): void {
  nodeLoaders = loaders;
}

export function getNodeReplicationLoaders(): ReplicationModuleLoaders {
  if (nodeLoaders === undefined) {
    throw new Error("Replication requires registering replication controller loaders.");
  }
  return nodeLoaders;
}
