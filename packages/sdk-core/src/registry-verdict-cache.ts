/**
 * Opt-in registry verdict cache (TC-2970), a separate entry point so the root
 * bundle does not carry it: `@tinycloud/sdk-core/registry-verdict-cache`.
 */
import type { RegistryCacheStore } from "./registry-cache";
import type { RegistrySequenceStore, RegistryVerdictCache, RegistryVerdictScope } from "./registry-policy";
import { registryOwnerKeyV2, type RegistryVerdict } from "./registry-verdict";

export type { RegistryVerdictCache, RegistryVerdictScope };

/** How long a {@link RegistryVerdictCache} reuses a verified registered record, so a revoked registration stops routing within a minute. */
export const REGISTRY_VERDICT_REGISTERED_TTL_MS = 60_000;
/** How long it reuses a confirmed absence (v2 and v1 both not found), so a new registration is seen within a minute. */
export const REGISTRY_VERDICT_UNREGISTERED_TTL_MS = 60_000;
/** Owners one cache holds; expired entries go first, then the oldest. */
export const REGISTRY_VERDICT_CACHE_MAX_ENTRIES = 256;

interface Entry {
  verdict: Promise<RegistryVerdict>;
  settled?: RegistryVerdict;
  expiresAt: number;
}

/**
 * The registry base the lookup fetches (`registry-policy` drops one trailing slash), with the host's case and a default
 * port normalised: `https://Registry.test:443/` and `https://registry.test` are one registry. A URL with `?`, `#`, `@`,
 * `\` or whitespace is refused: the parser would key it as another spelling while the lookup fetches a different path.
 */
function registryKey(registryUrl: string): string {
  const found = [["?", "query"], ["#", "fragment"], ["@", "credentials"], ["\\", "backslash"]]
    .filter(([character]) => registryUrl.includes(character!)).map(([, name]) => name);
  if (/\s/.test(registryUrl)) found.push("whitespace");
  // The URL itself is never echoed: it may carry credentials.
  if (found.length) {
    throw new TypeError(`A registry URL used with a verdict cache must not contain a query, fragment, credentials, backslash or whitespace (found: ${found.join(", ")})`);
  }
  try {
    const url = new URL(registryUrl);
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return registryUrl;
  }
}

/**
 * Whether the reading client's own stores allow a verdict another lookup
 * produced, without changing anything the client would decide itself:
 * - a registered record only when the client already holds that exact
 *   sequence (in its sequence store and its saved settings, for each it has);
 * - an absence only when the client has no registration evidence for the owner
 *   (no sequence marker, no saved settings, no known-owner revision).
 * Otherwise the client looks up itself, so its own rollback and known-owner
 * checks decide, and the lookup raises its floor and saves its settings.
 */
async function usableFor(scope: RegistryVerdictScope, verdict: RegistryVerdict): Promise<boolean> {
  try {
    const ownerKey = registryOwnerKeyV2(scope.subject);
    const evidence = await registration(scope.sequenceStore, ownerKey);
    const saved = await scope.cacheStore?.get(ownerKey);
    if (verdict.status === "unregistered") {
      return evidence === undefined && saved === undefined && !(scope.cacheStore && await scope.cacheStore.getRevision(ownerKey) > 0);
    }
    // An outage fallback built from another client's saved settings is never reused: the client's own lookup decides.
    if (verdict.status !== "registered" || verdict.offline) return false;
    if (scope.sequenceStore && !(evidence && evidence.kind !== "legacy-v1" && evidence.sequence === verdict.sequence)) return false;
    return !scope.cacheStore || saved?.sequence === verdict.sequence;
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
 * record or a confirmed absence is kept, each for 60 s; an unavailable verdict,
 * an outage fallback from saved settings and a failed lookup are dropped as
 * they settle, so the next call asks the registry again. A kept verdict is
 * served to a client only if its own stores allow it. Times use a monotonic
 * clock (`performance.now`). The absent-reads mode retains only confirmed absence, for lookups marked
 * `dataRead`; registered results and every unmarked lookup always perform their own lookup.
 */
export function createRegistryVerdictCache(options: { now?: () => number; mode?: "absent-reads" } = {}): RegistryVerdictCache {
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
      if (options.mode === "absent-reads" && scope.dataRead !== true) {
        entries.delete(key);
        return lookup();
      }
      const known = entries.get(key);
      if (known && now() < known.expiresAt) {
        // Kept or still in flight: either way the reader's own checks run on the result. A failure (thrown or
        // unavailable) fails closed for every caller, so it is shared as it is.
        const verdict = await known.verdict;
        if (verdict.status === "unavailable" ||
            (verdict.status !== "registered" || options.mode !== "absent-reads") && await usableFor(scope, verdict)) return verdict;
        if (entries.get(key) === known) entries.delete(key);
      }
      // In flight: shared until it settles. Registered first, so it settles the entry before any caller resumes.
      const entry: Entry = { verdict: lookup(), expiresAt: Number.POSITIVE_INFINITY };
      insert(key, entry);
      entry.verdict.then((verdict) => {
        if (entries.get(key) !== entry) return;
        const ttl = verdict.status === "unavailable" || verdict.offline ? undefined
          : verdict.status === "registered" ? (options.mode === "absent-reads" ? undefined : REGISTRY_VERDICT_REGISTERED_TTL_MS) : REGISTRY_VERDICT_UNREGISTERED_TTL_MS;
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
      // A refused registry URL never has an entry.
      if (!/[?#@\\\s]/.test(registryUrl)) entries.delete(keyOf(registryUrl, subject));
    },
  };
}
