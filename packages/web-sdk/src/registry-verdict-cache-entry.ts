import { createRegistryVerdictCache as createCache } from "@tinycloud/sdk-core/registry-verdict-cache";

export function createRegistryVerdictCache() {
  return createCache({ mode: "absent-reads" });
}
