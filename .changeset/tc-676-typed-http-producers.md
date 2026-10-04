---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/server": patch
---

Preserve typed HTTP authorization verdicts through location, manifest, version, hooks, and account-registry failures. Classify hook timeouts from HTTP status instead of response text, retain message fallback only for genuinely untyped retry errors, and ignore single-quoted names while parsing untyped session errors. Hook HTTP error messages containing `timeout` now keep the server's diagnostic text rather than being replaced by `Request timed out.`; 408 and 504 responses report `TIMEOUT` even when their bodies do not mention timeout.

Account-registry sync now surfaces an account-index initialization failure for its verdict-aware retry instead of silently continuing past the failed result. A location-resolution aggregate with exactly one failed source now preserves that error as its cause; aggregates with multiple independent failures remain unclassified.
