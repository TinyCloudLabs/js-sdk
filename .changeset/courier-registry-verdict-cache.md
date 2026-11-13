---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/courier": patch
---

Courier looks each owner up in the location registry once per command instead of once per node call. A `watch --once` pass made 28 to 34 registry lookups for one owner, and `read` of a 344-entry thread made 698; each now makes one lookup per owner (for an owner with no registry record, one v2 and one v1).

sdk-core adds an opt-in `verdictCache` option on `lookupOwnerRegistryVerdict`, `resolveRegistryResource` and `resolveFailClosedTinyCloudHosts`, and the entry point `@tinycloud/sdk-core/registry-verdict-cache` with `createRegistryVerdictCache()`, `REGISTRY_VERDICT_REGISTERED_TTL_MS`, `REGISTRY_VERDICT_UNREGISTERED_TTL_MS` and `REGISTRY_VERDICT_CACHE_MAX_ENTRIES`. node-sdk adds the `registryVerdictCache` option on `TinyCloudNode`.

How the cache behaves:
- It is keyed by registry URL (one entry however the URL is spelled) and owner DID, and concurrent lookups of one owner share one request.
- It keeps a registered record for 5 minutes and a confirmed absence (v2 and v1 both not found) for 60 seconds, on a monotonic clock, and holds at most 256 owners.
- It never keeps an unavailable verdict, an outage fallback from saved settings or a failed lookup.
- A kept verdict is served to a client only if that client's own registry stores agree with it: a registered record no older than the sequence the client remembers and present in its saved settings, or an absence for an owner the client has no registration evidence for. Otherwise the client looks the owner up itself.
- A route the record does not list, in routing or at sign-in, drops the owner's entry at once, and a refresh that finds no record drops the registered one.

Without the option, every lookup asks the registry, as before.

Courier gives every node it creates the same cache, registry sequence store and saved-settings store, so `send`, `read`, `inbox`, `watch`, `intake` and `outbox serve` share one lookup per owner. A long-running `watch`, `intake` or `outbox serve` looks an owner up again after those bounds.

Details: TC-2970
