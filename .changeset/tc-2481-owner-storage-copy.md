---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
"@tinycloud/sdk-core": patch
---

Use storage-server and storage-settings vocabulary in owner-facing routing errors and offline inspection help. Keep existing error codes, retryability, command behavior, account-identifier parsing and JSON schemas. Display the optional inspection argument as `account-id` and label the human output with account, version, age and decryption service.

The separate cold-device refusal change remains a required dependency before stable release; wording does not itself change routing behavior.

Details: TC-2481
