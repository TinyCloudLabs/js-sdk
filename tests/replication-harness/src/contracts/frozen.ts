import type { ClientSpec, TopologySpec } from "./topology";
import type { ClientKind, CallOptions } from "./common";
import type { KvClient } from "./client";
import type { RunEnvironment, ResolvedImage, ResolvedSut, Topology } from "./lifecycle";

/** S2 client construction entry point. Restore uses saved proof; fresh sign-in is explicit and never implicit on restart. */
export interface ClientConstructionOptions extends CallOptions { topology: Topology; environment: RunEnvironment; spec: ClientSpec; image: ResolvedImage; sut: ResolvedSut }
export type ClientConstructor = (options: ClientConstructionOptions) => Promise<KvClient>;

/** S2 resolves each SUT once per run; S1 resolves image refs once before topology creation. */
export interface SutResolutionRequest { mode: "workspace" | "published"; root?: string; cliVersion?: string; nodeSdkVersion?: string }
export type SutResolver = (request: SutResolutionRequest) => Promise<ResolvedSut>;
export type ImageResolver = (ref: string) => Promise<ResolvedImage>;

/** Shared C.2 fixture: same canonical endpoint and replica root, distinct device proofs, foreground mode. */
export interface SharedEndpointStorageDeviceFixture {
  canonicalEndpoint: string; replicaRoot: string; mode: "foreground";
  devices: readonly [{ id: string; proof: unknown }, { id: string; proof: unknown }];
  topology: TopologySpec;
  reopen(clientId: string, options: { refresh: false } & CallOptions): Promise<KvClient>;
}
export type SharedFixtureFactory = (input: { topology: Topology; clients: readonly [string, string] }) => Promise<SharedEndpointStorageDeviceFixture>;
export type HarnessClientKind = ClientKind;
