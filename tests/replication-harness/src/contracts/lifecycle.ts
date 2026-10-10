import type { Backend, CallOptions } from "./common";
import type { Clock } from "./clock";
import type { NodeImageRef, TopologySpec } from "./topology";
import type { ProxyHandle } from "./faults";
import type { KvClient, CliClient, SdkClient } from "./client";
export interface ResolvedImage { role: "default" | "previous" | "prod" | "custom" | "build"; ref: string; digest: string; pinned: string; nodeVersion: string; features: string[] }
export interface ResolvedSut {
  source: "workspace" | "published"; root?: string; gitSha?: string; dirty?: boolean; distSha256?: string; lockfileSha256?: string;
  cli: { version: string; packageJson: string; entry: string; integrity?: string };
  nodeSdk: { version: string; packageJson: string; entry: string; condition: "import"; integrity?: string };
}
export interface ResourceRef { kind: "network" | "volume" | "container"; name: string; labels: Record<string, string> }
export interface RunEnvironment { runId: string; resultsDir: string; clock: Clock; docker: readonly string[]; sut: ResolvedSut; image(ref: NodeImageRef): ResolvedImage; slackMs: number; teardownMs: number }
export interface CreateOptions extends CallOptions { topoId: string; backend: Backend }
export interface TopologyFactory { create(env: RunEnvironment, spec: TopologySpec, o: CreateOptions): Promise<Topology> }
export interface DisposeOptions { deadlineMs: number; keep?: boolean }
export interface DisposeReport { removed: ResourceRef[]; leaked: ResourceRef[]; errors: string[]; clients: { id: string; graceful: boolean }[] }
export interface ArtefactIndex { dir: string; files: { path: string; bytes: number; sha256: string }[] }
export interface Topology {
  readonly id: string; readonly spec: TopologySpec; readonly backend: Backend;
  node(id: string): NodeHandle; client(id: string): KvClient; cli(id: string): CliClient; sdk(id: string): SdkClient;
  proxy(name: string): ProxyHandle; resources(): readonly ResourceRef[]; collectArtefacts(dir: string, o: { deadlineMs: number }): Promise<ArtefactIndex>;
  dispose(o: DisposeOptions): Promise<DisposeReport>;
}
export interface NodeInfo { protocol?: string; version: string; features: string[]; nodeId?: string; inTEE?: boolean }
export interface NodeHandle {
  readonly id: string; readonly backend: Backend; readonly image: ResolvedImage; readonly diagnosticsUrl: string;
  info(o?: CallOptions): Promise<NodeInfo>; stop(o?: CallOptions): Promise<void>; start(o?: CallOptions): Promise<void>;
  restart(o?: { hard?: boolean } & CallOptions): Promise<void>;
  upgrade(image: NodeImageRef, o?: CallOptions): Promise<{ before: NodeInfo; after: NodeInfo; migrations: { before: number; after: number } | null }>;
  sql(query: string, o?: CallOptions): Promise<string>; scanVolume(needle: Uint8Array, o?: CallOptions): Promise<string[]>;
  logs(o?: { tailBytes?: number }): Promise<string>;
}
