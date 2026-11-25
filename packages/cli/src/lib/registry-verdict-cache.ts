import { setTimeout } from "node:timers/promises";
import { createRegistryVerdictCache, type RegistryVerdictCache } from "@tinycloud/sdk-core/registry-verdict-cache";

/** Retry only the fresh-owner outage, inside the shared lookup, never a data operation. */
export function createCliRegistryVerdictCache(sleep: (ms: number) => Promise<void> = setTimeout): RegistryVerdictCache {
  const cache = createRegistryVerdictCache();
  return {
    get(scope, lookup) {
      return cache.get(scope, async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const verdict = await lookup();
            if (attempt === 2 || verdict.status !== "unregistered" || !verdict.offline) return verdict;
          } catch (error) {
            const failure = error as { code?: unknown; meta?: { reason?: unknown } } | null;
            if (attempt === 2 || failure?.code !== "registry_unavailable" || failure.meta?.reason !== "no-saved-settings") throw error;
          }
          await sleep(attempt === 0 ? 250 : 750);
        }
      });
    },
    invalidate(registryUrl, subject) { cache.invalidate(registryUrl, subject); },
  };
}

// The core cache retains its 60 s TTL, store checks, and explicit invalidation.
export const cliRegistryVerdictCache = createCliRegistryVerdictCache();
