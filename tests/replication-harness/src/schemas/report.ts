import { z } from "zod";
import { ResolvedImageSchema, ResolvedSutSchema, SubjectSchema, ManifestRowSchema, RunInputsSchema } from "./gate";
const status = z.enum(["pass", "fail", "error", "skipped", "unsupported", "xfail", "xpass"]);
const backend = z.enum(["sqlite", "pg16", "pg16-c"]);
const tier = z.enum(["core", "edge", "speed", "tc12"]);
const set = z.literal("phase1-companion");
const resource = z.object({ kind: z.enum(["network", "volume", "container"]), name: z.string(), labels: z.record(z.string()) }).strict();
export const ScenarioResultSchema = z.object({
  key: z.string(), id: z.string(), variant: z.string().nullable(), backend, tier, sets: z.array(set), status,
  reason: z.string().optional(), durationMs: z.number().nonnegative(), assertions: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.unknown().optional() }).strict()),
  metrics: z.array(z.object({ id: z.string(), unit: z.enum(["ms", "bytes", "count", "ops/s"]), n: z.number().int().nonnegative(), p50: z.number(), p95: z.number(), min: z.number(), max: z.number(), samples: z.array(z.number()) }).strict()),
  artefactDir: z.string(), artefacts: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  teardown: z.object({ leaked: z.array(resource), errors: z.array(z.string()) }).strict(),
}).strict();
const statuses = z.record(status, z.number().int().nonnegative());
export const RunReportSchema = z.object({
  schema: z.literal("tc893.report/v1"), kind: z.enum(["leg", "adhoc"]), runId: z.string(), startedAt: z.string(), finishedAt: z.string(), durationMs: z.number().nonnegative(), interrupted: z.boolean(),
  invocation: z.object({ tiers: z.array(tier), set: set.nullable(), only: z.array(z.string()).nullable(), backends: z.array(backend), concurrency: z.number().int().positive(), speedConcurrency: z.number().int().positive(), argv: z.array(z.string()) }).strict(),
  filtered: z.boolean(), subject: SubjectSchema, harnessSha: z.string(), harnessDirty: z.boolean(), inputsSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  environment: z.object({ runnerClass: z.string(), os: z.string(), cpus: z.number(), docker: z.string(), node: z.string(), bun: z.string() }).strict(),
  sut: ResolvedSutSchema, image: ResolvedImageSchema, results: z.array(ScenarioResultSchema), summary: statuses, quarantined: z.array(z.string()), teardown: z.object({ leaked: z.array(resource) }).strict(),
  baseline: z.object({ file: z.string(), regressions: z.array(z.object({ metric: z.string(), stat: z.enum(["p50", "p95"]), direction: z.enum(["lower", "higher"]), baseline: z.number(), observed: z.number(), limit: z.number() }).strict()), gaFailures: z.array(z.string()) }).strict().optional(),
}).strict();
const reasonCode = z.enum(["MISSING_LEG", "DUPLICATE_LEG", "LEG_JOB_FAILED", "INPUTS_MISMATCH", "MANIFEST_MISMATCH", "FILTERED_LEG", "MISSING_ROW", "EXTRA_ROW", "ROW_NOT_PASS", "QUARANTINED", "MISSING_ARTEFACT", "SUT_SOURCE_MISMATCH", "SUT_IDENTITY_MISMATCH", "IMAGE_MISMATCH", "PROD_VERSION_MISMATCH", "SUBJECT_MISMATCH", "TEARDOWN_LEAK"]);
const reason = z.object({ code: reasonCode, key: z.string().optional(), leg: z.string().optional(), detail: z.string() }).strict();
const aggregateRow = ManifestRowSchema.extend({ status: status.or(z.literal("missing")), reason: z.string().optional(), durationMs: z.number().nullable(), artefactDir: z.string().nullable(), missingArtefacts: z.array(z.string()), quarantined: z.boolean() }).strict();
const verdict = z.object({ passed: z.boolean(), reasons: z.array(reason), rows: z.array(aggregateRow) }).strict();
export const AggregateReportSchema = z.object({
  schema: z.literal("tc893.aggregate/v1"), inputs: RunInputsSchema,
  gate: verdict.extend({ id: z.enum(["tc858-phase1-workspace", "tc858-phase1-beta"]), manifestSha256: z.string() }).nullable(),
  companion: z.array(verdict.extend({ set, manifestSha256: z.string() })), adhoc: z.object({ rows: z.array(aggregateRow) }).strict().nullable(),
  legs: z.array(z.object({ name: z.string(), backend, set: set.nullable(), runId: z.string(), reportSha256: z.string(), inputsSha256: z.string(), manifestSha256: z.string().nullable(), filtered: z.boolean(), durationMs: z.number(), summary: statuses }).strict()),
  legCoreConclusion: z.enum(["success", "failure", "cancelled", "skipped", "local"]), legCompanionConclusion: z.enum(["success", "failure", "cancelled", "skipped", "local"]), producedAt: z.string(),
}).strict().superRefine((aggregate, ctx) => {
  if (aggregate.gate?.passed && aggregate.legCoreConclusion === "failure") ctx.addIssue({ code: "custom", message: "passing gate cannot have failed core job conclusion" });
});
export type ValidatedRunReport = z.infer<typeof RunReportSchema>;
export type ValidatedAggregateReport = z.infer<typeof AggregateReportSchema>;
