import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AggregateReport, Manifest, RunInputs } from "../contracts/gate";
import type { SetId } from "../contracts/common";
import type { LegEvidence } from "./aggregate";
import { aggregate } from "./aggregate";

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
  const aggregateReport = await aggregate({
    inputs: plan.inputs, coreManifest: plan.coreManifest, companionManifests: plan.companionManifests,
    recomputedCoreManifest, recomputedCompanionManifests, legs,
    legCoreConclusion: "success", legCompanionConclusion: "success",
  });
  await writeFile(join(plan.resultsDir, "aggregate.json"), `${JSON.stringify(aggregateReport, null, 2)}\n`);
  return { inputs: plan.inputs, legs, aggregate: aggregateReport };
}
