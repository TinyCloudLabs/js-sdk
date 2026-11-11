---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
---

Prioritize interactive SDK requests over background replica traffic. Serialize replica requests per host, give foreground activity a 400 ms quiet window, and bound foreground node-busy retries.

Details: TC-2771
