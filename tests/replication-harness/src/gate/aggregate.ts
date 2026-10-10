import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AggregateReport, AggregateRow, GateReason, GateReasonCode, Manifest, RunInputs, Verdict } from "../contracts/gate";
import type { Backend, GateId, SetId } from "../contracts/common";
import type { ValidatedRunReport } from "../schemas/report";
import { AggregateReportSchema, RunReportSchema } from "../schemas/report";
import { canonicalSha256 } from "./canonical-json";
import { validateJunitPrecondition } from "./resolve";
import { verifyLegInputs } from "./leg-inputs";
export interface LegEvidence { name: string; directory: string; report: unknown; reportSha256?: string; parseError?: string }
export interface AggregateOptions {
  inputs: RunInputs;
  coreManifest: Manifest | null;
  companionManifests: ReadonlyMap<SetId, Manifest>;
  recomputedCoreManifest: Manifest | null;
  recomputedCompanionManifests: ReadonlyMap<SetId, Manifest>;
  expectedLegs?: readonly { name: string; backend: Backend; set: SetId | null }[];
  legs: LegEvidence[];
  legCoreConclusion: AggregateReport["legCoreConclusion"];
  legCompanionConclusion: AggregateReport["legCompanionConclusion"];
  producedAt?: string;
}

function manifestHashMatches(manifest: Manifest): boolean {
  const body = { schema: manifest.schema, gate: manifest.gate, set: manifest.set, harnessSha: manifest.harnessSha, inputsSha256: manifest.inputsSha256, rows: manifest.rows };
  return manifest.manifestSha256 === canonicalSha256(body);
}

const reason = (reasons: GateReason[], code: GateReasonCode, detail: string, fields: Pick<GateReason, "key" | "leg"> = {}) => {
  reasons.push({ code, detail, ...fields });
};

function sutMatches(expected: RunInputs["sut"], observed: ValidatedRunReport["sut"]): boolean {
  if (expected.source !== observed.source) return false;
  if (expected.source === "published") return expected.cli.version === observed.cli.version
    && expected.cli.integrity === observed.cli.integrity
    && expected.nodeSdk.version === observed.nodeSdk.version
    && expected.nodeSdk.integrity === observed.nodeSdk.integrity
    && expected.lockfileSha256 === observed.lockfileSha256;
  return expected.gitSha === observed.gitSha && expected.distSha256 === observed.distSha256;
}

async function validateRowArtifacts(leg: LegEvidence, result: ValidatedRunReport["results"][number], required: string[], missing: string[]): Promise<void> {
  const reported = new Map(result.artefacts.map((item) => [item.path, item]));
  const root = resolve(leg.directory);
  for (const path of required) {
    const entry = reported.get(path);
    if (!entry) { missing.push(path); continue; }
    const artifactPath = resolve(root, result.artefactDir, path);
    if (!artifactPath.startsWith(`${root}/`)) { missing.push(path); continue; }
    let bytes: Buffer;
    try { bytes = await readFile(artifactPath); } catch { missing.push(path); continue; }
    if (bytes.byteLength !== entry.bytes || (bytes.byteLength === 0 && !path.endsWith(".log") && !path.endsWith(".jsonl")) || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) missing.push(path);
  }
}



