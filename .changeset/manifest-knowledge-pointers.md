---
"@tinycloud/sdk-core": patch
"@tinycloud/cli": patch
---

Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
