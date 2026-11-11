---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
---

Prioritize interactive SDK requests over background replica traffic. Serialize replica requests per host, give foreground activity a 400 ms quiet window, and bound foreground node-busy retries.

Cancel pending operations when the session changes and coordinate lanes at the resolved physical destination. Bind KV readiness, retries, SQL migrations and named-key operations to their starting identity, retain the initial Secrets vault across pages, and release discarded SDK response bodies.

Load request coordination and retry handling on first use. Preserve the default server retry policy and the browser foreground busy limit.

Details: TC-2771
