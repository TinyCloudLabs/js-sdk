import type { Backend, GateId, SetId, Tier } from "./common";
import type { Status } from "./scenario";
import type { ResolvedImage, ResolvedSut } from "./lifecycle";
export interface Subject {
  repo: string; event: "workflow_dispatch" | "pull_request" | "local"; ref: string; sha: string;
  headSha?: string; baseSha?: string; prNumber?: number; headRef?: string; runId?: string; runAttempt?: number; runUrl?: string;
}
export interface JunitSuiteEvidence { name: string; present: boolean; exitCode: number; skipped: number; tests: number }
export interface JunitPrecondition {
  schema: "tc893.junit-precondition/v1"; minimumsVersion: 1; testedSha: string;
  association: { prNumber: number; headSha: string; baseSha: string } | { event: "workflow_dispatch"; ref: string; sha: string };
  suites: JunitSuiteEvidence[];
}
export interface RunInputs {
  schema: "tc893.inputs/v1"; gate: GateId | null; sets: SetId[]; tiers: Tier[]; backends: Backend[]; subject: Subject;
  harnessSha: string; sut: ResolvedSut; image: ResolvedImage;
  production: { url: string; version: string; features: string[]; capturedAt: string } | null;
  preflight: { passed: boolean; checks: { name: string; ok: boolean; detail?: unknown }[] };
  junitPrecondition: JunitPrecondition | null; resolvedAt: string; inputsSha256: string;
}
export interface ManifestRow { key: string; id: string; variant: string | null; backend: Backend; tier: Tier; requiredArtefacts: string[] }
export interface Manifest { schema: "tc893.manifest/v1"; gate: GateId | null; set: SetId | null; harnessSha: string; inputsSha256: string; rows: ManifestRow[]; manifestSha256: string }
export type GateReasonCode =
  | "MISSING_LEG" | "DUPLICATE_LEG" | "LEG_JOB_FAILED" | "INPUTS_MISMATCH" | "MANIFEST_MISMATCH" | "FILTERED_LEG"
  | "MISSING_ROW" | "EXTRA_ROW" | "ROW_NOT_PASS" | "QUARANTINED" | "MISSING_ARTEFACT"
  | "SUT_SOURCE_MISMATCH" | "SUT_IDENTITY_MISMATCH" | "IMAGE_MISMATCH" | "PROD_VERSION_MISMATCH" | "SUBJECT_MISMATCH" | "TEARDOWN_LEAK";
export interface GateReason { code: GateReasonCode; key?: string; leg?: string; detail: string }
export interface AggregateRow extends ManifestRow { status: Status | "missing"; reason?: string; durationMs: number | null; artefactDir: string | null; missingArtefacts: string[]; quarantined: boolean }
export interface Verdict { passed: boolean; reasons: GateReason[]; rows: AggregateRow[] }
export interface CompanionVerdict extends Verdict { set: SetId; manifestSha256: string }
export interface AggregateReport {
  schema: "tc893.aggregate/v1"; inputs: RunInputs;
  gate: ({ id: GateId; manifestSha256: string } & Verdict) | null;
  companion: CompanionVerdict[];
  adhoc: { rows: AggregateRow[] } | null;
  legs: { name: string; backend: Backend; set: SetId | null; runId: string; reportSha256: string; inputsSha256: string; manifestSha256: string | null; filtered: boolean; durationMs: number; summary: Record<Status, number> }[];
  legCoreConclusion: "success" | "failure" | "cancelled" | "skipped" | "local";
  legCompanionConclusion: "success" | "failure" | "cancelled" | "skipped" | "local";
  producedAt: string;
}
