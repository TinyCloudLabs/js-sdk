---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Replication: enforce independently verified finite-expiration owner SIWE anchors with exact-space uncaveated root KV get+sync coverage, bounded device-grant minting, and session-parent-only silent renewal. A `first_install` timestamp bounds expiry only; it cannot authorize minting. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry while their current independently verified session still covers the requested prefix. A missing owner-backed compact proof fails closed, and session refusal never exposes installed local bytes or keys. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The root web bundle remains inert with replication off; `@tinycloud/web-sdk/replica` exports a pure optional plugin and async IndexedDB factory loader. Applications register that plugin once with root `registerBrowserReplica` before constructing an enabled client, so test fixtures can inject a scheduler into the same root-owned runtime registry without a public clock option.

Browser sign-in selects the connected wallet's persisted session. Explicit restore retains valid network authority for a different or unknown wallet, but refuses replica stamp admission; local reads recheck the provider account before returning cached bytes or keys.

The runtime binds pending writes to the supplied lifecycle stamp and creates a fresh pending store when the stamp changes; gated storage cannot fall back to volatile pending memory. Replica opens carry the configured quota alongside the stamped grant policy. When a shorter grant policy expires before the immutable seven-day gate, get/list use the network and report `GRANT_EXPIRED`; only gate expiry causes `CONSENT_EXPIRED` and scoped denial.
