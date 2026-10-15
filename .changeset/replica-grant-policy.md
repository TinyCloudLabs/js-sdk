---
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

Replication: enforce independently verified finite-expiration owner SIWE anchors, bounded device-grant minting, and session-parent-only silent renewal. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry. Grant transitions use opaque replica IDs. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).
