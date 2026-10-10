---
"@tinycloud/sdk-services": minor
---

Move replication controller and memory pending-store factories out of the platform-agnostic root export. They remain available from `@tinycloud/sdk-services/kv/replication` for Node-only runtime integration, preventing Web SDK consumers from bundling the Node replication controller.

Replication authority can now mark compact delegate sessions as session-only so a refusing session grant cannot fall back to installed device grants; an installed grant also cannot widen a refusal by the current session. KV operations avoid readiness awaits when no read-through is configured.
