---
"@tinycloud/sdk-services": minor
---

`migrateSecrets` with `authorizeKeys` asks only for the keys of secrets that still have to move. It first checks each secret with a read-only dry run, so secrets already on their own key and secrets that cannot be read are left out of the request. A rerun after a stopped move asks only for the rest. A new `previewKeys` option reports, on a dry run, the keys an approval would name.

Details: TC-4248
