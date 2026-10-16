---
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
---

Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
