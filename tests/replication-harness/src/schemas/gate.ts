import { z } from "zod";
const nonempty = z.string().min(1);
export const SubjectSchema = z.object({
  repo: nonempty, event: z.enum(["workflow_dispatch", "pull_request", "local"]), ref: nonempty, sha: nonempty,
  headSha: z.string().optional(), baseSha: z.string().optional(), prNumber: z.number().int().positive().optional(), headRef: z.string().optional(),
  runId: z.string().optional(), runAttempt: z.number().int().positive().optional(), runUrl: z.string().optional(),
}).strict().superRefine((subject, ctx) => {
  if (subject.event === "pull_request" && (!subject.headSha || !subject.baseSha || !subject.prNumber)) ctx.addIssue({ code: "custom", message: "pull_request subject requires headSha, baseSha, and prNumber" });
});
export const ResolvedImageSchema = z.object({ role: z.enum(["default", "previous", "prod", "custom", "build"]), ref: nonempty, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), pinned: nonempty, nodeVersion: nonempty, features: z.array(z.string()) }).strict();
export const ResolvedSutSchema = z.object({
  source: z.enum(["workspace", "published"]), root: z.string().optional(), gitSha: z.string().optional(), dirty: z.boolean().optional(), distSha256: z.string().optional(), lockfileSha256: z.string().optional(),
  cli: z.object({ version: nonempty, packageJson: nonempty, entry: nonempty, integrity: z.string().optional() }).strict(),
  nodeSdk: z.object({ version: nonempty, packageJson: nonempty, entry: nonempty, condition: z.literal("import"), integrity: z.string().optional() }).strict(),
}).strict();
export const JunitSuiteEvidenceSchema = z.object({ name: nonempty, present: z.boolean(), exitCode: z.number().int(), skipped: z.number().int().nonnegative(), tests: z.number().int().nonnegative() }).strict();
export const JunitPreconditionSchema = z.object({
  schema: z.literal("tc893.junit-precondition/v1"), minimumsVersion: z.literal(1), testedSha: nonempty,
  association: z.union([
    z.object({ prNumber: z.number().int().positive(), headSha: nonempty, baseSha: nonempty }).strict(),
    z.object({ event: z.literal("workflow_dispatch"), ref: nonempty, sha: nonempty }).strict(),
  ]), suites: z.array(JunitSuiteEvidenceSchema).min(1),
}).strict().superRefine((evidence, ctx) => {
  const minimums: readonly [string, number][] = [
    ["cli-acceptance-sqlite", 1], ["cli-acceptance-pg16", 1],
    ["node-sdk-real-node-sqlite", 3], ["node-sdk-real-node-pg16", 3],
  ];
  for (const [name, count] of minimums) {
    const suite = evidence.suites.find((item) => item.name === name);
    if (!suite || !suite.present || suite.exitCode !== 0 || suite.skipped !== 0 || suite.tests < count) {
      ctx.addIssue({ code: "custom", message: `${name} must exist, exit successfully, have zero skips, and run at least ${count} tests` });
    }
  }
  if ("prNumber" in evidence.association && evidence.testedSha !== evidence.association.headSha) {
    ctx.addIssue({ code: "custom", message: "tested SHA must equal PR head SHA" });
  }
  if ("event" in evidence.association && evidence.testedSha !== evidence.association.sha) {
    ctx.addIssue({ code: "custom", message: "tested SHA must equal dispatch SHA" });
  }
});
export const RunInputsSchema = z.object({
  schema: z.literal("tc893.inputs/v1"), gate: z.enum(["tc858-phase1-workspace", "tc858-phase1-beta"]).nullable(), sets: z.array(z.literal("phase1-companion")),
  tiers: z.array(z.enum(["core", "edge", "speed", "tc12"])), backends: z.array(z.enum(["sqlite", "pg16", "pg16-c"])), subject: SubjectSchema,
  harnessSha: nonempty, sut: ResolvedSutSchema, image: ResolvedImageSchema,
  production: z.object({ url: nonempty, version: nonempty, features: z.array(z.string()), capturedAt: nonempty }).strict().nullable(),
  preflight: z.object({ passed: z.boolean(), checks: z.array(z.object({ name: nonempty, ok: z.boolean(), detail: z.unknown().optional() }).strict()) }).strict(),
  junitPrecondition: JunitPreconditionSchema.nullable(), resolvedAt: nonempty, inputsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((inputs, ctx) => {
  const requiresJunit = inputs.gate === "tc858-phase1-workspace" && inputs.subject.event !== "local";
  if (requiresJunit && !inputs.junitPrecondition) ctx.addIssue({ code: "custom", message: "workspace CI gate requires junit precondition evidence" });
  if (!requiresJunit && inputs.junitPrecondition) ctx.addIssue({ code: "custom", message: "junit precondition applies only to the workspace CI gate" });
  if (inputs.gate && (inputs.backends.length !== 2 || !inputs.backends.includes("sqlite") || !inputs.backends.includes("pg16"))) ctx.addIssue({ code: "custom", message: "gate backends must include sqlite and pg16 only" });
  if (inputs.gate && inputs.image.role !== "prod") ctx.addIssue({ code: "custom", message: "gate image role must be prod" });
  const evidence = inputs.junitPrecondition;
  if (!evidence) return;
  const association = evidence.association;
  const subject = inputs.subject;
  if (subject.event === "pull_request") {
    if (!("prNumber" in association) || association.prNumber !== subject.prNumber || association.headSha !== subject.headSha || association.baseSha !== subject.baseSha) {
      ctx.addIssue({ code: "custom", message: "junit PR association must exactly match subject PR number, head SHA, and base SHA" });
    }
  } else if (subject.event === "workflow_dispatch") {
    if (!("event" in association) || association.event !== subject.event || association.ref !== subject.ref || association.sha !== subject.sha) {
      ctx.addIssue({ code: "custom", message: "junit dispatch association must exactly match subject event, ref, and SHA" });
    }
  } else ctx.addIssue({ code: "custom", message: "local subjects cannot carry junit CI evidence" });
});
export const ManifestRowSchema = z.object({ key: nonempty, id: nonempty, variant: z.string().nullable(), backend: z.enum(["sqlite", "pg16", "pg16-c"]), tier: z.enum(["core", "edge", "speed", "tc12"]), requiredArtefacts: z.array(nonempty) }).strict();
export const ManifestSchema = z.object({ schema: z.literal("tc893.manifest/v1"), gate: z.enum(["tc858-phase1-workspace", "tc858-phase1-beta"]).nullable(), set: z.literal("phase1-companion").nullable(), harnessSha: nonempty, inputsSha256: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(ManifestRowSchema), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
