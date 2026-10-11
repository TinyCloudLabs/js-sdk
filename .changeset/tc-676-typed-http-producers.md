---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/server": patch
---

Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 403. Location resolutions with multiple independent failures remain unclassified.

Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words.

An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.
