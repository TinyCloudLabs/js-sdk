---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Replication: enforce independently verified finite-expiration owner SIWE anchors, bounded device-grant minting, and session-parent-only silent renewal. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The web entry re-exports the existing node replication loader registry, so test fixtures can inject a scheduler into the same bundled runtime instance without a public clock option.
