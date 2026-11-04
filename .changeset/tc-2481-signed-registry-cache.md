---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
---
Persist exact owner-signed v2 registry responses with separate fetch metadata, verify every cached read, and accept only strictly higher sequences. Warm routing starts from verified cached placement while bounded background refresh discovers newer entries for authenticated owners and verified held-delegation resource owners. Node and browser SDKs accept matching cache adapters; browser updates serialize across tabs.

The CLI and canonical Operations runtime share an owner-only, readable profile cache and atomic profile-store updates. Add read-only `tc registry show [did]` for owner, sequence, fetch age, full space placement, modes, hostnames and encryption destination, without sign-in, grant activation or network access.

Verified restored entries establish independent sequence history before direct refresh. Each caller enforces its own captured and current sequence history when joining an in-flight refresh, including registered results shared through a cache with independent sequence adapters. Profile registry transactions serialize within an already-held profile lock, and browser sequence maxima merge under one storage-key Web Lock across owners and tabs. Persistent browser sequence writes now require Web Locks; callers without it must supply a transactional sequence adapter. The resolver's existing best-effort handling of sequence-write failures is unchanged.

Changed behavior: cold client HTTP5xx, transport errors and timeouts without cached or remembered registration retain configured/default-host compatibility. Actual fallback logs the SDK reason `registry unavailable; using the default node` (or calls `onRegistryFallback`) and the CLI emits one value-free stderr warning without contaminating raw stdout. Background lookups do not warn before selecting a fallback route. HTTP4xx refusals, corrupt cache, invalid registry responses, v1-only registrations and remembered registration evidence remain refusals; cached entries never permit unlisted-host fallback. Node-side registry admission is unchanged.

Details: TC-2481
