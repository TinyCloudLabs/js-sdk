---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/courier": patch
---

Courier looks each owner up in the location registry once per command instead of once per node call. A `watch --once` pass made 28 to 34 registry lookups for one owner, and `read` of a 344-entry thread made 698; each now makes one lookup per owner (for an owner with no registry record, one v2 and one v1).

sdk-core adds an opt-in `verdictCache` option on `lookupOwnerRegistryVerdict`, `resolveRegistryResource` and `resolveFailClosedTinyCloudHosts`, and the entry point `@tinycloud/sdk-core/registry-verdict-cache` with `createRegistryVerdictCache()`, `REGISTRY_VERDICT_REGISTERED_TTL_MS`, `REGISTRY_VERDICT_UNREGISTERED_TTL_MS` and `REGISTRY_VERDICT_CACHE_MAX_ENTRIES`. node-sdk adds the `registryVerdictCache` option on `TinyCloudNode`.

How the cache behaves:
- It is keyed by owner DID and by the registry base the lookup fetches (host case and a default port don't matter; a URL with a query, fragment or credentials is kept as given), and concurrent lookups of one owner share one request.
- It keeps a registered record and a confirmed absence (v2 and v1 both not found) for 60 seconds each, on a monotonic clock, so a revoked registration stops routing and a new one is seen within a minute. It holds at most 256 owners.
- It never keeps an unavailable verdict, an outage fallback from saved settings or a failed lookup.
- A verdict, kept or still in flight, is served to a client only if that client's own registry stores agree with it: a registered record only when the client already holds that exact sequence, or an absence only for an owner the client has no registration evidence for (no sequence marker, no saved settings). Otherwise the client looks the owner up itself, which raises its floor and saves its settings. A failed or unavailable lookup is shared with clients waiting on it as it is.
- A route the record does not list, in routing or at sign-in, drops the owner's entry at once, and a refresh that finds no record drops the registered one.

Without the option, every lookup asks the registry, as before.

Courier gives every node it creates the same cache, registry sequence store and saved-settings store, so `send`, `read`, `inbox`, `watch`, `intake` and `outbox serve` share one lookup per owner. A long-running `watch`, `intake` or `outbox serve` looks an owner up again after those bounds.

Details: TC-2970
