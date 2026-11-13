/**
 * Opt-in registry verdict cache (TC-2970), a separate entry point so the root
 * bundle does not carry it: `@tinycloud/sdk-core/registry-verdict-cache`.
 */
import type { RegistryCacheStore } from "./registry-cache";
import type { RegistrySequenceStore, RegistryVerdictCache, RegistryVerdictScope } from "./registry-policy";
import { registryOwnerKeyV2, type RegistryVerdict } from "./registry-verdict";

export type { RegistryVerdictCache, RegistryVerdictScope };

/** How long a {@link RegistryVerdictCache} reuses a verified registered record. */
export const REGISTRY_VERDICT_REGISTERED_TTL_MS = 300_000;
/** How long it reuses a confirmed absence (v2 and v1 both not found), so a new registration is seen within a minute. */
export const REGISTRY_VERDICT_UNREGISTERED_TTL_MS = 60_000;
/** Owners one cache holds; expired entries go first, then the oldest. */
export const REGISTRY_VERDICT_CACHE_MAX_ENTRIES = 256;

interface Entry {
  verdict: Promise<RegistryVerdict>;
  settled?: RegistryVerdict;
  expiresAt: number;
}

/** `https://Registry.test:443//` and `https://registry.test` are one registry. */
function registryKey(registryUrl: string): string {
  try {
    const url = new URL(registryUrl);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return registryUrl;
  }
}

/**
 * Whether the reading client's own stores allow a verdict another lookup
 * produced: a registered record no older than the sequence this client
 * remembers and present in its saved settings, or an absence for an owner this
 * client has no registration evidence for. Otherwise the client looks up itself,
 * so its own rollback and known-owner checks decide, and its settings are saved.
 */
async function usableFor(scope: RegistryVerdictScope, verdict: RegistryVerdict): Promise<boolean> {
  try {
    const ownerKey = registryOwnerKeyV2(scope.subject);
    const evidence = await registration(scope.sequenceStore, ownerKey);
    if (verdict.status === "unregistered") {
      return evidence === undefined && !(scope.cacheStore && await scope.cacheStore.getRevision(ownerKey) > 0);
    }
    if (verdict.status !== "registered") return false;
    if (evidence && evidence.kind !== "legacy-v1" && verdict.sequence < evidence.sequence) return false;
    return !scope.cacheStore || ((await scope.cacheStore.get(ownerKey))?.sequence ?? Infinity) <= verdict.sequence;
  } catch {
    return false;
  }
}

async function registration(store: RegistrySequenceStore | undefined, ownerKey: string) {
  if (!store) return undefined;
  if (store.getRegistration) return store.getRegistration(ownerKey);
  const sequence = await store.get(ownerKey);
  return sequence === undefined ? undefined : { sequence, kind: "unknown" as const };
}

/**
 * Concurrent lookups of one owner share one request. Only a live registered
 * record (5 min) or a confirmed absence (60 s) is kept; an unavailable verdict,
 * an outage fallback from saved settings and a failed lookup are dropped as
 * they settle, so the next call asks the registry again. A kept verdict is
 * served to a client only if its own stores allow it. Times use a monotonic
 * clock (`performance.now`).
 */
export function createRegistryVerdictCache(options: { now?: () => number } = {}): RegistryVerdictCache {
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, Entry>();
  const keyOf = (registryUrl: string, subject: string) => JSON.stringify([registryKey(registryUrl), subject]);
  const insert = (key: string, entry: Entry) => {
    const at = now();
    for (const [stale, held] of entries) if (held.expiresAt <= at) entries.delete(stale);
    while (entries.size >= REGISTRY_VERDICT_CACHE_MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    entries.set(key, entry);
  };
  return {
    async get(scope, lookup) {
      const key = keyOf(scope.registryUrl, scope.subject);
      const known = entries.get(key);
      if (known && now() < known.expiresAt && (!known.settled || await usableFor(scope, known.settled))) return known.verdict;
      if (entries.get(key) === known) entries.delete(key);
      // In flight: shared until it settles. Registered first, so it settles the entry before any caller resumes.
      const entry: Entry = { verdict: lookup(), expiresAt: Number.POSITIVE_INFINITY };
      insert(key, entry);
      entry.verdict.then((verdict) => {
        if (entries.get(key) !== entry) return;
        const ttl = verdict.status === "unavailable" || verdict.offline ? undefined
          : verdict.status === "registered" ? REGISTRY_VERDICT_REGISTERED_TTL_MS : REGISTRY_VERDICT_UNREGISTERED_TTL_MS;
        if (ttl === undefined) entries.delete(key);
        else {
          entry.settled = verdict;
          entry.expiresAt = now() + ttl;
        }
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
