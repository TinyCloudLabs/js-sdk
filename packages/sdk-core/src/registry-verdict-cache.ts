/**
 * Opt-in registry verdict cache (TC-2970), a separate entry point so the root
 * bundle does not carry it: `@tinycloud/sdk-core/registry-verdict-cache`.
 */
import type { RegistryVerdictCache } from "./registry-policy";
import type { RegistryVerdict } from "./registry-verdict";

export type { RegistryVerdictCache };

/** How long a {@link RegistryVerdictCache} reuses a verified registered record. */
export const REGISTRY_VERDICT_REGISTERED_TTL_MS = 300_000;
/** How long it reuses a confirmed absence (v2 and v1 both not found), so a new registration is seen within a minute. */
export const REGISTRY_VERDICT_UNREGISTERED_TTL_MS = 60_000;

/**
 * Concurrent lookups of one owner share one request. Only a live registered
 * record or a confirmed absence is kept; an unavailable verdict, an outage
 * fallback from saved settings and a failed lookup are dropped as they settle,
 * so the next call asks the registry again.
 */
export function createRegistryVerdictCache(options: { now?: () => number } = {}): RegistryVerdictCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { verdict: Promise<RegistryVerdict>; expiresAt: number }>();
  const keyOf = (registryUrl: string, subject: string) => `${registryUrl.replace(/\/$/, "")}\n${subject}`;
  return {
    get(registryUrl, subject, lookup) {
      const key = keyOf(registryUrl, subject);
      const known = entries.get(key);
      if (known && now() < known.expiresAt) return known.verdict;
      // In flight: shared until it settles. Registered first, so it settles the entry before any caller resumes.
      const entry = { verdict: lookup(), expiresAt: Number.POSITIVE_INFINITY };
      entries.set(key, entry);
      entry.verdict.then((verdict) => {
        if (entries.get(key) !== entry) return;
        const ttl = verdict.status === "unavailable" || verdict.offline ? undefined
          : verdict.status === "registered" ? REGISTRY_VERDICT_REGISTERED_TTL_MS : REGISTRY_VERDICT_UNREGISTERED_TTL_MS;
        if (ttl === undefined) entries.delete(key);
        else entry.expiresAt = now() + ttl;
      }, () => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.verdict;
    },
    invalidate(registryUrl, subject) {
      entries.delete(keyOf(registryUrl, subject));
    },
  };
}
