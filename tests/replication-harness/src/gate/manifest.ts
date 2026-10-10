import type { Backend, SetId } from "../contracts/common";
import type { Manifest, ManifestRow, RunInputs } from "../contracts/gate";
import type { RunContextView, Scenario } from "../contracts/scenario";
import type { TopologySpec } from "../contracts/topology";
import { ManifestSchema } from "../schemas/gate";
import { canonicalSha256 } from "./canonical-json";

export interface ManifestRegistry { scenarios: readonly Scenario[]; context: RunContextView }

function requiredArtifacts(spec: TopologySpec): string[] {
  return ["result.json", "topology.json", ...spec.nodes.map((node) => `nodes/${node.id}.log`), ...spec.clients.flatMap((client) => [`clients/${client.id}/events.jsonl`, `clients/${client.id}/stderr.log`])].sort();
}

export function createManifest(inputs: RunInputs, registry: ManifestRegistry, set: SetId | null = null): Manifest {
  const gate = inputs.gate;
  const rows: ManifestRow[] = [];
  const backends = (set ? ["sqlite"] : inputs.gate ? ["sqlite", "pg16"] : inputs.backends) as Backend[];
  for (const scenario of registry.scenarios) {
    const selected = set ? scenario.sets?.includes(set) : inputs.gate ? scenario.tier === "core" : inputs.tiers.includes(scenario.tier);
    if (!selected) continue;
    const variants: readonly (string | null)[] = scenario.variants?.length ? scenario.variants : [null];
    for (const variant of variants) {
      for (const backend of backends) {
        if (scenario.backends && !scenario.backends.includes(backend)) continue;
        if (scenario.appliesTo) {
          const applicability = scenario.appliesTo(registry.context, variant ?? "");
          if (applicability !== true) continue;
        }
        const spec = scenario.topology(variant ?? "", backend);
        const key = `${scenario.id}${variant === null ? "" : `[${variant}]`}@${backend}`;
        rows.push({ key, id: scenario.id, variant, backend, tier: scenario.tier, requiredArtefacts: requiredArtifacts(spec) });
      }
    }
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  if (set === null && inputs.gate) {
    if (!rows.length) throw new Error("production gate core manifest must not be empty");
    for (const backend of ["sqlite", "pg16"] as const) if (!rows.some((row) => row.backend === backend)) throw new Error(`production gate core manifest has no ${backend} rows`);
  }
  const body = { schema: "tc893.manifest/v1" as const, gate, set, harnessSha: inputs.harnessSha, inputsSha256: inputs.inputsSha256, rows };
  return ManifestSchema.parse({ ...body, manifestSha256: canonicalSha256(body) });
}
