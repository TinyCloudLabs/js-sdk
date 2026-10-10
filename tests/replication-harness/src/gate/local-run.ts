import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AggregateReport, Manifest, RunInputs } from "../contracts/gate";
import type { SetId } from "../contracts/common";
import type { LegEvidence } from "./aggregate";
import { aggregate } from "./aggregate";

function legConclusion(legs: LegEvidence[], set?: SetId | null): "success" | "failure" | "cancelled" {
  const selected = legs.filter((leg) => {
    const report = leg.report as { invocation?: { set?: SetId | null }; interrupted?: boolean; results?: { status?: string; reason?: string }[] };
    return set === undefined ? report.invocation?.set !== null && report.invocation?.set !== undefined : report.invocation?.set === set;
  });
  if (!selected.length) return "failure";
  if (selected.some((leg) => {
    const report = leg.report as { interrupted?: boolean; results?: { status?: string; reason?: string }[] };
    return report.interrupted === true || report.results?.some((row) => row.reason === "INTERRUPTED" || row.status === "cancelled");
  })) return "cancelled";
  if (selected.some((leg) => {
    const report = leg.report as { results?: { status?: string }[] };
    return !report.results || report.results.some((row) => row.status !== "pass");
  })) return "failure";
  return "success";
}

export interface LocalGatePlan {
  inputs: RunInputs;
  coreManifest: Manifest;
  companionManifests: ReadonlyMap<SetId, Manifest>;
  matrix: readonly { name: string; backend: string; set: SetId | null }[];
  resultsDir: string;
}
export interface LocalGateHooks {
  resolve(): Promise<LocalGatePlan>;
  runLeg(entry: LocalGatePlan["matrix"][number], inputs: RunInputs, resultsDir: string): Promise<LegEvidence>;
  recomputeManifest(set: SetId | null, inputs: RunInputs): Promise<Manifest>;
}
export interface LocalGateResult { inputs: RunInputs; legs: LegEvidence[]; aggregate: AggregateReport }

/** S3a supplies runLeg; this owns the resolve → core/companion → aggregate local gate sequence. */
export async function runGateLocally(hooks: LocalGateHooks): Promise<LocalGateResult> {
  const plan = await hooks.resolve();
  await mkdir(plan.resultsDir, { recursive: true });
  const legs: LegEvidence[] = [];
  for (const entry of plan.matrix) legs.push(await hooks.runLeg(entry, plan.inputs, join(plan.resultsDir, entry.name)));
  const recomputedCoreManifest = await hooks.recomputeManifest(null, plan.inputs);
  const recomputedCompanionManifests = new Map<SetId, Manifest>();
  for (const set of plan.companionManifests.keys()) recomputedCompanionManifests.set(set, await hooks.recomputeManifest(set, plan.inputs));
  const legCoreConclusion = legConclusion(legs, null);
  const companionHasRows = [...plan.companionManifests.values()].some((manifest) => manifest.rows.length > 0);
  const legCompanionConclusion = companionHasRows ? legConclusion(legs) : "success";
  const aggregateReport = await aggregate({
    inputs: plan.inputs, coreManifest: plan.coreManifest, companionManifests: plan.companionManifests,
    recomputedCoreManifest, recomputedCompanionManifests, legs, legCoreConclusion, legCompanionConclusion,
  });
  await writeFile(join(plan.resultsDir, "aggregate.json"), `${JSON.stringify(aggregateReport, null, 2)}\n`);
  return { inputs: plan.inputs, legs, aggregate: aggregateReport };
}
