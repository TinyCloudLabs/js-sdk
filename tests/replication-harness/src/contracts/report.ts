import type { Backend, SetId, Tier, Unit } from "./common";
import type { Status } from "./scenario";
import type { ResolvedImage, ResolvedSut, ResourceRef } from "./lifecycle";
import type { Subject } from "./gate";
export interface RunReport {
  schema: "tc893.report/v1"; kind: "leg" | "adhoc"; runId: string; startedAt: string; finishedAt: string; durationMs: number; interrupted: boolean;
  invocation: { tiers: Tier[]; set: SetId | null; only: string[] | null; backends: Backend[]; concurrency: number; speedConcurrency: number; argv: string[] };
  filtered: boolean; subject: Subject; harnessSha: string; harnessDirty: boolean; inputsSha256: string | null; manifestSha256: string | null;
  environment: { runnerClass: string; os: string; cpus: number; docker: string; node: string; bun: string };
  sut: ResolvedSut; image: ResolvedImage; results: ScenarioResult[]; summary: Record<Status, number>; quarantined: string[];
  teardown: { leaked: ResourceRef[] };
  baseline?: { file: string; regressions: { metric: string; stat: "p50" | "p95"; direction: "lower" | "higher"; baseline: number; observed: number; limit: number }[]; gaFailures: string[] };
}
export interface ScenarioResult {
  key: string; id: string; variant: string | null; backend: Backend; tier: Tier; sets: SetId[]; status: Status; reason?: string; durationMs: number;
  assertions: { name: string; ok: boolean; detail?: unknown }[];
  metrics: { id: string; unit: Unit; n: number; p50: number; p95: number; min: number; max: number; samples: number[] }[];
  artefactDir: string; artefacts: { path: string; bytes: number; sha256: string }[]; teardown: { leaked: ResourceRef[]; errors: string[] };
}
