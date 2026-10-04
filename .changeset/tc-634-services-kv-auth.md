---
"@tinycloud/sdk-services": minor
---

KV `list`, `delete`, and `head` now return `AUTH_UNAUTHORIZED` with HTTP status and validated missing-capability metadata for both 401 and 403, rather than `NETWORK_ERROR` on 403. Parsed capability metadata is retained only when the TinyCloud resource and action match the request. Export `validatedCapabilityOf` for clients classifying an authorization refusal without trusting server-supplied resource or action strings.