async function buildVerdict(options: AggregateOptions, resolveManifest: Manifest | null, manifest: Manifest | null, selectedLegs: LegEvidence[], invalidLegs: readonly { evidence: LegEvidence; detail: string }[], conclusion: AggregateReport["legCoreConclusion"], companion: boolean): Promise<Verdict> {
  const reasons: GateReason[] = [];
  if (!manifest) {
    reason(reasons, "MANIFEST_MISMATCH", "aggregate checkout could not recompute the manifest");
    return { passed: false, reasons, rows: [] };
  }
  if (options.inputs.gate && !companion && manifest.rows.length === 0) reason(reasons, "MANIFEST_MISMATCH", "production gate core manifest is empty");
  if (!resolveManifest || !manifestHashMatches(resolveManifest) || resolveManifest.manifestSha256 !== manifest.manifestSha256) reason(reasons, "MANIFEST_MISMATCH", "recomputed full manifest differs from resolve manifest");
  const expectedBackends = companion ? manifest.rows.length ? ["sqlite"] : [] : options.inputs.gate ? ["sqlite", "pg16"] : options.inputs.backends;
  const reports: { leg: LegEvidence; report: ValidatedRunReport }[] = [];
  for (const invalid of invalidLegs) reason(reasons, "MISSING_LEG", `leg report is not valid evidence: ${invalid.detail}`, { leg: invalid.evidence.name });
  for (const selected of selectedLegs) {
    const parsed = RunReportSchema.safeParse(selected.report);
    if (parsed.success && parsed.data.kind === "leg") reports.push({ leg: selected, report: parsed.data });
  }
  if (options.inputs.gate && !companion) for (const backend of ["sqlite", "pg16"] as const) {
    if (!manifest.rows.some((row) => row.backend === backend)) reason(reasons, "MANIFEST_MISMATCH", `production gate core manifest has no ${backend} rows`);
  }
  for (const backend of expectedBackends) {
    const backendLegs = reports.filter(({ report }) => report.invocation.backends.length === 1 && report.invocation.backends[0] === backend);
    if (backendLegs.length === 0) reason(reasons, "MISSING_LEG", `missing leg for backend ${backend}`, { leg: `${companion ? "companion" : "core"}-${backend}` });
    if (backendLegs.length > 1) reason(reasons, "DUPLICATE_LEG", `multiple legs for backend ${backend}`, { leg: `${companion ? "companion" : "core"}-${backend}` });
  }
  const jobConclusion = companion ? options.legCompanionConclusion : conclusion;
  if ((!companion || manifest.rows.length > 0) && jobConclusion !== "success") reason(reasons, "LEG_JOB_FAILED", `${companion ? "companion" : "core"} leg job concluded ${jobConclusion}`);
  if (!manifestHashMatches(manifest) || manifest.harnessSha !== options.inputs.harnessSha || manifest.inputsSha256 !== options.inputs.inputsSha256) reason(reasons, "MANIFEST_MISMATCH", "recomputed manifest hash or inputs do not match resolved inputs");

  const expectedRows = manifest.rows;
  const expectedByKey = new Map(expectedRows.map((row) => [row.key, row]));
  const observedByKey = new Map<string, { leg: LegEvidence; report: ValidatedRunReport; result: ValidatedRunReport["results"][number] }[]>();
  const { inputsSha256, ...inputBody } = options.inputs;
  if (canonicalSha256(inputBody) !== inputsSha256) reason(reasons, "INPUTS_MISMATCH", "resolved inputs hash does not match its contents");
  for (const { leg, report } of reports) {
    for (const mismatch of verifyLegInputs(options.inputs, report)) {
      const code: GateReasonCode = mismatch.field === "image.digest" ? "IMAGE_MISMATCH"
        : mismatch.field === "subject" || mismatch.field === "harnessSha" ? "SUBJECT_MISMATCH"
          : mismatch.field.startsWith("sut.") || mismatch.field === "sut" ? "SUT_IDENTITY_MISMATCH"
            : "INPUTS_MISMATCH";
      reason(reasons, code, `${mismatch.field}: expected ${mismatch.expected}, got ${mismatch.actual}`, { leg: leg.name });
    }
    if (report.manifestSha256 !== manifest.manifestSha256) reason(reasons, "MANIFEST_MISMATCH", "leg manifest SHA differs from the recomputed manifest", { leg: leg.name });
    if (report.filtered || report.invocation.only !== null || (!companion && (report.invocation.tiers.length !== 1 || report.invocation.tiers[0] !== "core"))) reason(reasons, "FILTERED_LEG", "gate leg was filtered", { leg: leg.name });
    for (const leaked of report.teardown.leaked) reason(reasons, "TEARDOWN_LEAK", `resource leaked: ${leaked.kind}/${leaked.name}`, { leg: leg.name });
    for (const result of report.results) {
      const expected = expectedByKey.get(result.key);
      const reportBackend = report.invocation.backends.length === 1 ? report.invocation.backends[0] : null;
      if (!expected || result.id !== expected.id || result.variant !== expected.variant || result.tier !== expected.tier
        || result.backend !== expected.backend || reportBackend !== expected.backend) {
        reason(reasons, "EXTRA_ROW", "row identity or backend does not match the manifest and supplying leg", { key: result.key, leg: leg.name });
        continue;
      }
      const entries = observedByKey.get(result.key) ?? [];
      entries.push({ leg, report, result });
      observedByKey.set(result.key, entries);
    }
  }
  const aggregateRows: AggregateRow[] = [];
  for (const expected of expectedRows) {
    const found = observedByKey.get(expected.key) ?? [];
    if (found.length !== 1) reason(reasons, found.length ? "EXTRA_ROW" : "MISSING_ROW", found.length ? "manifest row occurred more than once" : "manifest row is absent", { key: expected.key });
    const selected = found[0];
    const result = selected?.result;
    const missingArtefacts: string[] = [];
    if (selected && result) await validateRowArtifacts(selected.leg, result, expected.requiredArtefacts, missingArtefacts);
    if (!selected || missingArtefacts.length) reason(reasons, "MISSING_ARTEFACT", !selected ? "row report is absent" : `missing, changed, or unreadable artefacts: ${missingArtefacts.join(", ")}`, { key: expected.key });
    const quarantined = Boolean(result && selected?.report.quarantined.includes(expected.key));
    if (quarantined) reason(reasons, "QUARANTINED", "manifest row is quarantined", { key: expected.key });
    if (!result || result.status !== "pass") reason(reasons, "ROW_NOT_PASS", `row status is ${result?.status ?? "missing"}`, { key: expected.key });
    aggregateRows.push({ ...expected, status: result?.status ?? "missing", ...(result?.reason ? { reason: result.reason } : {}), durationMs: result?.durationMs ?? null,
      artefactDir: result ? join(selected!.leg.name, result.artefactDir) : null, missingArtefacts, quarantined });
  }
  const requiredSource = options.inputs.gate === "tc858-phase1-beta" ? "published" : "workspace";
  if (options.inputs.gate && options.inputs.sut.source !== requiredSource) reason(reasons, "SUT_SOURCE_MISMATCH", `gate requires ${requiredSource} SUT`);
  if (options.inputs.gate && (options.inputs.image.role !== "prod" || options.inputs.production?.version !== options.inputs.image.nodeVersion)) reason(reasons, "PROD_VERSION_MISMATCH", "resolved production version differs from prod image version");
  return { passed: reasons.length === 0, reasons, rows: aggregateRows };
}

