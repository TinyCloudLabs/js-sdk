import type { Backend, SetId, Tier } from "../contracts/common";
import type { Requirement, RunContextView, Scenario } from "../contracts/scenario";

export type ScenarioRow = { key: string; id: string; variant: string | null; backend: Backend; tier: Tier; sets: SetId[]; scenario: Scenario; reason?: string; unavailableStatus?: "skipped" | "unsupported"; forcedUnsupported?: boolean };
export type RegistryFilters = { tiers?: readonly Tier[]; set?: SetId | null; only?: readonly string[]; variants?: readonly string[]; backends: readonly Backend[]; forceUnsupported?: boolean };
export type ProbeRequirement = (requirement: Requirement) => true | string;
export const scenarioRegistry: Scenario[] = [];
export function registerScenarios(...scenarios: Scenario[]): void {
  scenarioRegistry.push(...scenarios);
}


export function validateRegistry(scenarios: readonly Scenario[]): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(scenario.id)) throw new Error(`invalid scenario id: ${scenario.id}`);
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!scenario.title.trim()) throw new Error(`${scenario.id}: title is required`);
    if (!Number.isFinite(scenario.timeoutMs) || scenario.timeoutMs <= 0) throw new Error(`${scenario.id}: timeoutMs must be positive`);
    if (scenario.tier === "core" && (scenario.appliesTo !== undefined || scenario.requires !== undefined)) {
      throw new Error(`${scenario.id}: core scenarios cannot declare appliesTo or requires`);
    }
    if (scenario.appliesTo && !scenario.variants?.length) throw new Error(`${scenario.id}: appliesTo requires explicit variants`);
    if (scenario.variants && new Set(scenario.variants).size !== scenario.variants.length) throw new Error(`${scenario.id}: duplicate variants`);
  }
  if (scenarios.some((scenario) => scenario.tier === "core") && !scenarios.some((scenario) => scenario.id === "CORE-00" && scenario.tier === "core")) {
    throw new Error("core registry requires CORE-00");
  }
}

export function expandScenarios(scenarios: readonly Scenario[], filters: RegistryFilters, run: RunContextView,
  probe: ProbeRequirement = () => true): ScenarioRow[] {
  validateRegistry(scenarios);
  const tiers = filters.tiers ?? run.tiers;
  const selected = scenarios.filter((s) => tiers.includes(s.tier) && (!filters.set || s.sets?.includes(filters.set)) &&
    (!filters.only?.length || filters.only.includes(s.id)));
  const rows: ScenarioRow[] = [];
  for (const scenario of selected) {
    const variants = scenario.variants?.length ? [...scenario.variants] : [null];
    for (const variant of variants) {
      if (filters.variants?.length && (!variant || !filters.variants.includes(variant))) continue;
      if (scenario.appliesTo && variant !== null) {
        const applies = scenario.appliesTo(run, variant);
        if (applies !== true) continue;
      }
      const requirementFailure = scenario.requires?.map((requirement) => ({ requirement, result: probe(requirement) })).find(({ result }) => result !== true);
      const forceUnsupported = filters.forceUnsupported && requirementFailure?.requirement === "tc12:host-sync";
      for (const backend of scenario.backends ?? filters.backends) {
        if (!filters.backends.includes(backend)) continue;
        const key = `${scenario.id}${variant === null ? "" : `[${variant}]`}@${backend}`;
        rows.push({ key, id: scenario.id, variant, backend, tier: scenario.tier, sets: [...(scenario.sets ?? [])], scenario,
          ...(requirementFailure && !forceUnsupported ? { reason: requirementFailure.result as string,
            unavailableStatus: requirementFailure.requirement === "tc12:host-sync" ? "unsupported" as const : "skipped" as const } : {}),
          ...(forceUnsupported ? { forcedUnsupported: true } : {}) });
      }
    }
  }
  return rows;
}

export function filterRows(rows: readonly ScenarioRow[], filters: RegistryFilters): ScenarioRow[] {
  return rows.filter((row) => (!filters.tiers || filters.tiers.includes(row.tier)) && (!filters.set || row.sets.includes(filters.set)) &&
    (!filters.only?.length || filters.only.includes(row.id)) && (!filters.variants?.length || (row.variant !== null && filters.variants.includes(row.variant))) &&
    filters.backends.includes(row.backend));
}
