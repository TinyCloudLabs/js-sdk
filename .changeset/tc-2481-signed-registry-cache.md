---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
"@tinycloud/sdk-services": patch
"@tinycloud/replica": patch
---
Persist exact owner-signed v2 registry responses with separate fetch metadata, verify every cached read, and replace signed bytes only with strictly higher sequences. Every owner routing decision awaits a bounded refresh; overlapping requests coalesce, while subsequent decisions refresh again. Successful equal-sequence checks may renew fetch time without replacing signed bytes. Node and browser SDKs accept matching cache adapters; browser updates and deletion serialize across tabs.

The CLI and canonical Operations runtime share an owner-only, readable profile cache and atomic profile-store updates. Add read-only `tc registry show [did]` for owner, sequence, fetch age, full space placement, modes, hostnames and encryption destination, without sign-in, grant activation or network access.

Verified restored entries establish independent sequence history before direct refresh. Each caller enforces its own captured and current sequence history when joining an in-flight refresh, including registered results shared through a cache with independent sequence adapters. Profile registry transactions serialize within an already-held profile lock, and browser sequence maxima merge under one storage-key Web Lock across owners and tabs. Persistent browser sequence writes require Web Locks; callers without it must supply a transactional sequence adapter. Ordinary accepted-sequence writes retain best-effort semantics. Non-replicating session hydration performs local canonical verification without routing I/O; later live operations still refresh routing. Verified wallet-owner background prefetch starts at the live routing boundary independently of the requested resource owner, while real held-grant activation derives additional owners from verified signed permissions. Explicitly enabled replication retains preflight.

Changed behavior: warm fallback requires a canonically verified cached entry strictly younger than one hour and a transport error, timeout or HTTP 502/503/504. HTTP 500 and every other status refuse warm fallback. Authoritative HTTP4xx and fresh signed results without the required route invalidate cached settings while preserving known-owner evidence. Custom adapters now require `getRevision`, `update` callbacks receiving the locked revision, and atomic `delete(ownerKey, expectedRevision?, maximumSequence?)` guard semantics; wrappers must forward these arguments. Cold unknown-owner HTTP5xx, transport errors and timeouts retain configured/default-host compatibility. Actual route selection invokes `onRegistryFallback(reason, code?)` with `using_default_node` or `using_cached_settings`, or logs the corresponding value-free SDK warning; background lookups alone do not warn. Node-side registry admission is unchanged.

Single-host worker contexts no longer import unused resource-routing construction or transport-error constructors. Structured routing errors retain their stable codes, dependency messages, causes and partial-write/host metadata, including existing HTTP status and reason fields so authoritative refusals never become network fallbacks.

Equal-sequence refreshes renew fetch time only when the verified canonical signed payload is unchanged. Conflicting equal-sequence payloads refuse and invalidate cached routing while retaining known-owner sequence history; unchanged payloads preserve exact cached response bytes even when response formatting differs.

Durable per-owner invalidation revisions fence older in-flight results across adapter instances and reloads. Deletion atomically stores a metadata-only tombstone in the same cache value/file, advances even when empty, and never changes signed sequence history. Positive revisions retain known-owner evidence without a sequence adapter. Revision or signed-sequence guard mismatches refuse without deleting newer state; updates cannot reset the counter. Existing live entries without revision remain valid revision zero.

Metadata-only tombstones require a positive invalidation revision; revision-zero tombstones refuse as corrupt state. Legacy live entries without revision remain valid revision zero.

Current-runtime invalidation attempts retain their local fence across overlapping lookups independently of persisted revision writes. Only a successful online lookup started after the latest attempt may recover that local state.

Preserve covered offline replica reads when the data node is unreachable, while registry and identity refusals remain fail-closed.

Details: TC-2481
