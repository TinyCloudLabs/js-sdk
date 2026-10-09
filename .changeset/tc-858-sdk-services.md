---
"@tinycloud/sdk-services": minor
---

Move replication controller and memory pending-store factories out of the platform-agnostic root export. They remain available from `@tinycloud/sdk-services/kv/replication` for Node-only runtime integration, preventing Web SDK consumers from bundling the Node replication controller.
