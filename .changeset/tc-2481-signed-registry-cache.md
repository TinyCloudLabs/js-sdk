---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
"@tinycloud/sdk-services": patch
---
Persist exact owner-signed v2 registry responses with separate fetch metadata, verify every cached read, and replace signed bytes only with strictly higher sequences. Every owner routing decision awaits a bounded refresh; overlapping requests coalesce, while subsequent decisions refresh again. Successful equal-sequence checks may renew fetch time without replacing signed bytes. Node and browser SDKs accept matching cache adapters; browser updates and deletion serialize across tabs.

The CLI and canonical Operations runtime share an owner-only, readable profile cache and atomic profile-store updates. Add read-only `tc registry show [did]` for owner, sequence, fetch age, full space placement, modes, hostnames and encryption destination, without sign-in, grant activation or network access.

Verified restored entries establish independent sequence history before direct refresh. Each caller enforces its own captured and current sequence history when joining an in-flight refresh, including registered results shared through a cache with independent sequence adapters. Profile registry transactions serialize within an already-held profile lock, and browser sequence maxima merge under one storage-key Web Lock across owners and tabs. Persistent browser sequence writes require Web Locks; callers without it must supply a transactional sequence adapter. Ordinary accepted-sequence writes retain best-effort semantics. Non-replicating session hydration performs local canonical verification without routing I/O; later live operations still refresh routing. Explicitly enabled replication retains preflight.

Changed behavior: warm fallback requires a canonically verified cached entry strictly younger than one hour and a transport error, timeout or HTTP 502/503/504. HTTP 500 and every other status refuse warm fallback. Authoritative HTTP4xx and fresh signed results without the required route delete cached settings while preserving known-owner evidence. Custom cache adapters must now implement serialized `delete(ownerKey): Promise<void>`. Cold unknown-owner HTTP5xx, transport errors and timeouts retain configured/default-host compatibility. Actual route selection invokes `onRegistryFallback(reason, code?)` with `using_default_node` or `using_cached_settings`, or logs the corresponding value-free SDK warning; background lookups alone do not warn. Node-side registry admission is unchanged.

Single-host worker contexts no longer import optional resource-routing machinery.

Details: TC-2481
