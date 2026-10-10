import type { Backend, SetId, Tier, Unit } from "./common";
import type { Clock } from "./clock";
import type { TopologySpec } from "./topology";
import type { RunEnvironment, ResolvedImage, ResolvedSut, Topology } from "./lifecycle";
import type { KvClient } from "./client";
export type Status = "pass" | "fail" | "error" | "skipped" | "unsupported" | "xfail" | "xpass";
export type Requirement = "workspace-sut" | "unshare" | "node-image:previous" | "tc12:host-sync" | "tc674:delegate-session-expiry";
export interface RunContextView { tiers: Tier[]; backends: Backend[]; sut: ResolvedSut; image: ResolvedImage; ciPinImage: string }
export interface Scenario<V extends string = string> {
  id: string; title: string; tier: Tier; sets?: readonly SetId[]; variants?: readonly V[]; backends?: readonly Backend[];
  requires?: readonly Requirement[]; appliesTo?(run: RunContextView, variant: V): true | string; speed?: boolean; timeoutMs: number;
  topology(variant: V, backend: Backend): TopologySpec; run(ctx: ScenarioContext, variant: V): Promise<void>;
}
export interface ScenarioContext {
  readonly topo: Topology; readonly clock: Clock; readonly signal: AbortSignal; readonly backend: Backend; readonly variant: string; readonly env: RunEnvironment;
  check(name: string, ok: boolean, detail?: unknown): void; eq<T>(name: string, actual: T, expected: T): void;
  probeRequirement(requirement: Requirement): true | string;
  deadline(client: KvClient, extraMs?: number): number; metric(id: string, sample: number, unit: Unit): void;
  artefact(name: string, data: string | Uint8Array): void; unsupported(reason: string): never; skip(reason: string): never;
  assertHealed(): Promise<void>; log(msg: string): void;
}
