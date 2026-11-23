---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": minor
---

`tc auth login --keys <full-app-key> --app-key --owner <did>` asks the owner to approve one exact app key, for example `apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1`. The approval lets the profile create that key and decrypt with it on the owner's default encryption network, nothing else. It lasts up to 7 days (1 hour unless `--expiry` says otherwise) and the owner can shorten it but not lengthen it. Use a profile that has no other sign-in. The approval is saved in that profile and checked on every use.

`tc keys encrypt <full-app-key> --record-key <full-record-key>` encrypts one JSON value for one record and prints the envelope. `tc keys decrypt --record-key <full-record-key>` opens an envelope only for the owner, space and record key it was encrypted for. Both refuse any other key, record key, host or expired approval before contacting the node. A folder under `apps/` stays unavailable to `--keys` without `--app-key`.

This works only when the owner's OpenKey supports app-key approvals; a build or deployment without that support refuses the request. `@tinycloud/node-sdk` adds `prepareExactAppKeyRequest`, `verifyExactAppKeyProof`, `buildExactAppKeyProof` and `openExactAppKeyClient`; ordinary session restore does not accept this approval.

Details: TC-4035
