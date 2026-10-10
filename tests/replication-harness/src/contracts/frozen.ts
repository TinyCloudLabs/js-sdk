import type { ClientSpec, NodeImageRef, TopologySpec } from "./topology";
import type { CallOptions } from "./common";
import type { KvClient } from "./client";
import type { RunEnvironment, ResolvedImage, ResolvedSut, Topology } from "./lifecycle";
import { HarnessError } from "./common";

export type RestartAuthMode = "restore" | "fresh-sign-in";

/** S2 client construction entry point. Each client consumes its endpoint, storage root, and proof from ClientSpec. */
export interface ClientConstructionOptions extends CallOptions {
  topology: Topology;
  environment: RunEnvironment;
  spec: ClientSpec;
  image: ResolvedImage;
  sut: ResolvedSut;
}
export type ClientConstructor = (options: ClientConstructionOptions) => Promise<KvClient>;

/** Resolve the selected SUT and image once per run before client/topology construction. */
export interface SutResolutionRequest { mode: "workspace" | "published"; root?: string; cliVersion?: string; nodeSdkVersion?: string }
export type SutResolver = (request: SutResolutionRequest) => Promise<ResolvedSut>;
export type ImageResolver = (ref: NodeImageRef) => Promise<ResolvedImage>;

export interface DeviceProofSpec { id: string; proof: unknown }
export interface SharedFixturePreparation {
  spec: TopologySpec;
  clientIds: readonly [string, string];
  canonicalEndpoint: string;
  replicaRoot: string;
  deviceProofs: readonly [DeviceProofSpec, DeviceProofSpec];
}
/** Call before createTopology: patches both SDK clients to the same endpoint/root and foreground mode. */
export function prepareSharedEndpointStorageDeviceSpec(input: SharedFixturePreparation): TopologySpec {
  const [firstId, secondId] = input.clientIds;
  const [firstProof, secondProof] = input.deviceProofs;
  if (firstId === secondId || firstProof.id === secondProof.id || Object.is(firstProof.proof, secondProof.proof)) {
    throw new HarnessError("TOPOLOGY_INVALID", "shared fixture requires two clients and distinct device proofs");
  }
  const clients = input.spec.clients.filter((client) => client.id === firstId || client.id === secondId);
  if (clients.length !== 2 || clients[0].identity !== clients[1].identity || clients.some((client) => client.kind !== "sdk" || !client.replication)) {
    throw new HarnessError("TOPOLOGY_INVALID", "shared fixture requires two replication-enabled SDK clients of the same identity");
  }
  const proofByClient = new Map([[firstId, firstProof.proof], [secondId, secondProof.proof]]);
  const patchedClients = input.spec.clients.map((client) => {
    const proof = proofByClient.get(client.id);
    if (!proofByClient.has(client.id)) return client;
    return {
      ...client,
      endpoint: input.canonicalEndpoint,
      storageRoot: input.replicaRoot,
      deviceProof: proof,
      replication: { ...client.replication as Exclude<ClientSpec["replication"], false | undefined>, mode: "foreground" as const },
    };
  });
  return { ...input.spec, clients: patchedClients };
}

export interface SharedEndpointStorageDeviceFixture {
  canonicalEndpoint: string;
  replicaRoot: string;
  mode: "foreground";
  devices: readonly [DeviceProofSpec, DeviceProofSpec];
  topology: Topology;
  clients: readonly [KvClient, KvClient];
  reopen(clientId: string, options: { auth: RestartAuthMode; refresh: false } & CallOptions): Promise<KvClient>;
}
/** S2/S6 create the prepared topology before any client exists, then return its two distinct device clients. */
export type SharedFixtureFactory = (input: SharedFixturePreparation & {
  createTopology(spec: TopologySpec): Promise<Topology>;
}) => Promise<SharedEndpointStorageDeviceFixture>;