export async function aggregate(options: AggregateOptions): Promise<AggregateReport> {
  if (options.inputs.gate === "tc858-phase1-workspace" && options.inputs.subject.event !== "local") validateJunitPrecondition(options.inputs.junitPrecondition, options.inputs.subject);
  const coreLegs: LegEvidence[] = [];
  const companionLegs = new Map<SetId, LegEvidence[]>();
  const parsedLegs: { evidence: LegEvidence; report: ValidatedRunReport }[] = [];
  const invalidLegs = new Map<SetId | "core" | "companion", { evidence: LegEvidence; detail: string }[]>();
  const failIfPassing = (conclusion: AggregateReport["legCoreConclusion"]) => conclusion === "success" ? "failure" as const : conclusion;
  for (const evidence of options.legs) {
    const parsed = RunReportSchema.safeParse(evidence.report);
    if (!parsed.success || parsed.data.kind !== "leg") {
      const detail = evidence.parseError
        ? `report.json is not valid JSON (${evidence.parseError})`
        : parsed.success
          ? `report kind ${JSON.stringify(parsed.data.kind)} is not "leg"`
          : `report fails schema validation (${parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : "invalid"})`;
      const expected = options.expectedLegs?.find((entry) => entry.name === evidence.name);
      const set: SetId | "core" | "companion" = expected ? (expected.set ?? "core") : evidence.name.startsWith("companion-") ? "companion" : "core";
      invalidLegs.set(set, [...(invalidLegs.get(set) ?? []), { evidence, detail }]);
      continue;
    }
    parsedLegs.push({ evidence, report: parsed.data });
    if (parsed.data.invocation.set === null) coreLegs.push(evidence);
    else {
      const set = parsed.data.invocation.set;
      companionLegs.set(set, [...(companionLegs.get(set) ?? []), evidence]);
    }
  }
  let legCoreConclusion = options.legCoreConclusion;
  let legCompanionConclusion = options.legCompanionConclusion;
  if (invalidLegs.has("core")) legCoreConclusion = failIfPassing(legCoreConclusion);
  for (const set of invalidLegs.keys()) if (set !== "core") legCompanionConclusion = failIfPassing(legCompanionConclusion);
  if (!options.inputs.gate) {
    if (!options.expectedLegs?.length) legCoreConclusion = failIfPassing(legCoreConclusion);
    else {
      for (const expected of options.expectedLegs) {
        const matches = parsedLegs.filter(({ evidence, report }) => evidence.name === expected.name
          && report.invocation.backends.length === 1 && report.invocation.backends[0] === expected.backend
          && report.invocation.set === expected.set);
        if (matches.length !== 1) {
          if (expected.set === null) legCoreConclusion = failIfPassing(legCoreConclusion);
          else legCompanionConclusion = failIfPassing(legCompanionConclusion);
        }
      }
      for (const { evidence, report } of parsedLegs) {
        const inMatrix = options.expectedLegs.some((expected) => expected.name === evidence.name
          && report.invocation.backends.length === 1 && report.invocation.backends[0] === expected.backend
          && report.invocation.set === expected.set);
        const mismatchedInputs = report.inputsSha256 !== options.inputs.inputsSha256;
        if (!inMatrix || mismatchedInputs) {
          if (report.invocation.set === null) legCoreConclusion = failIfPassing(legCoreConclusion);
          else legCompanionConclusion = failIfPassing(legCompanionConclusion);
        }
      }
      for (const evidence of options.legs) {
        if (options.expectedLegs.some((expected) => expected.name === evidence.name)) continue;
        const parsed = parsedLegs.find((leg) => leg.evidence === evidence)?.report;
        const companion = parsed ? parsed.invocation.set !== null : evidence.name.startsWith("companion-");
        if (companion) legCompanionConclusion = failIfPassing(legCompanionConclusion);
        else legCoreConclusion = failIfPassing(legCoreConclusion);
      }
    }
  }
  const core = options.inputs.gate ? await buildVerdict(options, options.coreManifest, options.recomputedCoreManifest, coreLegs, invalidLegs.get("core") ?? [], legCoreConclusion, false) : null;
  const companion: AggregateReport["companion"] = [];
  const unknownCompanion = invalidLegs.get("companion") ?? [];
  const companionSets = new Set<SetId>([...options.inputs.sets, ...options.companionManifests.keys(), ...options.recomputedCompanionManifests.keys(), ...companionLegs.keys()]);
  for (const set of companionSets) {
    const manifest = options.recomputedCompanionManifests.get(set) ?? null;
    const verdict = await buildVerdict(options, options.companionManifests.get(set) ?? null, manifest, companionLegs.get(set) ?? [],
      [...(invalidLegs.get(set) ?? []), ...unknownCompanion], legCompanionConclusion, true);
    companion.push({ set, manifestSha256: manifest?.manifestSha256 ?? "", ...verdict });
  }
  const gate = core && options.inputs.gate && options.recomputedCoreManifest
    ? { id: options.inputs.gate as GateId, manifestSha256: options.recomputedCoreManifest.manifestSha256, ...core, passed: legCoreConclusion === "success" && core.passed }
    : null;
  const legs: AggregateReport["legs"] = parsedLegs.map(({ evidence, report }) => {
    const summary = { pass: 0, fail: 0, error: 0, skipped: 0, unsupported: 0, xfail: 0, xpass: 0, ...report.summary };
    return {
      name: evidence.name, backend: report.invocation.backends[0]!, set: report.invocation.set, runId: report.runId,
      reportSha256: evidence.reportSha256 ?? canonicalSha256(report), inputsSha256: report.inputsSha256 ?? "", manifestSha256: report.manifestSha256,
      filtered: report.filtered, durationMs: report.durationMs, summary,
    };
  });
  const report: AggregateReport = {
    schema: "tc893.aggregate/v1", inputs: options.inputs, gate, companion, adhoc: options.inputs.gate ? null : { rows: parsedLegs.flatMap(({ report }) => report.results.map((row) => ({
      key: row.key, id: row.id, variant: row.variant, backend: row.backend, tier: row.tier, requiredArtefacts: row.artefacts.map((file) => file.path), status: row.status,
      ...(row.reason ? { reason: row.reason } : {}), durationMs: row.durationMs, artefactDir: row.artefactDir, missingArtefacts: [], quarantined: report.quarantined.includes(row.key),
    }))) },
    legs, legCoreConclusion, legCompanionConclusion, producedAt: options.producedAt ?? new Date().toISOString(),
  };
  return AggregateReportSchema.parse(report) as AggregateReport;
}
export function aggregateExitCode(report: AggregateReport): 0 | 1 | 3 {
  if (report.inputs.gate) return report.gate?.passed ? 0 : 3;
  if (report.legCoreConclusion !== "success" || report.legCompanionConclusion !== "success" || !report.legs.length) return 1;
  return report.adhoc?.rows.every((row) => row.status === "pass" && !row.quarantined && row.missingArtefacts.length === 0) ? 0 : 1;
}
